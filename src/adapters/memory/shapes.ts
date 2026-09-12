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
  lineNo: z.number().int(),
  productId: z.string(),
  productName: z.string(),
  qty: z.number().int(),
  unitPriceMillimes: millimesSchema,
  lineDiscountMillimes: millimesSchema,
  cartDiscountShareMillimes: millimesSchema,
  lineTotalMillimes: millimesSchema,
  refundsLineNo: z.number().int().nullable(),
});

export const saleRecordInput = z.object({
  id: recordIdSchema,
  kind: recordKindSchema,
  terminalCode: z.string(),
  epoch: z.number().int(),
  seq: z.number().int(),
  sessionId: z.string(),
  createdAt: z.string(),
  lines: z.array(saleLineInput),
  subtotalMillimes: millimesSchema,
  discountMillimes: millimesSchema,
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
