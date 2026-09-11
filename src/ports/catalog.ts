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
  /** Display name of the category; can outlive a deleted category on legacy data. */
  categoryName: z.string().nullable(),
  barcode: z.string(),
  description: z.string(),
  imageUrl: z.string(),
  stock: z.number().int(),
  available: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Product = z.infer<typeof productSchema>;

export const productInputSchema = z.object({
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
  stock: z.number().int().min(0, 'Stock cannot be negative'),
});
export type ProductInput = z.infer<typeof productInputSchema>;

export interface CatalogPort {
  listProducts(): Promise<Product[]>;
  createProduct(input: ProductInput): Promise<Product>;
  updateProduct(id: string, input: ProductInput): Promise<Product>;
  deleteProduct(id: string): Promise<void>;
  listCategories(): Promise<Category[]>;
  createCategory(input: CategoryInput): Promise<Category>;
  deleteCategory(id: string): Promise<void>;
}
