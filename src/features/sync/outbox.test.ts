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
  orderPayload,
  raise,
  registration as registrationOf,
  salePayload,
  SESSION_ID,
  START,
  storedSale,
  TABLE_ID,
  uuid,
  type Answer,
  type FakeClock,
  type TrackedTransport,
} from './__tests__/fixtures';
import { createIdbOutboxStorage, openOutboxDatabase } from './idbStorage';
import { createInProcessDrainLock } from './locks';
import { createMemoryOutboxStorage } from './memoryStorage';
import { backoffDelay, createOutbox, DRAIN_LOCK_NAME, type Outbox } from './outbox';
import { RETENTION_MS } from './retention';
import type {
  DrainLock,
  DrainOutcome,
  OrderKind,
  OutboxMeta,
  OutboxRecord,
  OutboxStorage,
} from './types';

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
  /** False for a device that is not a register — a waiter's phone — or one whose storage is filled. */
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

/** An order record of `kind` numbered `n`, written as a waiter's phone writes it. */
function order(harness: Harness, kind: OrderKind, n: number): Promise<OutboxRecord> {
  return harness.outbox.appendOrder(kind, () =>
    orderPayload(kind, uuid(5_000 + n), isoAt(harness.clock.now())),
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
    prune: (select) => base.prune(select),
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

/** Another context commits the next sale between an append's read of the queue and its commit. */
async function commitSaleElsewhere(storage: OutboxStorage): Promise<void> {
  const current = await storage.readMeta();
  if (!current?.terminal) {
    return expect.unreachable('the storage holds no registration');
  }
  const seq = current.terminal.lastSeq + 1;
  const next: OutboxMeta = {
    nextOrdinal: current.nextOrdinal + 1,
    terminal: { ...current.terminal, lastSeq: seq },
  };
  await storage.appendIfUnchanged(
    current,
    await storedSale(current.terminal, current.nextOrdinal, seq),
    next,
  );
}

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
    await expect(harness.storage.readMeta()).resolves.toEqual(
      meta({ nextOrdinal: 5, terminal: registrationOf({ lastSeq: 2 }) }),
    );
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
      discard: null,
    });
    expect(record.payloadHash).toBe(record.payload.payloadHash);
    await expect(harness.outbox.list()).resolves.toEqual([record]);
  });

  it('refuses to queue a sale on a device that is not a register', async () => {
    const harness = await setup(undefined, { registered: false });

    await expectFailure(sell(harness, 1), 'CONFIG_ERROR');

    await expect(harness.outbox.list()).resolves.toEqual([]);
    await expect(harness.storage.readMeta()).resolves.toBeNull();
  });

  // A waiter's phone is never registered: an item put on a table is still on the device before
  // anything is sent, with a place in the queue and nothing else — no terminal, no session, no number.
  it('queues an order record on a device that is not a register', async () => {
    const harness = await setup(undefined, { registered: false });

    const record = await order(harness, 'order_item_add', 1);

    expect(record).toMatchObject({
      id: uuid(5_001),
      kind: 'order_item_add',
      ordinal: 1,
      seq: null,
      terminalCode: null,
      sessionId: null,
      status: 'pending',
      discard: null,
    });
    expect(record.payloadHash).toBe(record.payload.payloadHash);
    expect(harness.transport.sent).toEqual([]);
    await expect(harness.storage.readMeta()).resolves.toEqual({ nextOrdinal: 2, terminal: null });
  });

  it('orders the sales of a register and its order records by the one ordinal', async () => {
    const harness = await setup();

    const added = await order(harness, 'order_item_add', 1);
    const sold = await sell(harness, 1);
    const sent = await order(harness, 'order_send', 2);

    expect([added, sold, sent].map((record) => [record.kind, record.ordinal, record.seq])).toEqual([
      ['order_item_add', 1, null],
      ['sale', 2, 1],
      ['order_send', 3, null],
    ]);
    // An order record takes no receipt number, so the next sale's number is the one after 1.
    await expect(harness.storage.readMeta()).resolves.toEqual(
      meta({ nextOrdinal: 4, terminal: registrationOf({ lastSeq: 1 }) }),
    );
  });

  it('takes fresh numbers when another context allocated first, with no gap and no duplicate', async () => {
    const base = createMemoryOutboxStorage();
    await base.writeMeta(meta());
    let interfered = false;
    const storage = interferingStorage(base, async () => {
      if (interfered) {
        return;
      }
      interfered = true;
      // Another context commits sale number 1 between our read of the counters and our own commit.
      await commitSaleElsewhere(base);
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
    await expect(storage.readMeta()).resolves.toEqual(
      meta({ nextOrdinal: 3, terminal: registrationOf({ lastSeq: 2 }) }),
    );
  });

  it('gives up rather than guess when it is outrun over and over', async () => {
    const base = createMemoryOutboxStorage();
    await base.writeMeta(meta());
    const storage = interferingStorage(base, () => commitSaleElsewhere(base));
    const harness = await setup(undefined, { storage });

    await expectFailure(sell(harness, 1), 'UNKNOWN');

    const queued = await harness.outbox.list();
    expect(queued.map((each) => each.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(queued.some((each) => each.id === uuid(1))).toBe(false);
  });
});

describe('drain', () => {
  it('sends the order records of a device that has never been registered', async () => {
    const harness = await setup(undefined, { registered: false });
    await order(harness, 'order_item_add', 1);
    await order(harness, 'order_send', 2);

    await expect(harness.outbox.drain()).resolves.toEqual({ state: 'idle' });

    expect(harness.transport.sent.map((record) => record.kind)).toEqual([
      'order_item_add',
      'order_send',
    ]);
    expect(await statusesOf(harness)).toEqual(['acked', 'acked']);
  });

  it('is idle, with nothing to send, on a device that has written nothing', async () => {
    const harness = await setup(undefined, { registered: false });

    await expect(harness.outbox.drain()).resolves.toEqual({ state: 'idle' });

    expect(harness.transport.sent).toEqual([]);
  });

  it('drains under one name for the whole device, register or not', async () => {
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

    // Not `terminal:T1`, which the caisse holds for as long as it is mounted, and not named after
    // the terminal at all: a phone has none, and a device has one queue whatever it is registered as.
    expect(names).toEqual([DRAIN_LOCK_NAME]);
    expect(DRAIN_LOCK_NAME).toBe('outbox');
  });

  it('skips the pass while another tab is draining this device', async () => {
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
      discarded: 0,
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
      discarded: 0,
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
      discarded: 0,
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
      discarded: 0,
      lastAckAt: null,
    });

    harness.clock.advance(5_000);
    await harness.outbox.drain();

    await expect(harness.outbox.summary()).resolves.toEqual({
      pending: 2,
      conflicts: 1,
      discarded: 0,
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

describe('prune', () => {
  it('deletes what the server has had for a week, keeps the last, and tells its subscribers', async () => {
    const harness = await setup(undefined, { registered: false });
    for (const n of [1, 2, 3]) {
      await order(harness, 'order_send', n);
    }
    await harness.outbox.drain();
    let changes = 0;
    harness.outbox.subscribe(() => {
      changes += 1;
    });

    harness.clock.advance(RETENTION_MS - 1);
    await expect(harness.outbox.prune()).resolves.toBe(0);
    expect(changes).toBe(0);

    harness.clock.advance(1);
    await expect(harness.outbox.prune()).resolves.toBe(2);
    expect(changes).toBe(1);
    // The last record the server took stays, so the device still knows when that was.
    await expect(harness.outbox.list()).resolves.toMatchObject([{ ordinal: 3 }]);
    await expect(harness.outbox.summary()).resolves.toMatchObject({ lastAckAt: START });
  });
});

describe('order records', () => {
  // Every code a table can answer with when it moved under a waiter's phone. Each one stops the
  // queue, because what comes after — a send, a removal — was written about the table as it was.
  it.each<ErrorCode>(['ORDER_CHANGED', 'ORDER_CLOSED', 'ITEM_NOT_FOUND', 'TABLE_INACTIVE'])(
    'stops the queue at an order record the server answers %s',
    async (code) => {
      const harness = await setup(
        (record) => (record.kind === 'order_item_remove' ? raise(code) : ackOf(record)),
        {
          registered: false,
        },
      );
      await order(harness, 'order_item_add', 1);
      const removal = await order(harness, 'order_item_remove', 2);
      await order(harness, 'order_send', 3);

      await expect(harness.outbox.drain()).resolves.toEqual({
        state: 'blocked',
        recordId: removal.id,
      });

      expect(await statusesOf(harness)).toEqual(['acked', 'conflict', 'pending']);
      await expect(recordAt(harness, 2)).resolves.toMatchObject({
        attempts: 0,
        lastError: { code },
      });
    },
  );

  it('sends an item added offline before the removal written after it, whatever the timing', async () => {
    const harness = await setup(undefined, { registered: false });
    const added = await order(harness, 'order_item_add', 1);
    harness.clock.advance(60_000);
    const removal = await harness.outbox.appendOrder('order_item_remove', async () => ({
      ...(await orderPayload('order_item_remove', uuid(5_002), isoAt(harness.clock.now()))),
    }));

    await harness.outbox.drain();

    expect(harness.transport.sent.map((record) => record.id)).toEqual([added.id, removal.id]);
  });
});

describe('discard', () => {
  /** A phone whose queue stopped at an order record the server refused with ORDER_CLOSED. */
  async function stoppedAtOrder() {
    const harness = await setup(
      (record) => (record.ordinal === 2 ? raise('ORDER_CLOSED') : ackOf(record)),
      {
        registered: false,
      },
    );
    await order(harness, 'order_item_add', 1);
    const stale = await order(harness, 'order_send', 2);
    const behind = await order(harness, 'order_item_add', 3);
    await harness.outbox.drain();
    return { harness, stale, behind };
  }

  it('gives up on an order record with the reason, and the queue goes on behind it', async () => {
    const { harness, stale, behind } = await stoppedAtOrder();
    harness.clock.advance(2_000);

    await harness.outbox.discard(stale.id, {
      reason: '  The caisse closed the table first  ',
      discardedBy: 'user-waiter',
      discardedByName: 'Sonia',
    });

    await expect(harness.outbox.list()).resolves.toMatchObject([
      { ordinal: 1, status: 'acked' },
      {
        ordinal: 2,
        status: 'discarded',
        discard: {
          reason: 'The caisse closed the table first',
          discardedBy: 'user-waiter',
          discardedByName: 'Sonia',
          discardedAt: START + 2_000,
        },
        // What the server said stays, so the dead-letter list can show why it was refused.
        lastError: { code: 'ORDER_CLOSED' },
      },
      { ordinal: 3, status: 'pending' },
    ]);
    await expect(harness.outbox.drain()).resolves.toEqual({ state: 'idle' });
    expect(harness.transport.sent.map((record) => record.id)).toEqual([
      uuid(5_001),
      stale.id,
      behind.id,
    ]);
    await expect(harness.outbox.summary()).resolves.toMatchObject({
      pending: 0,
      conflicts: 0,
      discarded: 1,
    });
  });

  it('never sends a discarded record again', async () => {
    const { harness, stale } = await stoppedAtOrder();
    await harness.outbox.discard(stale.id, {
      reason: 'Stale',
      discardedBy: null,
      discardedByName: null,
    });

    await harness.outbox.drain();
    await harness.outbox.drain();

    expect(harness.transport.sent.filter((record) => record.id === stale.id)).toHaveLength(1);
  });

  // Money that was taken is never dropped: a sale in conflict is retried or voided by an admin.
  it.each(['sale', 'session_open'] as const)('refuses to discard a %s record', async (kind) => {
    const harness = await setup(() => raise('SESSION_CLOSED'));
    const record =
      kind === 'sale'
        ? await sell(harness, 1)
        : await harness.outbox.appendSessionOpen(({ meta: registration }) =>
            openPayload(registration, isoAt(START)),
          );
    await harness.outbox.drain();

    await expectFailure(
      harness.outbox.discard(record.id, {
        reason: 'Give up',
        discardedBy: 'user-admin',
        discardedByName: null,
      }),
      'VALIDATION_ERROR',
    );

    await expect(recordAt(harness, 1)).resolves.toMatchObject({
      status: 'conflict',
      discard: null,
    });
  });

  it('refuses to discard without a reason, or a record that is not in conflict', async () => {
    const { harness, stale, behind } = await stoppedAtOrder();

    await expectFailure(
      harness.outbox.discard(stale.id, { reason: '   ', discardedBy: null, discardedByName: null }),
      'VALIDATION_ERROR',
    );
    await expectFailure(
      harness.outbox.discard(behind.id, {
        reason: 'Stale',
        discardedBy: null,
        discardedByName: null,
      }),
      'VALIDATION_ERROR',
    );
    await expectFailure(
      harness.outbox.discard(uuid(9_999), {
        reason: 'Stale',
        discardedBy: null,
        discardedByName: null,
      }),
      'VALIDATION_ERROR',
    );

    expect(await statusesOf(harness)).toEqual(['acked', 'conflict', 'pending']);
  });

  it('tells its subscribers when a record is discarded', async () => {
    const { harness, stale } = await stoppedAtOrder();
    let calls = 0;
    harness.outbox.subscribe(() => {
      calls += 1;
    });

    await harness.outbox.discard(stale.id, {
      reason: 'Stale',
      discardedBy: null,
      discardedByName: null,
    });

    expect(calls).toBe(1);
  });

  it('keeps the table the discarded record named, for the dead-letter list', async () => {
    const { harness, stale } = await stoppedAtOrder();

    await harness.outbox.discard(stale.id, {
      reason: 'Stale',
      discardedBy: null,
      discardedByName: null,
    });

    const [, discarded] = await harness.outbox.list();
    expect(discarded.kind === 'order_send' ? discarded.payload.tableId : null).toBe(TABLE_ID);
  });
});
