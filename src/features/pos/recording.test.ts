import { describe, expect, it, vi } from 'vitest';
import { buildRefundRecord, buildSaleRecord, receiptNumber } from '@/features/sales/records';
import { buildOpenSessionRecord } from '@/features/sessions/records';
import {
  createTerminalStore,
  type KeyValueStorage,
  type PendingRecord,
  type StoredTerminal,
  type TerminalStore,
} from '@/features/terminal/terminalStore';
import { AppError, ERROR_CODES } from '@/lib/errors';
import { formatTND, mm, ZERO } from '@/lib/money';
import type { CashSession, RecordSaleResult, Sale, SaleRecord } from '@/ports';
import { addItem, emptyCart } from './cart';
import {
  canDiscard,
  createRecorder,
  describePending,
  discardQuestion,
  nextSeq,
  recordedMessage,
  recordErrorMessage,
  sendPending,
  terminalContext,
  type RecorderState,
  type RecordingPorts,
} from './recording';

const SALE_ID = '00000000-0000-4000-8000-000000000001';
const OTHER_ID = '00000000-0000-4000-8000-000000000002';
const OPEN_ID = '00000000-0000-4000-8000-000000000003';
const REFUND_ID = '00000000-0000-4000-8000-000000000004';
const SESSION_ID = 'session-1';
const AT = '2026-09-11T09:00:00.000Z';

const harissa = { id: 'p-harissa', name: 'Harissa Cap Bon 380 g', priceMillimes: mm(1350) };

function memoryStorage(): KeyValueStorage {
  const items = new Map<string, string>();
  return {
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => {
      items.set(key, value);
    },
    removeItem: (key) => {
      items.delete(key);
    },
  };
}

function registeredStore(lastSeq = 41, code = 'T1'): TerminalStore {
  const store = createTerminalStore(memoryStorage());
  store.register({ terminalId: 'terminal-1', code, epoch: 2, lastSeq, registeredAt: AT });
  return store;
}

function registration(store: TerminalStore): StoredTerminal {
  const terminal = store.read();
  if (!terminal) {
    throw new Error('The test store is not registered');
  }
  return terminal;
}

function saleRecord(store: TerminalStore, id = SALE_ID): Promise<SaleRecord> {
  const terminal = registration(store);
  return buildSaleRecord(
    {
      id,
      seq: nextSeq(terminal),
      sessionId: SESSION_ID,
      createdAt: AT,
      terminal: terminalContext(terminal),
    },
    addItem(emptyCart, harissa, 2),
    { method: 'cash', tenderedMillimes: mm(5000) },
  );
}

function saleView(record: SaleRecord): Sale {
  return {
    id: record.id,
    kind: record.kind,
    receiptNumber: receiptNumber(record.terminalCode, record.seq),
    seq: record.seq,
    terminalId: 'terminal-1',
    terminalCode: record.terminalCode,
    sessionId: record.sessionId,
    refundsSaleId: record.refundsSaleId,
    paymentMethod: record.payment.method,
    subtotalMillimes: record.subtotalMillimes,
    discountMillimes: record.discountMillimes,
    totalMillimes: record.totalMillimes,
    tenderedMillimes: record.payment.tenderedMillimes,
    changeMillimes: record.payment.changeMillimes,
    createdAt: record.createdAt,
    receivedAt: record.createdAt,
    lines: record.lines.map((line) => ({ ...line, refundedQty: 0, refundedMillimes: ZERO })),
  };
}

function answer(record: SaleRecord, status: RecordSaleResult['status'] = 'created') {
  return {
    saleId: record.id,
    receiptNumber: receiptNumber(record.terminalCode, record.seq),
    status,
  };
}

function unexpected(): Promise<never> {
  return Promise.reject(new Error('Not expected in this test'));
}

function ports(overrides: Partial<RecordingPorts> = {}): RecordingPorts {
  return {
    recordSale: (record) => Promise.resolve(answer(record)),
    openSession: unexpected,
    closeSession: unexpected,
    ...overrides,
  };
}

describe('nextSeq and terminalContext', () => {
  it('numbers a record one past the last receipt this device used or adopted', () => {
    const terminal = registration(registeredStore(41));
    expect(nextSeq(terminal)).toBe(42);
    expect(terminalContext(terminal)).toEqual({ terminalCode: 'T1', epoch: 2 });
  });
});

describe('sendPending', () => {
  it('stores the record before sending it, then commits its number and clears the slot', async () => {
    const store = registeredStore(41);
    const record = await saleRecord(store);
    const pendingWhileSending: (PendingRecord | null)[] = [];

    const outcome = await sendPending(
      { type: 'sale', record },
      store,
      ports({
        recordSale: (sent) => {
          pendingWhileSending.push(store.readPending());
          return Promise.resolve(answer(sent));
        },
      }),
    );

    expect(pendingWhileSending).toEqual([{ type: 'sale', record }]);
    expect(outcome).toEqual({
      type: 'sale',
      record,
      result: { saleId: SALE_ID, receiptNumber: 'T1-42', status: 'created' },
    });
    expect(registration(store).lastSeq).toBe(42);
    expect(store.readPending()).toBeNull();
  });

  it('keeps the record and its number after a failed send, and resends the very same record', async () => {
    const store = registeredStore(41);
    const record = await saleRecord(store);
    const sent: SaleRecord[] = [];
    let online = false;
    const flaky = ports({
      recordSale: (value) => {
        sent.push(value);
        return online
          ? Promise.resolve(answer(value))
          : Promise.reject(new AppError('NETWORK_ERROR', 'offline'));
      },
    });

    await expect(sendPending({ type: 'sale', record }, store, flaky)).rejects.toMatchObject({
      code: 'NETWORK_ERROR',
    });
    expect(store.readPending()).toEqual({ type: 'sale', record });
    expect(registration(store).lastSeq).toBe(41);
    // Nothing is renumbered: a new record would still take 42, and is refused while this one waits.
    expect(nextSeq(registration(store))).toBe(42);

    online = true;
    const stored = store.readPending();
    if (!stored) {
      throw new Error('The record should still be pending');
    }
    await sendPending(stored, store, flaky);

    expect(sent).toHaveLength(2);
    expect(sent[1]).toEqual(sent[0]);
    expect(sent[1].id).toBe(record.id);
    expect(sent[1].payloadHash).toBe(record.payloadHash);
    expect(registration(store).lastSeq).toBe(42);
    expect(store.readPending()).toBeNull();
  });

  it('refuses a new record while another one is waiting, without sending it', async () => {
    const store = registeredStore(41);
    const waiting = await saleRecord(store, SALE_ID);
    store.writePending({ type: 'sale', record: waiting });
    const another = await saleRecord(store, OTHER_ID);
    const recordSale = vi.fn((record: SaleRecord) => Promise.resolve(answer(record)));

    await expect(
      sendPending({ type: 'sale', record: another }, store, ports({ recordSale })),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(recordSale).not.toHaveBeenCalled();
    expect(store.readPending()).toEqual({ type: 'sale', record: waiting });
  });

  it.each(['replayed', 'voided'] as const)(
    'commits the number of a %s record too',
    async (status) => {
      const store = registeredStore(41);
      const record = await saleRecord(store);
      await sendPending(
        { type: 'sale', record },
        store,
        ports({ recordSale: (value) => Promise.resolve(answer(value, status)) }),
      );
      expect(registration(store).lastSeq).toBe(42);
      expect(store.readPending()).toBeNull();
    },
  );

  it('leaves the receipt counter alone for session records', async () => {
    const store = registeredStore(41);
    const record = await buildOpenSessionRecord({
      id: OPEN_ID,
      terminal: terminalContext(registration(store)),
      actorUserId: 'cashier-1',
      openedAt: AT,
      openingFloatMillimes: mm(50_000),
    });
    const session: CashSession = {
      id: OPEN_ID,
      terminalId: 'terminal-1',
      terminalCode: 'T1',
      openedBy: 'cashier-1',
      openedAt: AT,
      openingFloatMillimes: mm(50_000),
      closedAt: null,
      closedBy: null,
      closingCountedMillimes: null,
      forceCloseReason: null,
      zReport: null,
    };

    const outcome = await sendPending(
      { type: 'session_open', record },
      store,
      ports({
        openSession: () => Promise.resolve({ sessionId: OPEN_ID, status: 'created', session }),
      }),
    );

    expect(outcome).toMatchObject({ type: 'session_open', result: { session } });
    expect(registration(store).lastSeq).toBe(41);
    expect(store.readPending()).toBeNull();
  });

  it('never moves the counter for a record written under another terminal code', async () => {
    const store = registeredStore(41, 'T2');
    const record = await buildSaleRecord(
      {
        id: SALE_ID,
        seq: 7,
        sessionId: SESSION_ID,
        createdAt: AT,
        terminal: { terminalCode: 'T1', epoch: 0 },
      },
      addItem(emptyCart, harissa),
      { method: 'card' },
    );
    store.writePending({ type: 'sale', record });

    await sendPending({ type: 'sale', record }, store, ports());

    expect(registration(store).lastSeq).toBe(41);
    expect(store.readPending()).toBeNull();
  });
});

describe('createRecorder', () => {
  it('publishes sending then idle around a new record, in step with the pending slot', async () => {
    const store = registeredStore(41);
    const record = await saleRecord(store);
    const recorder = createRecorder(store);
    const states: RecorderState[] = [];
    recorder.subscribe(() => states.push(recorder.snapshot()));
    const seenWhileSending: [RecorderState, string | undefined][] = [];

    const attempt = await recorder.send(
      { type: 'sale', record },
      ports({
        recordSale: (value) => {
          seenWhileSending.push([recorder.snapshot(), store.readPending()?.record.id]);
          return Promise.resolve(answer(value));
        },
      }),
    );

    expect(seenWhileSending).toEqual([[{ status: 'sending', id: SALE_ID, first: true }, SALE_ID]]);
    expect(states).toEqual([{ status: 'sending', id: SALE_ID, first: true }, { status: 'idle' }]);
    expect(attempt).toMatchObject({ ok: true, outcome: { result: { receiptNumber: 'T1-42' } } });
  });

  it('keeps a failed record with its error, and a retry resends it', async () => {
    const store = registeredStore(41);
    const record = await saleRecord(store);
    const recorder = createRecorder(store);
    let up = false;
    const server = ports({
      recordSale: (value) =>
        up ? Promise.resolve(answer(value)) : Promise.reject(new AppError('SERVER_ERROR', 'down')),
    });

    const failed = await recorder.send({ type: 'sale', record }, server);
    expect(failed).toMatchObject({ ok: false, kept: true, error: { code: 'SERVER_ERROR' } });
    expect(recorder.snapshot()).toMatchObject({ status: 'failed', id: SALE_ID });

    up = true;
    const states: RecorderState[] = [];
    recorder.subscribe(() => states.push(recorder.snapshot()));
    const retried = await recorder.retry(server);

    expect(states).toEqual([{ status: 'sending', id: SALE_ID, first: false }, { status: 'idle' }]);
    expect(retried).toMatchObject({ ok: true, outcome: { record: { id: SALE_ID } } });
    expect(registration(store).lastSeq).toBe(42);
    expect(store.readPending()).toBeNull();
  });

  it('does not keep a record that never reached the pending slot', async () => {
    const store = registeredStore(41);
    store.writePending({ type: 'sale', record: await saleRecord(store, SALE_ID) });
    const recorder = createRecorder(store);

    const attempt = await recorder.send(
      { type: 'sale', record: await saleRecord(store, OTHER_ID) },
      ports(),
    );

    expect(attempt).toMatchObject({ ok: false, kept: false, error: { code: 'VALIDATION_ERROR' } });
    expect(recorder.snapshot()).toEqual({ status: 'idle' });
    expect(store.readPending()?.record.id).toBe(SALE_ID);
  });

  it('sends one record at a time', async () => {
    const store = registeredStore(41);
    const record = await saleRecord(store);
    const recorder = createRecorder(store);
    let reply: (result: RecordSaleResult) => void = () => undefined;
    const slow = ports({
      recordSale: () =>
        new Promise<RecordSaleResult>((resolve) => {
          reply = resolve;
        }),
    });

    const first = recorder.send({ type: 'sale', record }, slow);
    const second = await recorder.retry(slow);
    expect(second).toMatchObject({ ok: false, kept: false });

    reply(answer(record));
    expect(await first).toMatchObject({ ok: true });
  });

  it('discards a refused record, and its number goes to the next record', async () => {
    const store = registeredStore(41);
    const record = await saleRecord(store);
    const recorder = createRecorder(store);

    await recorder.send(
      { type: 'sale', record },
      ports({
        recordSale: () =>
          Promise.reject(new AppError('SESSION_CLOSED', 'closed', { details: { sessionId: 's' } })),
      }),
    );
    recorder.discard();

    expect(store.readPending()).toBeNull();
    expect(recorder.snapshot()).toEqual({ status: 'idle' });
    expect(nextSeq(registration(store))).toBe(42);
  });

  it('has nothing to retry without a pending record', async () => {
    const recorder = createRecorder(registeredStore());
    expect(await recorder.retry(ports())).toMatchObject({ ok: false, kept: false });
  });
});

describe('canDiscard', () => {
  it('only offers to give up on a record the server refused', () => {
    expect(ERROR_CODES.filter((code) => canDiscard(new AppError(code, 'refused')))).toEqual([
      'FORBIDDEN',
      'NOT_FOUND',
      'VALIDATION_ERROR',
      'IDEMPOTENCY_CONFLICT',
      'SEQUENCE_GAP',
      'SESSION_CLOSED',
      'SESSION_ALREADY_OPEN',
      'TERMINAL_SUPERSEDED',
    ]);
  });
});

describe('recordErrorMessage', () => {
  it('has a message for every code, decided by the code and not the message text', () => {
    for (const code of ERROR_CODES) {
      const first = recordErrorMessage(new AppError(code, 'one'), null);
      expect(first.length).toBeGreaterThan(0);
      if (code !== 'VALIDATION_ERROR' && code !== 'CONFIG_ERROR' && code !== 'UNKNOWN') {
        expect(recordErrorMessage(new AppError(code, 'two'), null)).toBe(first);
      }
    }
  });

  it('tells a superseded device that it must be registered again', async () => {
    const store = registeredStore();
    const pending: PendingRecord = { type: 'sale', record: await saleRecord(store) };
    const error = new AppError('TERMINAL_SUPERSEDED', 'superseded', {
      details: { terminalCode: 'T1', currentEpoch: 3 },
    });
    expect(recordErrorMessage(error, pending)).toMatch(/Terminal T1 .*registered again/);
  });

  it('names the receipt number the server expects, and whether registering again helps', async () => {
    const store = registeredStore();
    const pending: PendingRecord = { type: 'sale', record: await saleRecord(store) };
    const behind = new AppError('SEQUENCE_GAP', 'gap', {
      details: { expectedSeq: 44, receivedSeq: 42 },
    });
    // A device ahead of the server, as after the demo backend was reset.
    const ahead = new AppError('SEQUENCE_GAP', 'gap', {
      details: { expectedSeq: 1, receivedSeq: 42 },
    });

    expect(recordErrorMessage(behind, pending)).toContain('T1-44');
    expect(recordErrorMessage(behind, pending)).toContain('register this device again');
    expect(recordErrorMessage(ahead, pending)).toContain('T1-1');
    expect(recordErrorMessage(ahead, pending)).not.toContain('Ask an admin to register');
  });

  it('says what is left of a refunded line, by product name', async () => {
    const store = registeredStore();
    const sale = saleView(await saleRecord(store));
    const terminal = registration(store);
    const refund = await buildRefundRecord(
      {
        id: REFUND_ID,
        seq: 43,
        sessionId: SESSION_ID,
        createdAt: AT,
        terminal: terminalContext(terminal),
      },
      sale,
      [{ lineNo: 1, qty: 2 }],
      'cash',
    );
    const error = new AppError('VALIDATION_ERROR', 'too much', {
      details: { lineNo: 1, remainingQty: 1, remainingMillimes: 1350 },
    });

    const message = recordErrorMessage(error, { type: 'sale', record: refund });

    expect(message).toContain('Harissa Cap Bon 380 g');
    expect(message).toContain('1 unit');
    expect(message).toContain(formatTND(mm(1350)));
  });
});

describe('recordedMessage and describePending', () => {
  it('names the receipt of a recorded sale or refund', async () => {
    const store = registeredStore(41);
    const record = await saleRecord(store);
    const refund = { ...record, kind: 'refund' as const, seq: 43 };

    expect(recordedMessage({ type: 'sale', record, result: answer(record) })).toBe(
      'Sale T1-42 recorded',
    );
    expect(recordedMessage({ type: 'sale', record, result: answer(record, 'replayed') })).toBe(
      'Sale T1-42 recorded',
    );
    expect(recordedMessage({ type: 'sale', record: refund, result: answer(refund) })).toBe(
      'Refund T1-43 recorded',
    );
    expect(recordedMessage({ type: 'sale', record, result: answer(record, 'voided') })).toContain(
      'voided',
    );
  });

  it('describes an unsent record with its receipt number and amount', async () => {
    const store = registeredStore(41);
    const record = await saleRecord(store);
    const pending: PendingRecord = { type: 'sale', record };

    expect(describePending(pending)).toBe(`Sale T1-42: ${formatTND(mm(2700))} paid by cash`);
    expect(discardQuestion(pending)).toContain('T1-42');
  });

  it('describes an unsent session opening without a receipt number', async () => {
    const store = registeredStore(41);
    const record = await buildOpenSessionRecord({
      id: OPEN_ID,
      terminal: terminalContext(registration(store)),
      actorUserId: 'cashier-1',
      openedAt: AT,
      openingFloatMillimes: mm(50_000),
    });
    const pending: PendingRecord = { type: 'session_open', record };

    expect(describePending(pending)).toContain(formatTND(mm(50_000)));
    expect(discardQuestion(pending)).not.toContain('T1-');
  });
});
