import { z } from 'zod';
import { AppError } from '@/lib/errors';
import { toDinarsString, tryParseTND } from '@/lib/money';
import {
  MAX_PRICE_MESSAGE,
  MAX_PRICE_MILLIMES,
  productInputSchema,
  type Product,
  type ProductInput,
} from '@/ports';

export const PRICE_FORMAT_MESSAGE = 'Enter a price in dinars with up to 3 decimals, e.g. 12.500';

const WHOLE_NUMBER = /^-?\d+$/;

/** Stock as typed: a whole number of units, or null when the text is not one. */
function parseStock(text: string): number | null {
  const trimmed = text.trim();
  if (!WHOLE_NUMBER.test(trimmed)) {
    return null;
  }
  const stock = Number(trimmed);
  if (!Number.isSafeInteger(stock)) {
    return null;
  }
  // "-0" is zero, not a negative stock.
  return stock === 0 ? 0 : stock;
}

/**
 * The product form exactly as typed. Every field is text, so a price goes from the typed dinars
 * straight to millimes and is never a float. `toProductInput` turns valid values into the port input.
 */
export const productFormSchema = z.object({
  name: z.string().refine((value) => value.trim() !== '', 'Product name is required'),
  price: z.string().superRefine((value, ctx) => {
    if (value.trim() === '') {
      ctx.addIssue({ code: 'custom', message: 'Price is required' });
      return;
    }
    const amount = tryParseTND(value);
    if (amount === null) {
      ctx.addIssue({ code: 'custom', message: PRICE_FORMAT_MESSAGE });
    } else if (amount < 0) {
      ctx.addIssue({ code: 'custom', message: 'Price cannot be negative' });
    } else if (amount > MAX_PRICE_MILLIMES) {
      ctx.addIssue({ code: 'custom', message: MAX_PRICE_MESSAGE });
    }
  }),
  /** A category id, or '' for no category. */
  categoryId: z.string(),
  barcode: z.string(),
  stock: z.string().superRefine((value, ctx) => {
    if (value.trim() === '') {
      ctx.addIssue({ code: 'custom', message: 'Stock is required' });
      return;
    }
    const stock = parseStock(value);
    if (stock === null) {
      ctx.addIssue({ code: 'custom', message: 'Stock must be a whole number' });
    } else if (stock < 0) {
      ctx.addIssue({ code: 'custom', message: 'Stock cannot be negative' });
    }
  }),
  description: z.string(),
  /** Empty or a full URL: the same rule the port applies. */
  imageUrl: productInputSchema.shape.imageUrl,
});

export type ProductFormValues = z.infer<typeof productFormSchema>;

function validationError(issues: readonly z.core.$ZodIssue[]): AppError {
  const message = issues.length > 0 ? issues[0].message : 'Invalid product';
  return new AppError('VALIDATION_ERROR', message, { details: { issues } });
}

/**
 * Form values as the catalog port's input, with the price in millimes and '' as no category.
 * Throws AppError VALIDATION_ERROR, with the Zod issues in details, when the values are not valid.
 */
export function toProductInput(values: ProductFormValues): ProductInput {
  const form = productFormSchema.safeParse(values);
  if (!form.success) {
    throw validationError(form.error.issues);
  }
  const input = productInputSchema.safeParse({
    name: values.name,
    priceMillimes: tryParseTND(values.price),
    categoryId: values.categoryId === '' ? null : values.categoryId,
    barcode: values.barcode,
    description: values.description,
    imageUrl: values.imageUrl,
    stock: parseStock(values.stock),
  });
  if (!input.success) {
    throw validationError(input.error.issues);
  }
  return input.data;
}

/** Starting values for the form: the product's own values, or an empty form to add one. */
export function toProductFormValues(product?: Product): ProductFormValues {
  if (!product) {
    return {
      name: '',
      price: '',
      categoryId: '',
      barcode: '',
      // A new product starts with 100 in stock, as it always has.
      stock: '100',
      description: '',
      imageUrl: '',
    };
  }
  return {
    name: product.name,
    price: toDinarsString(product.priceMillimes),
    categoryId: product.categoryId ?? '',
    barcode: product.barcode,
    stock: String(product.stock),
    description: product.description,
    imageUrl: product.imageUrl,
  };
}
