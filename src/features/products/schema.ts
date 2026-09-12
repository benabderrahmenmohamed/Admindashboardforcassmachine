import { z } from 'zod';
import { AppError } from '@/lib/errors';
import { toDinarsString, tryParseTND } from '@/lib/money';
import {
  MAX_PRICE_MESSAGE,
  MAX_PRICE_MILLIMES,
  productCreateInputSchema,
  productUpdateInputSchema,
  type Product,
  type ProductCreateInput,
  type ProductUpdateInput,
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
 * The product form exactly as typed, for a product whose stock was `loadedStock` when the form
 * opened, or for a new product when it is null. Every field is text, so a price goes from the typed
 * dinars straight to millimes and is never a float.
 */
function buildProductFormSchema(loadedStock: number | null) {
  return z.object({
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
      } else if (stock < 0 && stock !== loadedStock) {
        ctx.addIssue({ code: 'custom', message: 'Stock cannot be negative' });
      }
    }),
    description: z.string(),
    /** Empty or a full URL: the same rule the port applies. */
    imageUrl: productCreateInputSchema.shape.imageUrl,
  });
}

/**
 * The form to add a product. `toProductCreateInput` turns valid values into the port input, with the
 * stock typed as the product's opening stock.
 */
export const productFormSchema = buildProductFormSchema(null);

/**
 * The form to edit a product whose stock was `loadedStock` when the form opened. Sales can take stock
 * below zero: such a stock can be kept as it is, so the product stays editable, but not typed.
 * `toProductUpdateInput` turns valid values into the port input.
 */
export function productEditFormSchema(loadedStock: number) {
  return buildProductFormSchema(loadedStock);
}

export type ProductFormValues = z.infer<typeof productFormSchema>;

function validationError(issues: readonly z.core.$ZodIssue[]): AppError {
  const message = issues.length > 0 ? issues[0].message : 'Invalid product';
  return new AppError('VALIDATION_ERROR', message, { details: { issues } });
}

/** The fields both port inputs share: the price in millimes and '' as no category. */
function productFields(values: ProductFormValues) {
  return {
    name: values.name,
    priceMillimes: tryParseTND(values.price),
    categoryId: values.categoryId === '' ? null : values.categoryId,
    barcode: values.barcode,
    description: values.description,
    imageUrl: values.imageUrl,
  };
}

/**
 * Form values as the catalog port's input for a new product; the stock typed is its opening stock.
 * Throws AppError VALIDATION_ERROR, with the Zod issues in details, when the values are not valid.
 */
export function toProductCreateInput(values: ProductFormValues): ProductCreateInput {
  const form = productFormSchema.safeParse(values);
  if (!form.success) {
    throw validationError(form.error.issues);
  }
  const input = productCreateInputSchema.safeParse({
    ...productFields(values),
    openingStock: parseStock(values.stock),
  });
  if (!input.success) {
    throw validationError(input.error.issues);
  }
  return input.data;
}

/**
 * Form values as the catalog port's changes to a product whose stock was `loadedStock` when the form
 * opened. The stock goes as `stockDelta` = typed − loaded, never as a new total, so a sale recorded
 * while the form was open still counts. Throws like `toProductCreateInput`.
 */
export function toProductUpdateInput(
  values: ProductFormValues,
  loadedStock: number,
): ProductUpdateInput {
  const form = productEditFormSchema(loadedStock).safeParse(values);
  if (!form.success) {
    throw validationError(form.error.issues);
  }
  const stock = parseStock(values.stock);
  const input = productUpdateInputSchema.safeParse({
    ...productFields(values),
    stockDelta: stock === null ? null : stock - loadedStock,
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
