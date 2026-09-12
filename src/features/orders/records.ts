/**
 * The records a device writes about what is on a table: adding an item, taking one off, telling the
 * kitchen, marking something prepared, cancelling an order.
 *
 * They are built here rather than in the hooks that send them, for the same reason sales are built
 * in `src/features/sales/records.ts`: an order event is a record with an id and a payload hash, and
 * the next phase puts it in the outbox instead of sending it straight away. Nothing in this module
 * knows whether it is going over the network now or in an hour, so that move changes only the
 * caller. No React, no ports, no clock of its own: every value comes in as an argument.
 */
import { withPayloadHash } from '@/lib/payloadHash';
import { parseOrInvalid } from '@/lib/validation';
import {
  orderCancelRecordSchema,
  orderItemAddRecordSchema,
  orderItemPrepareRecordSchema,
  orderItemRemoveRecordSchema,
  orderSendRecordSchema,
  type OrderCancelRecord,
  type OrderItemAddRecord,
  type OrderItemPrepareRecord,
  type OrderItemRemoveRecord,
  type OrderSendRecord,
} from '@/ports';

/** What every order record takes from the device: its id, which device, and when it happened. */
export interface OrderEnvelope {
  readonly id: string;
  readonly deviceId: string;
  readonly createdAt: string;
}

/**
 * An add names the table and never an order: the server finds the table's open order or opens one,
 * so two waiters adding to the same free table cannot race on creating it.
 */
export async function buildOrderItemAddRecord(
  envelope: OrderEnvelope,
  item: {
    readonly tableId: string;
    readonly productId: string;
    readonly qty: number;
    readonly note: string;
  },
): Promise<OrderItemAddRecord> {
  const record = await withPayloadHash({ ...envelope, ...item, note: item.note.trim() });
  return parseOrInvalid(orderItemAddRecordSchema, record, 'the added item');
}

/** Removing keeps the row and stamps a reason, because the admin's report is the whole point. */
export async function buildOrderItemRemoveRecord(
  envelope: OrderEnvelope,
  removal: { readonly itemId: string; readonly reason: string },
): Promise<OrderItemRemoveRecord> {
  // Trimmed before the hash, never after: the schema trims too, and a record whose hash was taken
  // over different text than the record carries would never be recognised as its own replay.
  const record = await withPayloadHash({ ...envelope, ...removal, reason: removal.reason.trim() });
  return parseOrInvalid(orderItemRemoveRecordSchema, record, 'the removal');
}

/** One send stamps every unsent item of the table, and those items are one kitchen ticket. */
export async function buildOrderSendRecord(
  envelope: OrderEnvelope,
  send: { readonly tableId: string },
): Promise<OrderSendRecord> {
  const record = await withPayloadHash({ ...envelope, ...send });
  return parseOrInvalid(orderSendRecordSchema, record, 'the send');
}

export async function buildOrderItemPrepareRecord(
  envelope: OrderEnvelope,
  prepare: { readonly itemId: string },
): Promise<OrderItemPrepareRecord> {
  const record = await withPayloadHash({ ...envelope, ...prepare });
  return parseOrInvalid(orderItemPrepareRecordSchema, record, 'the prepared item');
}

export async function buildOrderCancelRecord(
  envelope: OrderEnvelope,
  cancel: { readonly tableId: string; readonly reason: string },
): Promise<OrderCancelRecord> {
  const record = await withPayloadHash({ ...envelope, ...cancel, reason: cancel.reason.trim() });
  return parseOrInvalid(orderCancelRecordSchema, record, 'the cancellation');
}
