/**
 * The room in a unit test: rows as a server read returns them, and order records as this device's
 * queue holds them. Built by hand, so an overlay test needs no backend, no hashing and no clock —
 * and so every field a test does not name reads the same in every test.
 */
import type { OrderOutboxRecord, OutboxResult, OutboxStatus } from '@/features/sync/types';
import { mm } from '@/lib/money';
import type { KitchenTicket, OpenOrder, OpenOrderItem, TableBoardEntry } from '@/ports';
import { menuOf, NO_CHANGES, NO_LOCAL, type RoomItem, type RoomOrder } from '../overlay';

/** 2026-09-12T10:00:00.000Z: every row and record of a test is placed in minutes after it. */
export const T0 = Date.parse('2026-09-12T10:00:00.000Z');

export function at(minutes: number): string {
  return new Date(T0 + minutes * 60_000).toISOString();
}

export function ms(minutes: number): number {
  return T0 + minutes * 60_000;
}

export const TABLE = 'table-1';
export const OTHER_TABLE = 'table-2';
export const ORDER = 'order-1';
export const EXPRESS = { id: 'p-express', name: 'Express', priceMillimes: mm(2_500) };
export const CITRONNADE = { id: 'p-citronnade', name: 'Citronnade', priceMillimes: mm(4_000) };
export const MENU = menuOf([EXPRESS, CITRONNADE]);

const HASH = 'f'.repeat(64);

/** A row as the server reads it back: an Express on TABLE's order, added at T0 by another device. */
export function serverItem(overrides: Partial<OpenOrderItem> & { id: string }): OpenOrderItem {
  return {
    orderId: ORDER,
    productId: EXPRESS.id,
    nameSnapshot: EXPRESS.name,
    unitPriceMillimes: EXPRESS.priceMillimes,
    qty: 1,
    note: '',
    addedBy: 'waiter-2',
    addedAt: at(0),
    sentAt: null,
    preparedAt: null,
    removedAt: null,
    removedBy: null,
    removedReason: null,
    paidSaleId: null,
    ...overrides,
  };
}

export function serverOrder(items: OpenOrderItem[], overrides: Partial<OpenOrder> = {}): OpenOrder {
  return {
    id: ORDER,
    tableId: TABLE,
    status: 'open',
    openedAt: at(0),
    closedAt: null,
    items,
    ...overrides,
  };
}

/** A row as a screen reads it, with no change of this device's on it unless the test puts one. */
export function roomItem(overrides: Partial<RoomItem> & { id: string }): RoomItem {
  return {
    ...serverItem({ id: overrides.id }),
    fromServer: true,
    priceKnown: true,
    local: NO_LOCAL,
    ...overrides,
  };
}

export function roomOrder(items: RoomItem[], overrides: Partial<RoomOrder> = {}): RoomOrder {
  return {
    tableId: TABLE,
    orderId: ORDER,
    openedAt: at(0),
    items,
    cancelling: null,
    changes: NO_CHANGES,
    ...overrides,
  };
}

export function boardEntry(
  tableId: string,
  overrides: Partial<Omit<TableBoardEntry, 'table'>> = {},
): TableBoardEntry {
  return {
    table: { id: tableId, name: tableId, sortOrder: 0, isActive: true },
    orderId: null,
    openedAt: null,
    dueMillimes: mm(0),
    activeCount: 0,
    unsentCount: 0,
    unpaidCount: 0,
    ...overrides,
  };
}

export function kitchenTicket(
  items: OpenOrderItem[],
  overrides: Partial<Omit<KitchenTicket, 'items'>> = {},
): KitchenTicket {
  return {
    orderId: ORDER,
    tableId: TABLE,
    tableName: 'T1',
    sentAt: at(5),
    items,
    ...overrides,
  };
}

/** Where a record is in this device's queue, and how far it got. */
export interface RecordOptions {
  readonly ordinal: number;
  readonly status?: OutboxStatus;
  /** When the server took it; acked records only. Default: T0. */
  readonly ackedAt?: number;
  /** What the server answered; acked records only. Default: created on ORDER. */
  readonly result?: OutboxResult;
  /** The record's own moment, which the server stamps for adds and sends. Default: T0. */
  readonly createdAt?: string;
}

function shell(id: string, options: RecordOptions) {
  const status = options.status ?? 'pending';
  return {
    id,
    ordinal: options.ordinal,
    payloadHash: HASH,
    createdAt: T0,
    attempts: status === 'pending' ? 0 : 1,
    nextAttemptAt: T0,
    status,
    lastError:
      status === 'conflict' ? { code: 'ORDER_CHANGED' as const, message: 'Refused' } : null,
    result:
      status === 'acked'
        ? (options.result ?? { status: 'created' as const, orderId: ORDER, affected: 1 })
        : null,
    ackedAt: status === 'acked' ? (options.ackedAt ?? T0) : null,
    discard:
      status === 'discarded'
        ? { reason: 'Stale table', discardedBy: null, discardedByName: null, discardedAt: T0 }
        : null,
    terminalCode: null,
    seq: null,
    sessionId: null,
  };
}

function envelope(id: string, options: RecordOptions) {
  return { id, deviceId: 'this-device', createdAt: options.createdAt ?? at(0), payloadHash: HASH };
}

/** An add of one Express to TABLE; its id is the id the row gets. */
export function addRecord(
  item: {
    readonly id: string;
    readonly tableId?: string;
    readonly productId?: string;
    readonly qty?: number;
    readonly note?: string;
  },
  options: RecordOptions,
): OrderOutboxRecord {
  return {
    ...shell(item.id, options),
    kind: 'order_item_add',
    payload: {
      ...envelope(item.id, options),
      tableId: item.tableId ?? TABLE,
      productId: item.productId ?? EXPRESS.id,
      qty: item.qty ?? 1,
      note: item.note ?? '',
    },
  };
}

export function removeRecord(
  id: string,
  itemId: string,
  options: RecordOptions,
  reason = 'Guest changed their mind',
): OrderOutboxRecord {
  return {
    ...shell(id, options),
    kind: 'order_item_remove',
    payload: { ...envelope(id, options), itemId, reason },
  };
}

export function sendRecord(id: string, options: RecordOptions, tableId = TABLE): OrderOutboxRecord {
  return {
    ...shell(id, options),
    kind: 'order_send',
    payload: { ...envelope(id, options), tableId },
  };
}

export function prepareRecord(
  id: string,
  itemId: string,
  options: RecordOptions,
): OrderOutboxRecord {
  return {
    ...shell(id, options),
    kind: 'order_item_prepare',
    payload: { ...envelope(id, options), itemId },
  };
}

export function cancelRecord(
  id: string,
  options: RecordOptions,
  tableId = TABLE,
  reason = 'The guests left',
): OrderOutboxRecord {
  return {
    ...shell(id, options),
    kind: 'order_cancel',
    payload: { ...envelope(id, options), tableId, reason },
  };
}
