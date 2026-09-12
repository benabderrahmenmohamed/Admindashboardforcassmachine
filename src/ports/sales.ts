import { z } from 'zod';
import { priceMillimesSchema } from './catalog';
import { millimesSchema, payloadHashSchema, recordIdSchema, timestampSchema } from './common';

export const paymentMethodSchema = z.enum(['cash', 'card']);
export type PaymentMethod = z.infer<typeof paymentMethodSchema>;

export const recordKindSchema = z.enum(['sale', 'refund']);
export type RecordKind = z.infer<typeof recordKindSchema>;

/**
 * Sale line: qty ≥ 1, `netMillimes` = qty × unitPrice − lineDiscount − allocatedDiscount.
 * Refund line: qty ≤ −1, names the line it gives back through `refundsSaleLineId`, no discounts.
 *
 * `openOrderItemId` names the item on the table this line pays. It is null for a counter sale — a
 * coffee taken away, which never sat on a table — and for every refund line.
 */
export const saleLineSchema = z
  .object({
    /**
     * The row id of this line, chosen by the device that wrote it — see `saleLineId`. A refund of a
     * sale that has not reached a server yet has to name the lines it gives back, so the writer
     * names its own rows, exactly as it names the record.
     */
    id: z.string().min(1),
    lineNo: z.number().int().min(1),
    openOrderItemId: z.string().min(1).nullable(),
    productId: z.string().min(1),
    productName: z.string(),
    qty: z
      .number()
      .int()
      .refine((value) => value !== 0, 'Quantity cannot be zero'),
    unitPriceMillimes: priceMillimesSchema,
    lineDiscountMillimes: millimesSchema,
    /** Why this line was discounted or offered. A discount without a reason is not allowed. */
    lineDiscountReason: z.string().nullable(),
    /** This line's share of the cart discount, allocated by largest remainder so the parts sum exactly. */
    allocatedDiscountMillimes: millimesSchema,
    netMillimes: millimesSchema,
    refundsSaleLineId: z.string().min(1).nullable(),
  })
  .refine(
    (line) => line.lineDiscountMillimes === 0 || (line.lineDiscountReason ?? '').trim() !== '',
    { error: 'A line discount needs a reason', path: ['lineDiscountReason'] },
  );
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
  /** The table being paid, or null for a counter sale and for a refund. */
  tableId: z.string().min(1).nullable(),
  createdAt: timestampSchema,
  lines: z.array(saleLineSchema).min(1),
  cartDiscountMillimes: millimesSchema,
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

/**
 * A stored line, with its own id — a refund points at it — and how much of it later refunds have
 * taken back (0 on refund lines).
 */
export const saleLineViewSchema = z.object({
  id: z.string().min(1),
  lineNo: z.number().int().min(1),
  openOrderItemId: z.string().nullable(),
  productId: z.string().min(1),
  productName: z.string(),
  qty: z.number().int(),
  unitPriceMillimes: priceMillimesSchema,
  lineDiscountMillimes: millimesSchema,
  lineDiscountReason: z.string().nullable(),
  allocatedDiscountMillimes: millimesSchema,
  netMillimes: millimesSchema,
  refundsSaleLineId: z.string().nullable(),
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
  tableId: z.string().nullable(),
  /** The table's name as it is now, for a receipt someone reads later; null for a counter sale. */
  tableName: z.string().nullable(),
  refundsSaleId: z.string().nullable(),
  paymentMethod: paymentMethodSchema,
  cartDiscountMillimes: millimesSchema,
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
  tableId: z.string().min(1).optional(),
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
