import { IDBFactory as FakeIdbFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import { AppError, type ErrorCode } from '@/lib/errors';
import { payloadHash } from '@/lib/payloadHash';
import {
  ackOf,
  closePayload,
  createClock,
  createRandom,
  createTransport,
  isoAt,
  meta,
  openPayload,
  raise,
  salePayload,
  SESSION_ID,
  START,
  storedSale,
  uuid,
  type Answer,
  type FakeClock,
  type TrackedTransport,
} from './__tests__/fixtures';
import { createIdbOutboxStorage, openOutboxDatabase } from './idbStorage';
import { createInProcessDrainLock } from './locks';
import { createMemoryOutboxStorage } from './memoryStorage';
import { backoffDelay, createOutbox, type Outbox } from './outbox';
import type { DrainLock, DrainOutcome, OutboxRecord, OutboxStorage } from './types';

// Black-box tests of the outbox: append, drain, retry and void, with the clock, the randomness, the
// transport and the cross-tab lock all injected, so every wait and every jitter here is exact and no
// test waits on a real timer. The register's own builders write the payloads, so nothing is queued
// that a port would refuse.

interface Harness {
  readonly outbox: Outbox;
  readonly storage: OutboxStorage;
  readonly clock: FakeClock;
  readonly transport: TrackedTransport;
}

interface Options {
  readonly storage?: OutboxStorage;
  readonly clock?: FakeClock;
  readonly lock?: DrainLock;
  readonly random?: () => number;
  readonly canSend?: () => boolean;
  /** False when the storage already holds a registration, or to test an unregistered device. */
  readonly registered?: boolean;
}

/** An outbox on terminal T1 with an empty queue, answering every send with `answer`. */
async function setup(answer?: Answer, options: Options = {}): Promise<Harness> {
  const storage = options.storage ?? createMemoryOutboxStorage();
  if (options.registered !== false) {
    await storage.writeMeta(meta());
  }
  const clock = options.clock ?? createClock();
  const transport = createTransport(answer);
  const outbox = createOutbox({
    storage,
    transport,
    clock,
    random: options.random ?? createRandom(),
    lock: options.lock ?? createInProcessDrainLock(),
    canSend: options.canSend ?? (() => true),
  });
  return { outbox, storage, clock, transport };
}

/** Sale number `n` of this device, written as the register writes it. */
function sell(harness: Harness, n: number): Promise<OutboxRecord> {
  return harness.outbox.appendSale('sale', ({ seq, meta: registration }) =>
    salePayload(registration, seq, uuid(n), isoAt(harness.clock.now())),
  );
}

async function sellMany(harness: Harness, count: number): Promise<void> {
  for (let n = 1; n <= count; n += 1) {
    await sell(harness, n);
  }
}

async function statusesOf(harness: Harness): Promise<string[]> {
  return (await harness.outbox.list()).map((record) => record.status);
}

async function recordAt(harness: Harness, ordinal: number): Promise<OutboxRecord> {
  const records = await harness.outbox.list();
  return (
    records.find((record) => record.ordinal === ordinal) ??
    expect.unreachable(`no record with ordinal ${ordinal}`)
  );
}

function retryAtOf(outcome: DrainOutcome): number {
  if (outcome.state !== 'waiting') {
    return expect.unreachable(`expected the queue to be waiting, got ${outcome.state}`);
  }
  return outcome.retryAt;
}

async function expectFailure(promise: Promise<unknown>, code: ErrorCode): Promise<void> {
  await expect(promise).rejects.toBeInstanceOf(AppError);
  await expect(promise).rejects.toHaveProperty('code', code);
}

/** `base`, with `interfere` running inside every append, between its read and its commit. */
function interferingStorage(base: OutboxStorage, interfere: () => Promise<void>): OutboxStorage {
  return {
    readMeta: () => base.readMeta(),
    writeMeta: (registration) => base.writeMeta(registration),
    async appendIfUnchanged(expected, record, next) {
      await interfere();
      return base.appendIfUnchanged(expected, record, next);
    },
    get: (id) => base.get(id),
    list: () => base.list(),
    firstUnfinished: () => base.firstUnfinished(),
    update: (id, patch) => base.update(id, patch),
    resetSending: () => base.resetSending(),
  };
}

describe('backoffDelay', () => {
  it('doubles from half a second and stops at a minute', () => {
    const delays = [0, 1, 2, 3, 4, 5, 6, 7, 8, 20].map((attempts) =>
      backoffDelay(attempts, createRandom()),
    );

    expect(delays).toEqual([
      500, 1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000, 60_000,
    ]);
  });

  it('adds a jitter of up to 249 ms, which never pushes the wait past a minute', () => {
    const almostOne = () => createRandom([0.999]);

    expect(backoffDelay(0, almostOne())).toBe(749);
    expect(backoffDelay(5, almostOne())).toBe(16_249);
    expect(backoffDelay(6, almostOne())).toBe(32_249);
    expect(backoffDelay(7, almostOne())).toBe(60_000);
    expect(backoffDelay(2, createRandom([0.5]))).toBe(2_125);
  });

  it('takes an attempt count outside the schedule as the nearest one in it', () => {
    expect(backoffDelay(-3, createRandom())).toBe(500);
    expect(backoffDelay(1_000, createRandom())).toBe(60_000);
  });
});

describe('append', () => {
  it('numbers sales and refunds only, and orders every kind by one ordinal', async () => {
    const harness = await setup();

    const opened = await harness.outbox.appendSessionOpen(({ meta: registration }) =>
      openPayload(registration, isoAt(START)),
    );
    const first = await sell(harness, 1);
    const second = await sell(harness, 2);
    const closed = await harness.outbox.appendSessionClose(({ meta: registration }) =>
      closePayload(registration, isoAt(START)),
    );

    const queued = [opened, first, second, closed];
    expect(queued.map((record) => [record.kind, record.ordinal, record.seq])).toEqual([
      ['session_open', 1, null],
      ['sale', 2, 1],
      ['sale', 3, 2],
      ['session_close', 4, null],
    ]);
    expect(queued.map((record) => record.sessionId)).toEqual([
      SESSION_ID,
      SESSION_ID,
      SESSION_ID,
      SESSION_ID,
    ]);
    await expect(harness.storage.readMeta()).resolves.toMatchObject({
      lastSeq: 2,
      nextOrdinal: 5,
    });
  });

  it('queues a sale before anything is sent, ready to go out at once', async () => {
    const harness = await setup();

    const record = await sell(harness, 1);

    expect(harness.transport.sent).toEqual([]);
    expect(record).toMatchObject({
      terminalCode: 'T1',
      createdAt: START,
      nextAttemptAt: START,
      attempts: 0,
      status: 'pending',
      lastError: null,
      result: null,
      ackedAt: null,
    });
    expect(record.payloadHash).toBe(record.payload.payloadHash);
    await expect(harness.outbox.list()).resolves.toEqual([record]);
  });

  it('refuses to queue anything while the device is not registered', async () => {
    const harness = await setup(undefined, { registered: false });

    await expectFailure(sell(harness, 1), 'CONFIG_ERROR');

    await expect(harness.outbox.list()).resolves.toEqual([]);
  });

  it('takes fresh numbers when another context allocated first, with no gap and no duplicate', async () => {
    const base = createMemoryOutboxStorage();
    const registration = meta();
    await base.writeMeta(registration);
    let interfered = false;
    const storage = interferingStorage(base, async () => {
      if (interfered) {
        return;
      }
      interfered = true;
      // Another context commits sale number 1 between our read of the counters and our own commit.
      const current = await base.readMeta();
      if (!current) {
        return expect.unreachable('the storage holds no registration');
      }
      await base.appendIfUnchanged(
        { lastSeq: current.lastSeq, nextOrdinal: current.nextOrdinal },
        await storedSale(registration, current.nextOrdinal, current.lastSeq + 1),
        { ...current, lastSeq: current.lastSeq + 1, nextOrdinal: current.nextOrdinal + 1 },
      );
    });
    const harness = await setup(undefined, { storage });

    const record = await sell(harness, 1);

    expect(record).toMatchObject({ ordinal: 2, seq: 2 });
    // The payload was built again with the number it ended up with, so its hash still covers it.
    expect(record.payload).toMatchObject({ seq: 2 });
    expect(await payloadHash(record.payload)).toBe(record.payloadHash);
    const queued = await harness.outbox.list();
    expect(queued.map((each) => [each.ordinal, each.seq])).toEqual([
      [1, 1],
      [2, 2],
    ]);
    expect(new Set(queued.map((each) => each.id)).size).toBe(2);
    await expect(storage.readMeta()).resolves.toMatchObject({ lastSeq: 2, nextOrdinal: 3 });
  });

  it('gives up rather than guess when it is outrun over and over', async () => {
    const base = createMemoryOutboxStorage();
    const registration = meta();
    await base.writeMeta(registration);
    const storage = interferingStorage(base, async () => {
      const current = await base.readMeta();
      if (!current) {
        return expect.unreachable('the storage holds no registration');
      }
      await base.appendIfUnchanged(
        { lastSeq: current.lastSeq, nextOrdinal: current.nextOrdinal },
        await storedSale(registration, current.nextOrdinal, current.lastSeq + 1),
        { ...current, lastSeq: current.lastSeq + 1, nextOrdinal: current.nextOrdinal + 1 },
      );
    });
    const harness = await setup(undefined, { storage });

    await expectFailure(sell(harness, 1), 'UNKNOWN');

    const queued = await harness.outbox.list();
    expect(queued.map((each) => each.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(queued.some((each) => each.id === uuid(1))).toBe(false);
  });
});

describe('drain', () => {
  it('pauses, and sends nothing, while the device is not registered', async () => {
    const harness = await setup(undefined, { registered: false });

    await expect(harness.outbox.drain()).resolves.toEqual({
      state: 'paused',
      reason: 'unregistered',
    });

    expect(harness.transport.sent).toEqual([]);
  });

  it('drains under the name of the terminal it is registered for', async () => {
    const names: string[] = [];
    const lock: DrainLock = {
      runExclusive: <T>(name: string, pass: () => Promise<T>): Promise<T | 'busy'> => {
        names.push(name);
        return pass();
      },
    };
    const harness = await setup(undefined, { lock });
    await sell(harness, 1);

    await expect(harness.outbox.drain()).resolves.toEqual({ state: 'idle' });

    // Not `terminal:T1`, which the POS page holds for as long as it is mounted.
    expect(names).toEqual(['outbox:T1']);
  });

  it('skips the pass while another tab is draining this terminal', async () => {
    const lock: DrainLock = { runExclusive: () => Promise.resolve('busy' as const) };
    const harness = await setup(undefined, { lock });
    await sell(harness, 1);

    await expect(harness.outbox.drain()).resolves.toEqual({ state: 'busy' });

    expect(harness.transport.sent).toEqual([]);
    await expect(recordAt(harness, 1)).resolves.toMatchObject({ status: 'pending', attempts: 0 });
  });

  it('sends a burst of fifty sales in order, one request at a time', async () => {
    const harness = await setup(async (record) => {
      await Promise.resolve();
      return ackOf(record);
    });
    await sellMany(harness, 50);

    await expect(harness.outbox.drain()).resolves.toEqual({ state: 'idle' });

    expect(harness.transport.seqs()).toEqual(Array.from({ length: 50 }, (_, index) => index + 1));
    expect(harness.transport.peakInFlight()).toBe(1);
    const queued = await harness.outbox.list();
    expect(queued.map((record) => record.status)).toEqual(
      Array.from({ length: 50 }, () => 'acked'),
    );
    expect(queued[49].result).toEqual({ status: 'created', receiptNumber: 'T1-50' });
    await expect(harness.outbox.summary()).resolves.toEqual({
      pending: 0,
      conflicts: 0,
      lastAckAt: START,
    });
  });

  it('holds the records behind a failing head until it acks, keeping their order', async () => {
    let failures = 2;
    const harness = await setup((record) => {
      if (record.seq === 1 && failures > 0) {
        failures -= 1;
        raise('NETWORK_ERROR');
      }
      return ackOf(record);
    });
    await sellMany(harness, 3);

    expect(retryAtOf(await harness.outbox.drain())).toBe(START + 1_000);
    expect(harness.transport.seqs()).toEqual([1]);
    await expect(statusesOf(harness)).resolves.toEqual(['pending', 'pending', 'pending']);

    // Asked again before the retry is due, it sends nothing at all — not even the records behind.
    expect(retryAtOf(await harness.outbox.drain())).toBe(START + 1_000);
    expect(harness.transport.seqs()).toEqual([1]);

    harness.clock.advance(1_000);
    expect(retryAtOf(await harness.outbox.drain())).toBe(START + 3_000);
    expect(harness.transport.seqs()).toEqual([1, 1]);

    harness.clock.advance(2_000);
    await expect(harness.outbox.drain()).resolves.toEqual({ state: 'idle' });

    expect(harness.transport.seqs()).toEqual([1, 1, 1, 2, 3]);
    await expect(statusesOf(harness)).resolves.toEqual(['acked', 'acked', 'acked']);
  });

  it('keeps retrying a retriable failure, with the wait capped at a minute', async () => {
    const harness = await setup(() => raise('SERVER_ERROR'));
    await sell(harness, 1);
    const waits: number[] = [];

    for (let attempt = 1; attempt <= 30; attempt += 1) {
      const retryAt = retryAtOf(await harness.outbox.drain());
      waits.push(retryAt - harness.clock.now());
      harness.clock.advance(retryAt - harness.clock.now());
    }

    expect(waits.slice(0, 8)).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000]);
    expect(new Set(waits.slice(6))).toEqual(new Set([60_000]));
    expect(harness.transport.sent).toHaveLength(30);
    await expect(recordAt(harness, 1)).resolves.toMatchObject({
      status: 'pending',
      attempts: 30,
      lastError: { code: 'SERVER_ERROR' },
    });
  });

  it('takes a replayed answer as an ack, and never sends an acked record again', async () => {
    const harness = await setup((record) => ackOf(record, 'replayed'));
    await sell(harness, 1);

    await expect(harness.outbox.drain()).resolves.toEqual({ state: 'idle' });

    const acked = await recordAt(harness, 1);
    expect(acked).toMatchObject({
      status: 'acked',
      ackedAt: START,
      lastError: null,
      result: { status: 'replayed', receiptNumber: 'T1-1' },
    });

    harness.clock.advance(30_000);
    await expect(harness.outbox.drain()).resolves.toEqual({ state: 'idle' });

    expect(harness.transport.sent).toHaveLength(1);
    await expect(recordAt(harness, 1)).resolves.toEqual(acked);
  });

  it('stops at a conflict, leaves the records behind it pending, and resumes when retried', async () => {
    let gap = true;
    const harness = await setup((record) => {
      if (record.seq === 1 && gap) {
        raise('SEQUENCE_GAP');
      }
      return ackOf(record);
    });
    await sellMany(harness, 3);
    const head = await recordAt(harness, 1);

    await expect(harness.outbox.drain()).resolves.toEqual({ state: 'blocked', recordId: head.id });

    await expect(statusesOf(harness)).resolves.toEqual(['conflict', 'pending', 'pending']);
    await expect(recordAt(harness, 1)).resolves.toMatchObject({
      attempts: 0,
      lastError: { code: 'SEQUENCE_GAP' },
    });
    await expect(harness.outbox.summary()).resolves.toEqual({
      pending: 2,
      conflicts: 1,
      lastAckAt: null,
    });

    // However long it waits, a conflict is not something time fixes.
    harness.clock.advance(60_000);
    await expect(harness.outbox.drain()).resolves.toEqual({ state: 'blocked', recordId: head.id });
    expect(harness.transport.seqs()).toEqual([1]);

    gap = false;
    await harness.outbox.retry(head.id);
    await expect(recordAt(harness, 1)).resolves.toMatchObject({
      status: 'pending',
      attempts: 0,
      nextAttemptAt: START + 60_000,
    });

    await expect(harness.outbox.drain()).resolves.toEqual({ state: 'idle' });
    expect(harness.transport.seqs()).toEqual([1, 1, 2, 3]);
  });

  it('pauses on a lapsed session without counting an attempt against the record', async () => {
    let signedIn = false;
    const harness = await setup((record) => {
      if (!signedIn) {
        raise('UNAUTHENTICATED');
      }
      return ackOf(record);
    });
    await sellMany(harness, 2);

    await expect(harness.outbox.drain()).resolves.toEqual({ state: 'paused', reason: 'auth' });

    expect(harness.transport.seqs()).toEqual([1]);
    await expect(recordAt(harness, 1)).resolves.toMatchObject({
      status: 'pending',
      attempts: 0,
      nextAttemptAt: START,
      lastError: { code: 'UNAUTHENTICATED' },
    });

    // Signed in again, the queue goes on at once: there is no backoff to wait out.
    signedIn = true;
    await expect(harness.outbox.drain()).resolves.toEqual({ state: 'idle' });

    expect(harness.transport.seqs()).toEqual([1, 1, 2]);
  });

  it('sends nothing while there is no session to send under', async () => {
    let signedIn = false;
    const harness = await setup(undefined, { canSend: () => signedIn });
    await sell(harness, 1);

    await expect(harness.outbox.drain()).resolves.toEqual({ state: 'paused', reason: 'auth' });

    expect(harness.transport.sent).toEqual([]);
    await expect(recordAt(harness, 1)).resolves.toMatchObject({
      status: 'pending',
      attempts: 0,
      lastError: null,
    });

    signedIn = true;
    await expect(harness.outbox.drain()).resolves.toEqual({ state: 'idle' });

    expect(harness.transport.sent).toHaveLength(1);
  });

  it('ends a record the server says was voided as voided, and carries on', async () => {
    const harness = await setup((record) => ackOf(record, record.seq === 1 ? 'voided' : 'created'));
    await sellMany(harness, 2);

    await expect(harness.outbox.drain()).resolves.toEqual({ state: 'idle' });

    await expect(recordAt(harness, 1)).resolves.toMatchObject({
      status: 'voided',
      ackedAt: START,
      result: { status: 'voided' },
    });
    await expect(recordAt(harness, 2)).resolves.toMatchObject({ status: 'acked' });
    await expect(harness.outbox.summary()).resolves.toEqual({
      pending: 0,
      conflicts: 0,
      lastAckAt: START,
    });
  });

  it('runs one pass at a time in a tab, whoever asks for it', async () => {
    const harness = await setup(async (record) => {
      await Promise.resolve();
      return ackOf(record);
    });
    await sellMany(harness, 3);

    const [first, second] = await Promise.all([harness.outbox.drain(), harness.outbox.drain()]);

    expect(first).toEqual({ state: 'idle' });
    expect(second).toEqual(first);
    expect(harness.transport.seqs()).toEqual([1, 2, 3]);
  });

  it('picks up where the last run stopped, including a record it left sending', async () => {
    const factory = new FakeIdbFactory();
    const db = await openOutboxDatabase(factory);
    const clock = createClock();
    let offline = true;
    const before = await setup(
      (record) => {
        if (offline && record.seq !== 1) {
          raise('NETWORK_ERROR');
        }
        return ackOf(record);
      },
      { storage: createIdbOutboxStorage(db), clock },
    );
    await sellMany(before, 3);
    await before.outbox.drain();
    // The tab died inside the next send, leaving the record marked sending.
    const interrupted = await recordAt(before, 2);
    await before.storage.update(interrupted.id, { status: 'sending' });
    expect(await statusesOf(before)).toEqual(['acked', 'sending', 'pending']);
    db.close();

    offline = false;
    clock.advance(60_000);
    const reopened = await openOutboxDatabase(factory);
    const after = await setup(undefined, {
      storage: createIdbOutboxStorage(reopened),
      clock,
      registered: false,
    });

    await expect(after.outbox.drain()).resolves.toEqual({ state: 'idle' });

    expect(after.transport.seqs()).toEqual([2, 3]);
    await expect(statusesOf(after)).resolves.toEqual(['acked', 'acked', 'acked']);
    // And it goes on numbering where the run before stopped.
    await expect(sell(after, 4)).resolves.toMatchObject({ ordinal: 4, seq: 4 });
    reopened.close();
  });

  it('sends each record exactly once when two tabs share one database and one lock', async () => {
    const factory = new FakeIdbFactory();
    const [first, second] = [await openOutboxDatabase(factory), await openOutboxDatabase(factory)];
    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const transport = createTransport(async (record) => {
      if (record.seq === 1) {
        // Whichever tab took the lock stays inside this send until the test lets it go.
        await held;
      }
      return ackOf(record);
    });
    const storage = createIdbOutboxStorage(first);
    await storage.writeMeta(meta());
    const shared = {
      transport,
      clock: createClock(),
      random: createRandom(),
      lock: createInProcessDrainLock(),
      canSend: () => true,
    };
    const one = createOutbox({ ...shared, storage });
    const two = createOutbox({ ...shared, storage: createIdbOutboxStorage(second) });
    for (let n = 1; n <= 5; n += 1) {
      await one.appendSale('sale', ({ seq, meta: registration }) =>
        salePayload(registration, seq, uuid(n)),
      );
    }

    const passes = [one.drain(), two.drain()];
    await expect(Promise.race(passes)).resolves.toEqual({ state: 'busy' });
    release();
    const outcomes = await Promise.all(passes);

    expect(outcomes).toContainEqual({ state: 'busy' });
    expect(outcomes).toContainEqual({ state: 'idle' });
    expect(transport.seqs()).toEqual([1, 2, 3, 4, 5]);
    const queued = await storage.list();
    expect(queued.map((record) => record.status)).toEqual(Array.from({ length: 5 }, () => 'acked'));
    first.close();
    second.close();
  });
});

describe('wakeNow', () => {
  it('brings a waiting retry forward, so a reconnect does not sit out the backoff', async () => {
    const harness = await setup(() => raise('NETWORK_ERROR'));
    await sell(harness, 1);

    expect(retryAtOf(await harness.outbox.drain())).toBeGreaterThan(harness.clock.now());
    // Until something changes the wait is honoured: the record is not tried again.
    await harness.outbox.drain();
    expect((await recordAt(harness, 1)).attempts).toBe(1);

    await harness.outbox.wakeNow();

    expect((await recordAt(harness, 1)).nextAttemptAt).toBe(harness.clock.now());
    await harness.outbox.drain();
    expect((await recordAt(harness, 1)).attempts).toBe(2);
  });

  it('leaves a record that is not waiting exactly as it is', async () => {
    const harness = await setup(() => raise('SEQUENCE_GAP'));
    await sell(harness, 1);
    await harness.outbox.drain();
    const blocked = await recordAt(harness, 1);
    expect(blocked.status).toBe('conflict');

    await harness.outbox.wakeNow();

    expect(await recordAt(harness, 1)).toEqual(blocked);
  });
});

describe('retry and resolveVoid', () => {
  /** An outbox whose first sale is in conflict and whose second is waiting behind it. */
  async function withConflict(): Promise<Harness> {
    const harness = await setup((record) => {
      if (record.seq === 1) {
        raise('VALIDATION_ERROR');
      }
      return ackOf(record);
    });
    await sellMany(harness, 2);
    await harness.outbox.drain();
    await expect(statusesOf(harness)).resolves.toEqual(['conflict', 'pending']);
    return harness;
  }

  it.each([
    ['voided', 'voided'],
    ['recorded', 'acked'],
    ['replayed', 'acked'],
  ] as const)('stores a %s answer to a void as %s', async (answer, status) => {
    const harness = await withConflict();
    const head = await recordAt(harness, 1);

    await harness.outbox.resolveVoid(head.id, { status: answer, receiptNumber: 'T1-1' });

    await expect(recordAt(harness, 1)).resolves.toMatchObject({
      status,
      ackedAt: START,
      result: { status: answer, receiptNumber: 'T1-1' },
    });
  });

  it('lets the queue go on once the record in front of it was voided', async () => {
    const harness = await withConflict();
    const head = await recordAt(harness, 1);

    await harness.outbox.resolveVoid(head.id, { status: 'voided', receiptNumber: 'T1-1' });

    await expect(harness.outbox.drain()).resolves.toEqual({ state: 'idle' });
    expect(harness.transport.seqs()).toEqual([1, 2]);
    await expect(statusesOf(harness)).resolves.toEqual(['voided', 'acked']);
  });

  it('refuses to retry or void a record that nobody has to answer for', async () => {
    const harness = await setup();
    const record = await sell(harness, 1);

    await expectFailure(harness.outbox.retry(record.id), 'VALIDATION_ERROR');
    await expectFailure(
      harness.outbox.resolveVoid(record.id, { status: 'voided' }),
      'VALIDATION_ERROR',
    );
    await expectFailure(harness.outbox.retry('nothing-like-this'), 'VALIDATION_ERROR');
    await expect(statusesOf(harness)).resolves.toEqual(['pending']);
  });
});

describe('summary, list and subscribe', () => {
  it('counts what is waiting, what is in conflict, and when the last ack came in', async () => {
    const harness = await setup((record) => {
      if (record.seq === 2) {
        raise('SESSION_CLOSED');
      }
      return ackOf(record);
    });
    await sellMany(harness, 4);

    await expect(harness.outbox.summary()).resolves.toEqual({
      pending: 4,
      conflicts: 0,
      lastAckAt: null,
    });

    harness.clock.advance(5_000);
    await harness.outbox.drain();

    await expect(harness.outbox.summary()).resolves.toEqual({
      pending: 2,
      conflicts: 1,
      lastAckAt: START + 5_000,
    });
    await expect(harness.outbox.list()).resolves.toMatchObject([
      { ordinal: 1 },
      { ordinal: 2 },
      { ordinal: 3 },
      { ordinal: 4 },
    ]);
  });

  it('tells its subscribers that something changed, until they stop listening', async () => {
    const harness = await setup();
    let changes = 0;
    const stop = harness.outbox.subscribe(() => {
      changes += 1;
    });

    await sell(harness, 1);
    expect(changes).toBe(1);

    await harness.outbox.drain();
    expect(changes).toBe(2);

    stop();
    await sell(harness, 2);
    await harness.outbox.drain();
    expect(changes).toBe(2);
  });
});
