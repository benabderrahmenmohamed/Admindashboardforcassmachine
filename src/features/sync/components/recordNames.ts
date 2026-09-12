/**
 * The names an order record is described by, taken from what this device already has: the query
 * cache the room's screens filled (and the persister brought back after a reload) and the device's
 * own records. No React and no query client here, so it runs without a DOM; `useRecordNames` reads
 * the cache and hands it over.
 *
 * Nothing is fetched for a name. The Conflicts screen is opened on a phone that may be offline, and
 * a record that cannot be named is still described in plain words ("an item", "a table").
 */
import { z } from 'zod';
import type { NamedItem, RecordNames } from '@/features/pos/recording';
import type { OutboxRecord } from '../types';

/*
 * Only the fields a name needs, parsed rather than cast: the cache holds whatever a query returned
 * or a reload restored, and a value of any other shape is treated as not cached.
 */
const namedSchema = z.object({ id: z.string(), name: z.string() });
const itemSchema = z.object({ id: z.string(), nameSnapshot: z.string(), qty: z.number() });
const namedListSchema = z.array(namedSchema);
const boardSchema = z.array(z.object({ table: namedSchema }));
const ticketsSchema = z.array(
  z.object({ tableId: z.string(), tableName: z.string(), items: z.array(itemSchema) }),
);
const openOrderSchema = z.object({ tableId: z.string(), items: z.array(itemSchema) });

/** The cached query data a name can come from, as the query cache holds it. */
export interface CachedRoom {
  /** `queryKeys.tableList`: every table, retired ones included. */
  readonly tableList: unknown;
  /** `queryKeys.board`: the active tables, for a device that only opened the grid. */
  readonly board: unknown;
  /** `queryKeys.kitchenTickets`: what the kitchen screen has, with each ticket's table name. */
  readonly kitchenTickets: unknown;
  /** `queryKeys.products`. */
  readonly products: unknown;
  /** Every `queryKeys.openOrder(tableId)` in the cache: the items of the tables this device opened. */
  readonly openOrders: readonly unknown[];
}

function parsed<T>(schema: z.ZodType<T>, value: unknown): T | null {
  const result = schema.safeParse(value);
  return result.success ? result.data : null;
}

/** Sets `key` unless a better source already named it: sources are read best first. */
function keepFirst<V>(map: Map<string, V>, key: string, value: V): void {
  if (!map.has(key)) {
    map.set(key, value);
  }
}

export function recordNames(cached: CachedRoom, records: readonly OutboxRecord[]): RecordNames {
  const tables = new Map<string, string>();
  const products = new Map<string, string>();
  const items = new Map<string, NamedItem>();

  // The admin's list names every table, retired ones too; the grid and the tickets only some.
  for (const table of parsed(namedListSchema, cached.tableList) ?? []) {
    keepFirst(tables, table.id, table.name);
  }
  for (const entry of parsed(boardSchema, cached.board) ?? []) {
    keepFirst(tables, entry.table.id, entry.table.name);
  }
  const tickets = parsed(ticketsSchema, cached.kitchenTickets) ?? [];
  for (const ticket of tickets) {
    keepFirst(tables, ticket.tableId, ticket.tableName);
  }

  for (const product of parsed(namedListSchema, cached.products) ?? []) {
    keepFirst(products, product.id, product.name);
  }

  // An item is named by the snapshot the server took when it landed, which a later rename of the
  // product does not move; the tables this device opened come first, then the kitchen's tickets.
  for (const value of cached.openOrders) {
    // A free table caches null, which has no items to name.
    const order = parsed(openOrderSchema, value);
    if (order === null) {
      continue;
    }
    for (const item of order.items) {
      keepFirst(items, item.id, { name: item.nameSnapshot, qty: item.qty, tableId: order.tableId });
    }
  }
  for (const ticket of tickets) {
    for (const item of ticket.items) {
      keepFirst(items, item.id, {
        name: item.nameSnapshot,
        qty: item.qty,
        tableId: ticket.tableId,
      });
    }
  }
  // Last, the adds this device wrote itself: an add's id is its item's id, so a removal or a prepare
  // written here about an item that never reached a cached table is still named.
  for (const record of records) {
    if (record.kind === 'order_item_add') {
      const { productId, qty, tableId } = record.payload;
      keepFirst(items, record.id, { name: products.get(productId) ?? null, qty, tableId });
    }
  }

  return { tables, products, items };
}
