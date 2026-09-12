import { describe, expect, it } from 'vitest';
import { computeZReport } from '@/features/sessions/zReport';
import { AppError } from '@/lib/errors';
import { mm } from '@/lib/money';
import type {
  CashSession,
  CloseSessionRecord,
  OpenSessionRecord,
  OrdersPort,
  SaleRecord,
  SalesPort,
  SessionsPort,
  ZReport,
} from '@/ports';
import {
  closePayload,
  openPayload,
  refundPayload,
  registration as registrationOf,
  salePayload,
  SESSION_ID,
  START,
  storedOrder,
  TERMINAL_ID,
  uuid,
} from './__tests__/fixtures';
import { createPortTransport } from './transport';
import type { OrderKind, OutboxRecord, OutboxTransport } from './types';

// Which port call each kind of record goes to, and what comes back. The transport is the only place
// the queue touches a backend, so it must hand the record over exactly as it was queued.

const registration = registrationOf();

const zReport: ZReport = computeZReport({
  sessionId: SESSION_ID,
  openingFloatMillimes: mm(20_000),
  documents: [],
  voidsCount: 0,
  countedCashMillimes: mm(20_000),
});

function queued(payloadHash: string, sessionId: string) {
  return {
    ordinal: 1,
    terminalCode: registration.code,
    sessionId,
    payloadHash,
    createdAt: START,
    attempts: 0,
    nextAttemptAt: START,
    status: 'pending' as const,
    lastError: null,
    result: null,
    ackedAt: null,
    discard: null,
  };
}

async function numberedRecord(kind: 'sale' | 'refund'): Promise<OutboxRecord> {
  const payload =
    kind === 'sale'
      ? await salePayload(registration, 1, uuid(1))
      : await refundPayload(registration, 2, uuid(2));
  return {
    ...queued(payload.payloadHash, payload.sessionId),
    id: payload.id,
    kind,
    seq: payload.seq,
    payload,
  };
}

async function openingRecord(): Promise<OutboxRecord> {
  const payload = await openPayload(registration);
  return {
    ...queued(payload.payloadHash, payload.id),
    id: payload.id,
    kind: 'session_open',
    seq: null,
    payload,
  };
}

async function closingRecord(): Promise<OutboxRecord> {
  const payload = await closePayload(registration);
  return {
    ...queued(payload.payloadHash, payload.sessionId),
    id: payload.id,
    kind: 'session_close',
    seq: null,
    payload,
  };
}

function sessionOf(record: OpenSessionRecord): CashSession {
  return {
    id: record.id,
    terminalId: TERMINAL_ID,
    terminalCode: record.terminalCode,
    openedBy: record.actorUserId,
    openedAt: record.openedAt,
    openingFloatMillimes: record.openingFloatMillimes,
    closedAt: null,
    closedBy: null,
    closingCountedMillimes: null,
    forceCloseReason: null,
    zReport: null,
  };
}

interface Calls {
  readonly recordSale: SaleRecord[];
  readonly open: OpenSessionRecord[];
  readonly close: CloseSessionRecord[];
  /** Every orders-port call, as [method, record]. */
  readonly orders: (readonly [string, unknown])[];
}

/** A backend that remembers what it was called with, and answers as the contract says it does. */
function backend(failure?: AppError): { transport: OutboxTransport; calls: Calls } {
  const calls: Calls = { recordSale: [], open: [], close: [], orders: [] };
  const sales: SalesPort = {
    recordSale: (record) => {
      calls.recordSale.push(record);
      return failure
        ? Promise.reject(failure)
        : Promise.resolve({
            saleId: record.id,
            receiptNumber: `${record.terminalCode}-${record.seq}`,
            status: 'replayed',
          });
    },
    listSales: () => expect.unreachable('sending a record never lists sales'),
    getSale: () => expect.unreachable('sending a record never reads a sale'),
    voidReceipt: () => expect.unreachable('sending a record never voids a receipt'),
  };
  const sessions: SessionsPort = {
    open: (record) => {
      calls.open.push(record);
      return Promise.resolve({
        sessionId: record.id,
        status: 'created',
        session: sessionOf(record),
      });
    },
    close: (record) => {
      calls.close.push(record);
      return Promise.resolve({ sessionId: record.sessionId, status: 'replayed', zReport });
    },
    current: () => expect.unreachable('sending a record never reads the open session'),
    zReport: () => expect.unreachable('sending a record never asks for a Z-report'),
  };
  const written = (method: string, record: { id: string }, affected: number) => {
    calls.orders.push([method, record]);
    return Promise.resolve({ status: 'created' as const, orderId: 'order-1', affected });
  };
  const orders: OrdersPort = {
    listTables: () => expect.unreachable('sending a record never lists tables'),
    createTable: () => expect.unreachable('sending a record never creates a table'),
    updateTable: () => expect.unreachable('sending a record never edits a table'),
    board: () => expect.unreachable('sending a record never reads the board'),
    openOrder: () => expect.unreachable('sending a record never reads an order'),
    kitchenTickets: () => expect.unreachable('sending a record never reads the kitchen'),
    removedAfterSent: () => expect.unreachable('sending a record never reads a report'),
    addItem: (record) => {
      calls.orders.push(['addItem', record]);
      return Promise.resolve({ status: 'replayed', orderId: 'order-1', itemId: record.id });
    },
    removeItem: (record) => written('removeItem', record, 1),
    send: (record) => written('send', record, 3),
    prepareItem: (record) => written('prepareItem', record, 1),
    cancelOrder: (record) => written('cancelOrder', record, 4),
  };
  return { transport: createPortTransport({ sales, sessions, orders }), calls };
}

describe('createPortTransport', () => {
  it('sends a sale through recordSale, unchanged, and brings back its receipt number', async () => {
    const { transport, calls } = backend();
    const record = await numberedRecord('sale');

    await expect(transport.send(record)).resolves.toEqual({
      status: 'replayed',
      receiptNumber: 'T1-1',
    });

    expect(calls.recordSale).toHaveLength(1);
    expect(calls.recordSale[0]).toBe(record.payload);
    expect(calls.open).toEqual([]);
    expect(calls.close).toEqual([]);
  });

  it('sends a refund through recordSale too, still a refund of its sale', async () => {
    const { transport, calls } = backend();
    const record = await numberedRecord('refund');

    await expect(transport.send(record)).resolves.toEqual({
      status: 'replayed',
      receiptNumber: 'T1-2',
    });

    expect(calls.recordSale[0]).toBe(record.payload);
    expect(calls.recordSale[0]).toMatchObject({ kind: 'refund', seq: 2 });
    expect(calls.recordSale[0].refundsSaleId).not.toBeNull();
  });

  it('sends a session opening through sessions.open and answers with its status alone', async () => {
    const { transport, calls } = backend();
    const record = await openingRecord();

    await expect(transport.send(record)).resolves.toEqual({ status: 'created' });

    expect(calls.open).toHaveLength(1);
    expect(calls.open[0]).toBe(record.payload);
    expect(calls.recordSale).toEqual([]);
    expect(calls.close).toEqual([]);
  });

  it('sends a session closing through sessions.close and brings back the Z-report', async () => {
    const { transport, calls } = backend();
    const record = await closingRecord();

    await expect(transport.send(record)).resolves.toEqual({ status: 'replayed', zReport });

    expect(calls.close).toHaveLength(1);
    expect(calls.close[0]).toBe(record.payload);
    expect(calls.recordSale).toEqual([]);
    expect(calls.open).toEqual([]);
  });

  it('lets a port failure through as it is, so the queue decides from its code', async () => {
    const failure = new AppError('SEQUENCE_GAP', 'Expected receipt T1-1.', {
      details: { expected_seq: 1, received_seq: 2 },
    });
    const { transport } = backend(failure);

    await expect(transport.send(await numberedRecord('sale'))).rejects.toBe(failure);
  });

  // An order record goes to the orders port that writes its kind, exactly as it was queued, and the
  // answer brings back the order it landed on — the queue never needs to read the table to know it.
  it.each<[OrderKind, string, number | undefined]>([
    ['order_item_add', 'addItem', undefined],
    ['order_item_remove', 'removeItem', 1],
    ['order_send', 'send', 3],
    ['order_item_prepare', 'prepareItem', 1],
    ['order_cancel', 'cancelOrder', 4],
  ])('sends %s through orders.%s, unchanged', async (kind, method, affected) => {
    const { transport, calls } = backend();
    const record = await storedOrder(kind, 1);

    const result = await transport.send(record);

    expect(calls.orders).toEqual([[method, record.payload]]);
    expect(calls.orders[0][1]).toBe(record.payload);
    expect(calls.recordSale).toEqual([]);
    expect(result).toEqual(
      affected === undefined
        ? { status: 'replayed', orderId: 'order-1' }
        : { status: 'created', orderId: 'order-1', affected },
    );
  });
});
