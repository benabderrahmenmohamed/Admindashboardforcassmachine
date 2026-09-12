import { z } from 'zod';
import { mm } from '@/lib/money';
import { millimesSchema } from './common';

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
  /** Always the sum of the product's stock movements; may be negative. */
  stock: z.number().int(),
  available: z.boolean(),
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
});

/** A new product; its opening stock is written as an 'opening' stock movement. */
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

export interface CatalogPort {
  /** Products that are not archived, in creation order. */
  listProducts(): Promise<Product[]>;
  createProduct(input: ProductCreateInput): Promise<Product>;
  updateProduct(id: string, input: ProductUpdateInput): Promise<Product>;
  /** Archives the product: sales that mention it keep pointing at it. */
  deleteProduct(id: string): Promise<void>;
  listCategories(): Promise<Category[]>;
  createCategory(input: CategoryInput): Promise<Category>;
  deleteCategory(id: string): Promise<void>;
}
