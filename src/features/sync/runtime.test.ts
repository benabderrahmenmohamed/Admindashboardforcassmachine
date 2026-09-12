import { describe, expect, it } from 'vitest';
import { AppError } from '@/lib/errors';
import { mm, ZERO } from '@/lib/money';
import type { OpenSessionRecord, SaleRecord } from '@/ports';
import { createInProcessDrainLock } from './locks';
import { createMemoryOutboxStorage } from './memoryStorage';
import { createOutbox } from './outbox';
import { createOutboxRuntime, DRAIN_INTERVAL_MS, type SyncSchedule } from './runtime';
import type { OutboxMeta, OutboxRecord, OutboxResult, OutboxTransport } from './types';

const TERMINAL: OutboxMeta = {
  terminalId: 'terminal-1',
  code: 'T1',
  epoch: 2,
  lastSeq: 41,
  nextOrdinal: 7,
  registeredAt: 1_699_999_000_000,
};
const HASH = 'a'.repeat(64);
const AT = '2026-09-12T09:00:00.000Z';
/** Where the fake clock starts; the runtime never reads the wall clock. */
const START = 1_700_000_000_000;

function saleRecord(id: string, seq: number, meta: OutboxMeta): SaleRecord {
  return {
    id,
    kind: 'sale',
    terminalCode: meta.code,
    epoch: meta.epoch,
    seq,
    sessionId: 'session-1',
    createdAt: AT,
    tableId: null,
    lines: [
      {
        id: 'line-1',
        lineNo: 1,
        openOrderItemId: null,
        productId: 'p-harissa',
        productName: 'Harissa Cap Bon 380 g',
        qty: 1,
        unitPriceMillimes: mm(1350),
        lineDiscountMillimes: ZERO,
        lineDiscountReason: null,
        allocatedDiscountMillimes: ZERO,
        netMillimes: mm(1350),
        refundsSaleLineId: null,
      },
    ],
    cartDiscountMillimes: ZERO,
    totalMillimes: mm(1350),
    payment: { method: 'cash', tenderedMillimes: mm(1350), changeMillimes: ZERO },
    refundsSaleId: null,
    payloadHash: HASH,
  };
}

function openRecord(id: string, meta: OutboxMeta): OpenSessionRecord {
  return {
    id,
    terminalCode: meta.code,
    epoch: meta.epoch,
    actorUserId: 'user-1',
    openedAt: AT,
    openingFloatMillimes: mm(50_000),
    payloadHash: HASH,
  };
}

/** The triggers as a test drives them: nothing runs until the test says so. */
function fakeSchedule() {
  const intervals: { ms: number; run: () => void }[] = [];
  const timers: { ms: number; run: () => void }[] = [];
  const online: (() => void)[] = [];
  const drop = <T>(list: T[], entry: T) => {
    const index = list.indexOf(entry);
    if (index >= 0) list.splice(index, 1);
  };

  const schedule: SyncSchedule = {
    every(ms, run) {
      const entry = { ms, run };
      intervals.push(entry);
      return () => drop(intervals, entry);
    },
    after(ms, run) {
      const entry = { ms, run };
      timers.push(entry);
      return () => drop(timers, entry);
    },
    onOnline(run) {
      online.push(run);
      return () => drop(online, run);
    },
  };

  return {
    schedule,
    intervals,
    timers,
    online,
    tick: () => intervals.forEach((entry) => entry.run()),
    fireTimers: () => timers.splice(0).forEach((entry) => entry.run()),
    goOnline: () => online.forEach((run) => run()),
  };
}

type Answer = (record: OutboxRecord) => OutboxResult | AppError;

const ACCEPT: Answer = () => ({ status: 'created' as const, receiptNumber: 'T1-42' });

function harness(canSend: () => boolean = () => true) {
  const storage = createMemoryOutboxStorage();
  const schedule = fakeSchedule();
  const lock = createInProcessDrainLock();
  const sent: string[] = [];
  let answer: Answer = ACCEPT;
  let now = START;
  const clock = { now: () => now };
  const transport: OutboxTransport = {
    send(record) {
      sent.push(record.id);
      const result = answer(record);
      return result instanceof AppError ? Promise.reject(result) : Promise.resolve(result);
    },
  };
  // No jitter, so a retry delay is exactly 500 ms x 2^attempts.
  const deps = { storage, transport, clock, random: () => 0, lock, canSend };
  const outbox = createOutbox(deps);
  const runtime = createOutboxRuntime({ outbox, storage, schedule: schedule.schedule, clock });

  return {
    runtime,
    outbox,
    /** A second tab of the same register: what it appends reaches this one only through storage. */
    neighbour: createOutbox(deps),
    storage,
    schedule,
    sent,
    answers: (next: Answer) => {
      answer = next;
    },
    advance: (ms: number) => {
      now += ms;
    },
    /** Waits for whatever pass the last trigger started, or runs one. */
    settle: () => runtime.sync(),
  };
}

async function registered(canSend?: () => boolean) {
  const test = harness(canSend);
  await test.storage.writeMeta(TERMINAL);
  test.runtime.start();
  await test.settle();
  return test;
}

describe('createOutboxRuntime', () => {
  it('sends a record as soon as it is appended and follows it in the snapshot', async () => {
    const test = await registered();

    const record = await test.outbox.appendSale('sale', ({ seq, meta }) =>
      Promise.resolve(saleRecord('sale-1', seq, meta)),
    );
    await test.settle();

    expect(record.seq).toBe(42);
    expect(test.sent).toEqual(['sale-1']);
    const { summary, records, state } = test.runtime.snapshot();
    expect(summary).toEqual({ pending: 0, conflicts: 0, lastAckAt: START });
    expect(records.map((each) => each.status)).toEqual(['acked']);
    expect(state).toEqual({ kind: 'idle' });
  });

  it('drains every 30 s and when the device comes back online', async () => {
    const test = await registered();
    expect(test.schedule.intervals.map((entry) => entry.ms)).toEqual([DRAIN_INTERVAL_MS]);

    // Written by the other tab, so nothing here was told to send.
    await test.neighbour.appendSessionOpen(({ meta }) =>
      Promise.resolve(openRecord('open-1', meta)),
    );
    await test.neighbour.appendSale('sale', ({ seq, meta }) =>
      Promise.resolve(saleRecord('sale-1', seq, meta)),
    );
    expect(test.sent).toEqual([]);

    test.schedule.tick();
    await test.settle();
    expect(test.sent).toEqual(['open-1', 'sale-1']);

    await test.neighbour.appendSale('sale', ({ seq, meta }) =>
      Promise.resolve(saleRecord('sale-2', seq, meta)),
    );
    test.schedule.goOnline();
    await test.settle();
    expect(test.sent).toEqual(['open-1', 'sale-1', 'sale-2']);
  });

  it("waits out the record's backoff and sends again when the timer fires", async () => {
    const test = await registered();
    test.answers(() => new AppError('NETWORK_ERROR', 'The server could not be reached.'));

    await test.outbox.appendSale('sale', ({ seq, meta }) =>
      Promise.resolve(saleRecord('sale-1', seq, meta)),
    );
    await test.settle();

    expect(test.runtime.snapshot().state).toEqual({ kind: 'waiting', retryAt: START + 1000 });
    expect(test.schedule.timers.map((entry) => entry.ms)).toEqual([1000]);
    expect(test.runtime.snapshot().summary.pending).toBe(1);

    test.answers(ACCEPT);
    test.advance(1000);
    test.schedule.fireTimers();
    await test.settle();

    expect(test.sent).toEqual(['sale-1', 'sale-1']);
    expect(test.runtime.snapshot().state).toEqual({ kind: 'idle' });
    expect(test.runtime.snapshot().summary).toEqual({
      pending: 0,
      conflicts: 0,
      lastAckAt: START + 1000,
    });
  });

  it('sends nothing while there is no live session, and resumes once there is one', async () => {
    let signedIn = false;
    const test = await registered(() => signedIn);

    await test.outbox.appendSale('sale', ({ seq, meta }) =>
      Promise.resolve(saleRecord('sale-1', seq, meta)),
    );
    await test.settle();

    expect(test.sent).toEqual([]);
    expect(test.runtime.snapshot().state).toEqual({ kind: 'paused', reason: 'auth' });
    expect(test.runtime.snapshot().records[0].attempts).toBe(0);

    // What the provider does when the auth state turns authenticated again.
    signedIn = true;
    await test.runtime.sync();

    expect(test.sent).toEqual(['sale-1']);
    expect(test.runtime.snapshot().state).toEqual({ kind: 'idle' });
  });

  it('stops at a conflict, keeps the records behind it pending, and resumes on retry', async () => {
    const test = await registered();
    test.answers((record) =>
      record.id === 'sale-1'
        ? new AppError('SEQUENCE_GAP', 'Expected receipt T1-40.', {
            details: { expectedSeq: 40, receivedSeq: 42 },
          })
        : { status: 'created' },
    );

    await test.outbox.appendSale('sale', ({ seq, meta }) =>
      Promise.resolve(saleRecord('sale-1', seq, meta)),
    );
    await test.outbox.appendSale('sale', ({ seq, meta }) =>
      Promise.resolve(saleRecord('sale-2', seq, meta)),
    );
    await test.settle();

    const blocked = test.runtime.snapshot();
    expect(blocked.state).toEqual({ kind: 'blocked', recordId: 'sale-1' });
    expect(blocked.summary).toEqual({ pending: 1, conflicts: 1, lastAckAt: null });
    expect(blocked.records.map((record) => record.status)).toEqual(['conflict', 'pending']);
    expect(blocked.records[0].lastError?.code).toBe('SEQUENCE_GAP');
    expect(test.sent).toEqual(['sale-1']);

    test.answers(ACCEPT);
    await test.outbox.retry('sale-1');
    await test.settle();

    expect(test.sent).toEqual(['sale-1', 'sale-1', 'sale-2']);
    expect(test.runtime.snapshot().summary).toEqual({
      pending: 0,
      conflicts: 0,
      lastAckAt: START,
    });
  });

  it('lets a voided conflict through so the records behind it go out', async () => {
    const test = await registered();
    test.answers((record) =>
      record.id === 'sale-1'
        ? new AppError('VALIDATION_ERROR', 'The totals do not match the lines.')
        : { status: 'created' },
    );

    await test.outbox.appendSale('sale', ({ seq, meta }) =>
      Promise.resolve(saleRecord('sale-1', seq, meta)),
    );
    await test.outbox.appendSale('sale', ({ seq, meta }) =>
      Promise.resolve(saleRecord('sale-2', seq, meta)),
    );
    await test.settle();
    expect(test.runtime.snapshot().summary.conflicts).toBe(1);

    await test.outbox.resolveVoid('sale-1', { status: 'voided', receiptNumber: 'T1-42' });
    await test.settle();

    const done = test.runtime.snapshot();
    expect(done.records.map((record) => record.status)).toEqual(['voided', 'acked']);
    expect(done.summary).toEqual({ pending: 0, conflicts: 0, lastAckAt: START });
    expect(test.sent).toEqual(['sale-1', 'sale-2']);
  });

  it('sends nothing until the device is registered, then drains what is queued', async () => {
    const test = harness();
    test.runtime.start();
    await test.settle();

    expect(test.runtime.snapshot().state).toEqual({ kind: 'paused', reason: 'unregistered' });

    await test.storage.writeMeta(TERMINAL);
    await test.outbox.appendSale('sale', ({ seq, meta }) =>
      Promise.resolve(saleRecord('sale-1', seq, meta)),
    );
    await test.settle();

    expect(test.sent).toEqual(['sale-1']);
    expect(test.runtime.snapshot().state).toEqual({ kind: 'idle' });
  });

  it('keeps one snapshot until something changes, and tells its listeners when it does', async () => {
    const test = await registered();
    let changes = 0;
    const unsubscribe = test.runtime.subscribe(() => {
      changes += 1;
    });

    const before = test.runtime.snapshot();
    await test.runtime.refresh();
    await test.runtime.refresh();
    expect(test.runtime.snapshot()).toBe(before);
    expect(changes).toBe(0);

    await test.outbox.appendSale('sale', ({ seq, meta }) =>
      Promise.resolve(saleRecord('sale-1', seq, meta)),
    );
    await test.settle();
    expect(test.runtime.snapshot()).not.toBe(before);
    expect(changes).toBeGreaterThan(0);

    unsubscribe();
    const after = changes;
    await test.outbox.appendSale('sale', ({ seq, meta }) =>
      Promise.resolve(saleRecord('sale-2', seq, meta)),
    );
    await test.settle();
    expect(changes).toBe(after);
  });

  it('stops every trigger when the app stops it', async () => {
    const test = await registered();
    test.answers(() => new AppError('NETWORK_ERROR', 'The server could not be reached.'));
    await test.outbox.appendSale('sale', ({ seq, meta }) =>
      Promise.resolve(saleRecord('sale-1', seq, meta)),
    );
    await test.settle();
    expect(test.schedule.timers).toHaveLength(1);

    test.runtime.stop();

    expect(test.schedule.intervals).toHaveLength(0);
    expect(test.schedule.online).toHaveLength(0);
    expect(test.schedule.timers).toHaveLength(0);
  });
});
