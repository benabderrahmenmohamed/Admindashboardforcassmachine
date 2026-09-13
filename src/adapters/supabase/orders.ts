import { z } from 'zod';
import { add, mulQty, ZERO, type Millimes } from '@/lib/money';
import {
  diningTableSchema,
  kitchenTicketSchema,
  openOrderItemSchema,
  openOrderSchema,
  orderCancelRecordSchema,
  orderItemAddRecordSchema,
  orderItemAddResultSchema,
  orderItemPrepareRecordSchema,
  orderItemRemoveRecordSchema,
  orderSendRecordSchema,
  orderWriteResultSchema,
  diningTableInputSchema,
  removedAfterSentQuerySchema,
  removedAfterSentSchema,
  tableBoardEntrySchema,
  type DiningTable,
  type KitchenTicket,
  type OpenOrder,
  type OpenOrderItem,
  type OrdersPort,
  type TableBoardEntry,
} from '@/ports';
import type { SupabaseDatabaseClient } from './client';
import type { Tables } from './database.types';
import { unwrap } from './errors';
import { parseInput, parseOutput } from './validate';
import { fromWire, isoTimestamp, isoTimestampOrNull, toWire } from './wire';

const TABLE_COLUMNS = 'id, name, sort_order, is_active';

const ITEM_COLUMNS =
  'id, order_id, product_id, name_snapshot, unit_price_millimes, qty, note, added_by, added_at, sent_at, prepared_at, removed_at, removed_by, removed_reason, paid_sale_id';

const ORDER_COLUMNS = `id, table_id, status, opened_at, closed_at, open_order_items(${ITEM_COLUMNS})`;

/** An item with the table it sits on: what the kitchen screen and the removed report both need. */
const ITEM_WITH_TABLE_COLUMNS = `${ITEM_COLUMNS}, open_orders!inner(id, table_id, status, dining_tables!inner(name))`;

type DiningTableRow = Pick<Tables<'dining_tables'>, 'id' | 'name' | 'sort_order' | 'is_active'>;

type ItemRow = Omit<Tables<'open_order_items'>, 'shop_id'>;

type OrderRow = Pick<
  Tables<'open_orders'>,
  'id' | 'table_id' | 'status' | 'opened_at' | 'closed_at'
> & {
  readonly open_order_items: readonly ItemRow[];
};

type ItemWithTableRow = ItemRow & {
  readonly open_orders: {
    readonly id: string;
    readonly table_id: string;
    readonly status: string;
    readonly dining_tables: { readonly name: string } | null;
  } | null;
};

function toDiningTable(row: DiningTableRow): DiningTable {
  return parseOutput(
    diningTableSchema,
    { id: row.id, name: row.name, sortOrder: row.sort_order, isActive: row.is_active },
    `table ${row.id}`,
  );
}

function toOpenOrderItem(row: ItemRow): OpenOrderItem {
  return parseOutput(
    openOrderItemSchema,
    {
      id: row.id,
      orderId: row.order_id,
      productId: row.product_id,
      nameSnapshot: row.name_snapshot,
      unitPriceMillimes: row.unit_price_millimes,
      qty: row.qty,
      note: row.note,
      addedBy: row.added_by,
      addedAt: isoTimestamp(row.added_at),
      sentAt: isoTimestampOrNull(row.sent_at),
      preparedAt: isoTimestampOrNull(row.prepared_at),
      removedAt: isoTimestampOrNull(row.removed_at),
      removedBy: row.removed_by,
      removedReason: row.removed_reason,
      paidSaleId: row.paid_sale_id,
    },
    `order item ${row.id}`,
  );
}

/** Oldest first, then by id, so two items added in the same millisecond keep a stable order. */
function byAddedAt(a: ItemRow, b: ItemRow): number {
  return a.added_at === b.added_at
    ? a.id.localeCompare(b.id)
    : a.added_at.localeCompare(b.added_at);
}

function toOpenOrder(row: OrderRow): OpenOrder {
  return parseOutput(
    openOrderSchema,
    {
      id: row.id,
      tableId: row.table_id,
      status: row.status,
      openedAt: isoTimestamp(row.opened_at),
      closedAt: isoTimestampOrNull(row.closed_at),
      items: [...row.open_order_items].sort(byAddedAt).map((item) => toOpenOrderItem(item)),
    },
    `order ${row.id}`,
  );
}

/** An item nobody has taken off the table. A removed item keeps its row, but owes nothing. */
function isActive(item: OpenOrderItem): boolean {
  return item.removedAt === null;
}

interface TableTotals {
  readonly dueMillimes: Millimes;
  readonly activeCount: number;
  readonly unsentCount: number;
  readonly unpaidCount: number;
}

const NOTHING_ON_THE_TABLE: TableTotals = {
  dueMillimes: ZERO,
  activeCount: 0,
  unsentCount: 0,
  unpaidCount: 0,
};

/** What a table owes and how its items stand: unpaid and active is what is still owed. */
function totalsOf(items: readonly OpenOrderItem[]): TableTotals {
  const active = items.filter((item) => isActive(item));
  const unpaid = active.filter((item) => item.paidSaleId === null);
  return {
    dueMillimes: add(...unpaid.map((item) => mulQty(item.unitPriceMillimes, item.qty))),
    activeCount: active.length,
    unsentCount: active.filter((item) => item.sentAt === null).length,
    unpaidCount: unpaid.length,
  };
}

function toBoardEntry(table: DiningTable, order: OpenOrder | undefined): TableBoardEntry {
  const totals = order ? totalsOf(order.items) : NOTHING_ON_THE_TABLE;
  return parseOutput(
    tableBoardEntrySchema,
    {
      table,
      orderId: order?.id ?? null,
      openedAt: order?.openedAt ?? null,
      ...totals,
    },
    `the board entry of table ${table.id}`,
  );
}

/** One send is one ticket, so the order and the moment it was sent name the ticket. */
function ticketKey(orderId: string, sentAt: string): string {
  return `${orderId}#${sentAt}`;
}

/** `rows`, oldest send first, as one ticket per send. Rows without their order are left out. */
function toKitchenTickets(rows: readonly ItemWithTableRow[]): KitchenTicket[] {
  const tickets = new Map<
    string,
    { order: NonNullable<ItemWithTableRow['open_orders']>; sentAt: string; items: ItemRow[] }
  >();
  for (const row of rows) {
    const order = row.open_orders;
    if (order === null || row.sent_at === null) {
      // An inner join and a `sent_at is not null` filter asked for neither; nothing to group by.
      continue;
    }
    const key = ticketKey(order.id, row.sent_at);
    const ticket = tickets.get(key) ?? { order, sentAt: row.sent_at, items: [] };
    ticket.items.push(row);
    tickets.set(key, ticket);
  }
  return [...tickets.values()].map((ticket) =>
    parseOutput(
      kitchenTicketSchema,
      {
        orderId: ticket.order.id,
        tableId: ticket.order.table_id,
        tableName: ticket.order.dining_tables?.name ?? '',
        sentAt: isoTimestamp(ticket.sentAt),
        items: [...ticket.items].sort(byAddedAt).map((item) => toOpenOrderItem(item)),
      },
      `the kitchen ticket of order ${ticket.order.id}`,
    ),
  );
}

/**
 * OrdersPort over the order RPCs, which apply the checks in contracts/errors.md, and the
 * dining_tables, open_orders and open_order_items tables, which row-level security keeps to the
 * caller's shop. Records go out exactly as the device wrote them, keys renamed to snake_case, so a
 * replay is recognised by id and payload hash.
 */
export function createSupabaseOrders(client: SupabaseDatabaseClient): OrdersPort {
  return {
    async listTables() {
      const rows = await unwrap(
        client.from('dining_tables').select(TABLE_COLUMNS).order('sort_order').order('id'),
      );
      return rows.map((row) => toDiningTable(row));
    },

    async createTable(input) {
      const fields = parseInput(diningTableInputSchema, input);
      const data = await unwrap(client.rpc('save_dining_table', { p: toWire(fields) }));
      return fromWire(diningTableSchema, data, 'the table');
    },

    async updateTable(id, input) {
      const fields = parseInput(diningTableInputSchema, input);
      const data = await unwrap(client.rpc('save_dining_table', { p: toWire({ id, ...fields }) }));
      return fromWire(diningTableSchema, data, 'the table');
    },

    async board() {
      const [tables, orders] = await Promise.all([
        unwrap(
          client
            .from('dining_tables')
            .select(TABLE_COLUMNS)
            .eq('is_active', true)
            .order('sort_order')
            .order('id'),
        ),
        unwrap(
          client.from('open_orders').select(ORDER_COLUMNS).eq('status', 'open').order('opened_at'),
        ),
      ]);
      const byTable = new Map<string, OpenOrder>();
      for (const row of orders) {
        const order = toOpenOrder(row);
        // A table has at most one open order; should a second one ever exist, the older one is the
        // one guests are sitting at, and the newer is left for the report rather than hidden.
        if (!byTable.has(order.tableId)) {
          byTable.set(order.tableId, order);
        }
      }
      return tables.map((row) => {
        const table = toDiningTable(row);
        return toBoardEntry(table, byTable.get(table.id));
      });
    },

    async openOrder(tableId) {
      const row = await unwrap(
        client
          .from('open_orders')
          .select(ORDER_COLUMNS)
          .eq('table_id', tableId)
          .eq('status', 'open')
          .maybeSingle(),
      );
      return row === null ? null : toOpenOrder(row);
    },

    async kitchenTickets() {
      const rows = await unwrap(
        client
          .from('open_order_items')
          .select(ITEM_WITH_TABLE_COLUMNS)
          .not('sent_at', 'is', null)
          .is('prepared_at', null)
          .is('removed_at', null)
          // A cancelled order is off the kitchen screen; a paid one may still owe a coffee.
          .neq('open_orders.status', 'cancelled')
          .order('sent_at')
          .order('added_at'),
      );
      return toKitchenTickets(rows);
    },

    async removedAfterSent(query) {
      const { from, to } = parseInput(removedAfterSentQuerySchema, query);
      // The report goes through its RPC rather than the tables: naming who took an item off means
      // reading other members' names, so the admin check has to be the server's, not this client's.
      const data = await unwrap(client.rpc('removed_after_sent', { p_from: from, p_to: to }));
      return fromWire(z.array(removedAfterSentSchema), data, 'the removed items report').map(
        (row) => ({
          ...row,
          sentAt: isoTimestamp(row.sentAt),
          removedAt: isoTimestamp(row.removedAt),
        }),
      );
    },

    async addItem(record) {
      const payload = parseInput(orderItemAddRecordSchema, record);
      const data = await unwrap(
        // `added_at` is the record's own createdAt under the name docs/spec.md gives it; the hash
        // is computed over the port record and travels unchanged, so the extra name cannot affect
        // a replay (contracts/errors.md).
        client.rpc('order_item_add', { p: toWire({ ...payload, addedAt: payload.createdAt }) }),
      );
      return fromWire(orderItemAddResultSchema, data, 'the added item');
    },

    async removeItem(record) {
      const payload = parseInput(orderItemRemoveRecordSchema, record);
      const data = await unwrap(client.rpc('order_item_remove', { p: toWire(payload) }));
      return fromWire(orderWriteResultSchema, data, 'the removed item');
    },

    async send(record) {
      const payload = parseInput(orderSendRecordSchema, record);
      const data = await unwrap(
        // `sent_at`: the same as `added_at` above.
        client.rpc('order_send', { p: toWire({ ...payload, sentAt: payload.createdAt }) }),
      );
      return fromWire(orderWriteResultSchema, data, 'the sent items');
    },

    async prepareItem(record) {
      const payload = parseInput(orderItemPrepareRecordSchema, record);
      const data = await unwrap(client.rpc('order_item_prepare', { p: toWire(payload) }));
      return fromWire(orderWriteResultSchema, data, 'the prepared item');
    },

    async cancelOrder(record) {
      const payload = parseInput(orderCancelRecordSchema, record);
      const data = await unwrap(client.rpc('order_cancel', { p: toWire(payload) }));
      return fromWire(orderWriteResultSchema, data, 'the cancelled order');
    },
  };
}
