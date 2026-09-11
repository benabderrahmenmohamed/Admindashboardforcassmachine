import { z } from 'zod';
import { priceMillimesSchema } from './catalog';

export const paymentMethodSchema = z.enum(['cash', 'card']);
export type PaymentMethod = z.infer<typeof paymentMethodSchema>;

export const saleLineInputSchema = z.object({
  productId: z.string().min(1),
  name: z.string(),
  qty: z.number().int().positive(),
  unitPriceMillimes: priceMillimesSchema,
});
export type SaleLineInput = z.infer<typeof saleLineInputSchema>;

export const recordSaleInputSchema = z.object({
  lines: z.array(saleLineInputSchema).min(1, 'A sale needs at least one line'),
  paymentMethod: paymentMethodSchema,
});
export type RecordSaleInput = z.infer<typeof recordSaleInputSchema>;

export const recordSaleResultSchema = z.object({
  saleId: z.string().min(1),
});
export type RecordSaleResult = z.infer<typeof recordSaleResultSchema>;

export interface SalesPort {
  recordSale(input: RecordSaleInput): Promise<RecordSaleResult>;
}
