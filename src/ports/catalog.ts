import { z } from 'zod';
import { mm } from '@/lib/money';
import { millimesSchema, payloadHashSchema, recordIdSchema } from './common';

export const categorySchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  color: z.string(),
  createdAt: z.string(),
});
export type Category = z.infer<typeof categorySchema>;

export const categoryInputSchema = z.object({
  name: z.string().trim().min(1, 'Category name is required'),
  color: z.string().regex(/^#[0-9a-f]{6}$/i, 'Pick a colour'),
});
export type CategoryInput = z.infer<typeof categoryInputSchema>;

/**
 * The highest price a product can have: one billion dinars. Up to it every amount has at most 13
 * significant digits, so it also survives a trip through a JSON number exactly.
 */
export const MAX_PRICE_MILLIMES = mm(1_000_000_000_000);
export const MAX_PRICE_MESSAGE = 'Price cannot be above one billion dinars';

/** A price in millimes, from zero to MAX_PRICE_MILLIMES. */
export const priceMillimesSchema = millimesSchema
  .refine((value) => value >= 0, 'Price cannot be negative')
  .refine((value) => value <= MAX_PRICE_MILLIMES, MAX_PRICE_MESSAGE);

export const productSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  priceMillimes: priceMillimesSchema,
  categoryId: z.string().nullable(),
  categoryName: z.string().nullable(),
  barcode: z.string(),
  description: z.string(),
  imageUrl: z.string(),
  /**
   * On the menu right now. A café sells out of a dish and puts it back tomorrow, so this is a daily
   * toggle for admins and waiters, not a change to the product.
   */
  isAvailable: z.boolean(),
  /**
   * Whether stock is counted for this product. Most café items are made to order and are not, so
   * `stockQty` only means something when this is true.
   */
  trackStock: z.boolean(),
  /** The sum of the product's stock movements; may be negative, and stock never blocks a sale. */
  stockQty: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Product = z.infer<typeof productSchema>;

const productFieldsSchema = z.object({
  name: z.string().trim().min(1, 'Product name is required'),
  priceMillimes: priceMillimesSchema,
  categoryId: z.string().min(1).nullable(),
  barcode: z.string().trim(),
  description: z.string(),
  imageUrl: z.union([
    z.literal(''),
    z.url({
      protocol: /^https?$/,
      error: 'Enter a full http(s) URL, e.g. https://example.com/image.jpg',
    }),
  ]),
  isAvailable: z.boolean(),
  trackStock: z.boolean(),
});

/** A new product; its opening stock is written as an 'opening' stock movement when it is tracked. */
export const productCreateInputSchema = productFieldsSchema.extend({
  openingStock: z.number().int().min(0, 'Stock cannot be negative'),
});
export type ProductCreateInput = z.infer<typeof productCreateInputSchema>;

/**
 * Changes to a product. Stock is never overwritten: `stockDelta` (counted minus shown when the form
 * opened) becomes an 'adjustment' movement, so a sale made meanwhile is not undone.
 */
export const productUpdateInputSchema = productFieldsSchema.extend({
  stockDelta: z.number().int(),
});
export type ProductUpdateInput = z.infer<typeof productUpdateInputSchema>;

/**
 * An admin counting stock by hand. It carries a record id and a payload hash like every other write
 * the server accepts twice, so a retry cannot count the same correction again.
 */
export const stockAdjustmentSchema = z.object({
  id: recordIdSchema,
  productId: z.string().min(1),
  qtyDelta: z
    .number()
    .int()
    .refine((value) => value !== 0, 'An adjustment cannot be zero'),
  reason: z.string().trim().min(1, 'Say why the stock is being corrected'),
  payloadHash: payloadHashSchema,
});
export type StockAdjustment = z.infer<typeof stockAdjustmentSchema>;

/**
 * What the correction did, or what it did the first time it arrived. It answers the stock rather
 * than the product, because a replay must answer what it answered then, not what is true now.
 */
export const stockAdjustmentResultSchema = z.object({
  status: z.enum(['created', 'replayed']),
  productId: z.string().min(1),
  stockQty: z.number().int(),
});
export type StockAdjustmentResult = z.infer<typeof stockAdjustmentResultSchema>;

export interface CatalogPort {
  /** Products that are not archived, in creation order. */
  listProducts(): Promise<Product[]>;
  createProduct(input: ProductCreateInput): Promise<Product>;
  updateProduct(id: string, input: ProductUpdateInput): Promise<Product>;
  /** Archives the product: sales that mention it keep pointing at it. */
  deleteProduct(id: string): Promise<void>;
  /** The daily sold-out toggle, which a waiter may use as well as an admin. */
  setAvailability(productId: string, isAvailable: boolean): Promise<Product>;
  /** Admin: corrects counted stock, leaving the movement behind as the reason. */
  adjustStock(adjustment: StockAdjustment): Promise<StockAdjustmentResult>;
  listCategories(): Promise<Category[]>;
  createCategory(input: CategoryInput): Promise<Category>;
  deleteCategory(id: string): Promise<void>;
}
