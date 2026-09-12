import { z } from 'zod';
import { priceMillimesSchema } from './catalog';
import { millimesSchema, payloadHashSchema, recordIdSchema, timestampSchema } from './common';

export const paymentMethodSchema = z.enum(['cash', 'card']);
export type PaymentMethod = z.infer<typeof paymentMethodSchema>;

export const recordKindSchema = z.enum(['sale', 'refund']);
export type RecordKind = z.infer<typeof recordKindSchema>;

/**
 * Sale line: qty ≥ 1, lineTotal = qty × unitPrice − lineDiscount − cartDiscountShare.
 * Refund line: qty ≤ −1, names `refundsLineNo`, no discounts, lineTotal ≤ 0.
 */
export const saleLineSchema = z.object({
  lineNo: z.number().int().min(1),
  productId: z.string().min(1),
  productName: z.string(),
  qty: z
    .number()
    .int()
    .refine((value) => value !== 0, 'Quantity cannot be zero'),
  unitPriceMillimes: priceMillimesSchema,
  lineDiscountMillimes: millimesSchema,
  cartDiscountShareMillimes: millimesSchema,
  lineTotalMillimes: millimesSchema,
  refundsLineNo: z.number().int().min(1).nullable(),
});
export type SaleLine = z.infer<typeof saleLineSchema>;

/** Cash: tendered ≥ total and change = tendered − total. Card and refunds: tendered = total, change 0. */
export const paymentSchema = z.object({
  method: paymentMethodSchema,
  tenderedMillimes: millimesSchema,
  changeMillimes: millimesSchema,
});
export type Payment = z.infer<typeof paymentSchema>;

/** A sale or refund exactly as the terminal wrote it; what record_sale and POST /sales receive. */
export const saleRecordSchema = z.object({
  id: recordIdSchema,
  kind: recordKindSchema,
  terminalCode: z.string().min(1),
  epoch: z.number().int().min(0),
  seq: z.number().int().min(1),
  sessionId: z.string().min(1),
  createdAt: timestampSchema,
  lines: z.array(saleLineSchema).min(1),
  subtotalMillimes: millimesSchema,
  discountMillimes: millimesSchema,
  totalMillimes: millimesSchema,
  payment: paymentSchema,
  refundsSaleId: z.string().min(1).nullable(),
  payloadHash: payloadHashSchema,
});
export type SaleRecord = z.infer<typeof saleRecordSchema>;

export const recordStatusSchema = z.enum(['created', 'replayed', 'voided']);
export type RecordStatus = z.infer<typeof recordStatusSchema>;

export const recordSaleResultSchema = z.object({
  saleId: z.string().min(1),
  receiptNumber: z.string().min(1),
  status: recordStatusSchema,
});
export type RecordSaleResult = z.infer<typeof recordSaleResultSchema>;

/** A stored line, with how much of it later refunds have taken back (0 on refund lines). */
export const saleLineViewSchema = saleLineSchema.extend({
  refundedQty: z.number().int().min(0),
  refundedMillimes: millimesSchema,
});
export type SaleLineView = z.infer<typeof saleLineViewSchema>;

export const saleSchema = z.object({
  id: z.string().min(1),
  kind: recordKindSchema,
  receiptNumber: z.string().min(1),
  seq: z.number().int().min(1),
  terminalId: z.string().min(1),
  terminalCode: z.string().min(1),
  sessionId: z.string().min(1),
  refundsSaleId: z.string().nullable(),
  paymentMethod: paymentMethodSchema,
  subtotalMillimes: millimesSchema,
  discountMillimes: millimesSchema,
  totalMillimes: millimesSchema,
  tenderedMillimes: millimesSchema,
  changeMillimes: millimesSchema,
  createdAt: timestampSchema,
  receivedAt: timestampSchema,
  lines: z.array(saleLineViewSchema).min(1),
});
export type Sale = z.infer<typeof saleSchema>;

export const listSalesQuerySchema = z.object({
  terminalId: z.string().min(1).optional(),
  sessionId: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(200).optional(),
});
export type ListSalesQuery = z.infer<typeof listSalesQuerySchema>;

export const voidReceiptInputSchema = z.object({
  record: saleRecordSchema,
  errorCode: z.string().min(1),
  reason: z.string().trim().min(1, 'Say why this receipt is being voided'),
});
export type VoidReceiptInput = z.infer<typeof voidReceiptInputSchema>;

export const voidReceiptResultSchema = z.object({
  saleId: z.string().min(1),
  receiptNumber: z.string().min(1),
  /** `recorded`: the record reached the ledger after all; treat it as acknowledged. */
  status: z.enum(['voided', 'replayed', 'recorded']),
});
export type VoidReceiptResult = z.infer<typeof voidReceiptResultSchema>;

export interface SalesPort {
  recordSale(record: SaleRecord): Promise<RecordSaleResult>;
  /** Newest first. */
  listSales(query: ListSalesQuery): Promise<Sale[]>;
  getSale(id: string): Promise<Sale>;
  /** Admin only: gives up on a numbered record that can never be accepted, keeping numbering gapless. */
  voidReceipt(input: VoidReceiptInput): Promise<VoidReceiptResult>;
}
