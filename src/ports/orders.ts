import { z } from 'zod';
import { priceMillimesSchema } from './catalog';
import { millimesSchema, payloadHashSchema, recordIdSchema, timestampSchema } from './common';

/**
 * Open orders are working state, not the ledger: what is on a table right now. The ledger takes over
 * at payment (src/ports/sales.ts), and an item carries the sale that paid it.
 *
 * Every write here is a record a device wrote, possibly offline, and may arrive twice: the id and
 * the payload hash decide replay, exactly as they do for a sale.
 */

export const diningTableSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  sortOrder: z.number().int(),
  isActive: z.boolean(),
});
export type DiningTable = z.infer<typeof diningTableSchema>;

export const openOrderStatusSchema = z.enum(['open', 'closed', 'cancelled']);
export type OpenOrderStatus = z.infer<typeof openOrderStatusSchema>;

/**
 * One line on a table. `nameSnapshot` and `unitPriceMillimes` are copied when the item is added, so
 * a later price change never moves what a guest already ordered.
 *
 * A removed item keeps its row: the admin's report of items removed after they were sent is the
 * point, because that is the classic waiter fraud.
 */
export const openOrderItemSchema = z.object({
  id: z.string().min(1),
  orderId: z.string().min(1),
  productId: z.string().min(1),
  nameSnapshot: z.string(),
  unitPriceMillimes: priceMillimesSchema,
  qty: z.number().int().min(1),
  note: z.string(),
  addedBy: z.string().min(1),
  addedAt: timestampSchema,
  /** When the kitchen was told. Items sent together are one ticket. */
  sentAt: timestampSchema.nullable(),
  preparedAt: timestampSchema.nullable(),
  removedAt: timestampSchema.nullable(),
  removedBy: z.string().nullable(),
  removedReason: z.string().nullable(),
  /** The sale that paid this item, or null while it is unpaid. */
  paidSaleId: z.string().nullable(),
});
export type OpenOrderItem = z.infer<typeof openOrderItemSchema>;

export const openOrderSchema = z.object({
  id: z.string().min(1),
  tableId: z.string().min(1),
  status: openOrderStatusSchema,
  openedAt: timestampSchema,
  closedAt: timestampSchema.nullable(),
  items: z.array(openOrderItemSchema),
});
export type OpenOrder = z.infer<typeof openOrderSchema>;

/** One tile of the table grid the waiter and the caisse both read. */
export const tableBoardEntrySchema = z.object({
  table: diningTableSchema,
  /** The table's open order, or null when the table is free. */
  orderId: z.string().nullable(),
  openedAt: timestampSchema.nullable(),
  /** What the unpaid, active items come to: what is still owed on this table. */
  dueMillimes: millimesSchema,
  activeCount: z.number().int().min(0),
  unsentCount: z.number().int().min(0),
  unpaidCount: z.number().int().min(0),
});
export type TableBoardEntry = z.infer<typeof tableBoardEntrySchema>;

/** One send: the items a waiter told the kitchen about at the same moment. */
export const kitchenTicketSchema = z.object({
  orderId: z.string().min(1),
  tableId: z.string().min(1),
  tableName: z.string(),
  sentAt: timestampSchema,
  items: z.array(openOrderItemSchema).min(1),
});
export type KitchenTicket = z.infer<typeof kitchenTicketSchema>;

/** What every order record carries: who wrote it, on which device, and how to recognise a replay. */
const orderRecordBase = {
  id: recordIdSchema,
  deviceId: z.string().min(1),
  createdAt: timestampSchema,
  payloadHash: payloadHashSchema,
};

/**
 * Adding names the table, never an order: the server finds the table's open order or opens one, so
 * two devices adding to the same free table cannot race on creating it. An add for a table whose
 * order was already paid opens a new order, so a waiter's offline add is never lost.
 */
export const orderItemAddRecordSchema = z.object({
  ...orderRecordBase,
  tableId: z.string().min(1),
  productId: z.string().min(1),
  qty: z.number().int().min(1),
  note: z.string(),
});
export type OrderItemAddRecord = z.infer<typeof orderItemAddRecordSchema>;

export const orderItemRemoveRecordSchema = z.object({
  ...orderRecordBase,
  itemId: z.string().min(1),
  reason: z.string().trim().min(1, 'Say why the item is being removed'),
});
export type OrderItemRemoveRecord = z.infer<typeof orderItemRemoveRecordSchema>;

export const orderSendRecordSchema = z.object({
  ...orderRecordBase,
  tableId: z.string().min(1),
});
export type OrderSendRecord = z.infer<typeof orderSendRecordSchema>;

export const orderItemPrepareRecordSchema = z.object({
  ...orderRecordBase,
  itemId: z.string().min(1),
});
export type OrderItemPrepareRecord = z.infer<typeof orderItemPrepareRecordSchema>;

export const orderCancelRecordSchema = z.object({
  ...orderRecordBase,
  tableId: z.string().min(1),
  reason: z.string().trim().min(1, 'Say why the order is being cancelled'),
});
export type OrderCancelRecord = z.infer<typeof orderCancelRecordSchema>;

export const orderWriteStatusSchema = z.enum(['created', 'replayed']);
export type OrderWriteStatus = z.infer<typeof orderWriteStatusSchema>;

export const orderItemAddResultSchema = z.object({
  status: orderWriteStatusSchema,
  orderId: z.string().min(1),
  itemId: z.string().min(1),
});
export type OrderItemAddResult = z.infer<typeof orderItemAddResultSchema>;

export const orderWriteResultSchema = z.object({
  status: orderWriteStatusSchema,
  orderId: z.string().min(1),
  /** How many items the write touched: sent, prepared, removed or cancelled. */
  affected: z.number().int().min(0),
});
export type OrderWriteResult = z.infer<typeof orderWriteResultSchema>;

/** An item a waiter removed after the kitchen had already been told, for the admin's report. */
export const removedAfterSentSchema = z.object({
  itemId: z.string().min(1),
  tableName: z.string(),
  productName: z.string(),
  qty: z.number().int(),
  unitPriceMillimes: priceMillimesSchema,
  sentAt: timestampSchema,
  removedAt: timestampSchema,
  removedBy: z.string().min(1),
  removedByName: z.string(),
  removedReason: z.string(),
});
export type RemovedAfterSent = z.infer<typeof removedAfterSentSchema>;

export const removedAfterSentQuerySchema = z.object({
  /** Inclusive, ISO 8601. Both ends are required, so a report is always of a named period. */
  from: timestampSchema,
  to: timestampSchema,
});
export type RemovedAfterSentQuery = z.infer<typeof removedAfterSentQuerySchema>;

/** The room as the admin edits it. A table is retired, never deleted: old sales keep their name. */
export const diningTableInputSchema = z.object({
  name: z.string().trim().min(1, 'A table needs a name'),
  sortOrder: z.number().int().min(0),
  isActive: z.boolean(),
});
export type DiningTableInput = z.infer<typeof diningTableInputSchema>;

export interface OrdersPort {
  /** Every table of the shop, in the admin's order, retired ones included. */
  listTables(): Promise<DiningTable[]>;
  /** Admin: adds a table to the room. */
  createTable(input: DiningTableInput): Promise<DiningTable>;
  /** Admin: renames a table, moves it in the room, or retires it. */
  updateTable(id: string, input: DiningTableInput): Promise<DiningTable>;
  /** The grid: one entry per active table, free or with what it owes. */
  board(): Promise<TableBoardEntry[]>;
  /** The table's open order with its items, or null when the table is free. */
  openOrder(tableId: string): Promise<OpenOrder | null>;
  /** Sent, unprepared items grouped by send, oldest ticket first. */
  kitchenTickets(): Promise<KitchenTicket[]>;
  /** Admin: what was taken off tables after the kitchen had been told. */
  removedAfterSent(query: RemovedAfterSentQuery): Promise<RemovedAfterSent[]>;

  addItem(record: OrderItemAddRecord): Promise<OrderItemAddResult>;
  removeItem(record: OrderItemRemoveRecord): Promise<OrderWriteResult>;
  /** Stamps every unsent active item of the table: one send is one kitchen ticket. */
  send(record: OrderSendRecord): Promise<OrderWriteResult>;
  prepareItem(record: OrderItemPrepareRecord): Promise<OrderWriteResult>;
  cancelOrder(record: OrderCancelRecord): Promise<OrderWriteResult>;
}
