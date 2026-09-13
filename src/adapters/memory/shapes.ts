import { z } from 'zod';
import {
  millimesSchema,
  payloadHashSchema,
  paymentMethodSchema,
  recordIdSchema,
  recordKindSchema,
  zReportSchema,
} from '@/ports';

/*
 * The records a terminal writes, with the type of every field checked but without the value rules
 * of the port schemas (a float of zero or more, a quantity other than zero, at least one line).
 * record_sale, open_session and close_session apply those rules at their own step of the order of
 * checks (contracts/errors.md), and so does the memory backend: a replay, or an earlier check that
 * fails, answers before them.
 */

const saleLineInput = z.object({
  /** The row id the device that wrote the line gave it; a refund names a line by it. */
  id: z.string(),
  lineNo: z.number().int(),
  /**
   * The item of an open order this line pays, for a table payment; null on a counter sale — a
   * coffee taken away, which sat on no table — and on every refund line.
   */
  openOrderItemId: z.string().nullable(),
  productId: z.string(),
  productName: z.string(),
  qty: z.number().int(),
  unitPriceMillimes: millimesSchema,
  lineDiscountMillimes: millimesSchema,
  lineDiscountReason: z.string().nullable(),
  allocatedDiscountMillimes: millimesSchema,
  netMillimes: millimesSchema,
  /** The stored line a refund line gives back, by id; null on a sale line. */
  refundsSaleLineId: z.string().nullable(),
});

/** A line as a device wrote it, before record_sale's rules have read it. */
export type SaleLineInput = z.infer<typeof saleLineInput>;

export const saleRecordInput = z.object({
  id: recordIdSchema,
  kind: recordKindSchema,
  terminalCode: z.string(),
  epoch: z.number().int(),
  seq: z.number().int(),
  sessionId: z.string(),
  /** The table being paid, or null for a counter sale and for a refund. */
  tableId: z.string().nullable(),
  createdAt: z.string(),
  lines: z.array(saleLineInput),
  cartDiscountMillimes: millimesSchema,
  totalMillimes: millimesSchema,
  payment: z.object({
    method: paymentMethodSchema,
    tenderedMillimes: millimesSchema,
    changeMillimes: millimesSchema,
  }),
  refundsSaleId: z.string().nullable(),
  payloadHash: payloadHashSchema,
});

export const openSessionInput = z.object({
  id: recordIdSchema,
  terminalCode: z.string(),
  epoch: z.number().int(),
  actorUserId: z.string(),
  openedAt: z.string(),
  openingFloatMillimes: millimesSchema,
  payloadHash: payloadHashSchema,
});

export const closeSessionInput = z.object({
  id: recordIdSchema,
  sessionId: z.string(),
  terminalCode: z.string(),
  epoch: z.number().int(),
  actorUserId: z.string(),
  closedAt: z.string(),
  closingCountedMillimes: millimesSchema,
  clientZReport: zReportSchema.nullable(),
  payloadHash: payloadHashSchema,
});

export const voidReceiptInput = z.object({
  record: saleRecordInput,
  errorCode: z.string().min(1),
  reason: z.string(),
});

/*
 * The order records a waiter's phone, the caisse and the kitchen write. Same rule as above: the
 * types are checked here and the values where the operation checks them, so a replay answers before
 * a quantity or a reason can refuse it.
 */

const orderRecordInput = {
  id: recordIdSchema,
  /** Absent on a record queued before records named their author: its sender is credited. */
  actorUserId: z.string().optional(),
  deviceId: z.string(),
  createdAt: z.string(),
  payloadHash: payloadHashSchema,
};

export const orderItemAddInput = z.object({
  ...orderRecordInput,
  tableId: z.string(),
  productId: z.string(),
  qty: z.number().int(),
  note: z.string(),
});

export const orderItemRemoveInput = z.object({
  ...orderRecordInput,
  itemId: z.string(),
  reason: z.string(),
});

export const orderSendInput = z.object({ ...orderRecordInput, tableId: z.string() });

export const orderItemPrepareInput = z.object({ ...orderRecordInput, itemId: z.string() });

export const orderCancelInput = z.object({
  ...orderRecordInput,
  tableId: z.string(),
  reason: z.string(),
});
