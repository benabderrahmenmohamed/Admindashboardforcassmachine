import { z } from 'zod';
import { AppError, toAppError } from '@/lib/errors';
import type { Millimes } from '@/lib/money';
import {
  categoryInputSchema,
  categorySchema,
  productInputSchema,
  productSchema,
  type CatalogPort,
  type Category,
  type Product,
  type ProductInput,
} from '@/ports';
import type { EdgeRequest } from './http';
import { dinarsToMillimes, millimesToDinars } from './legacyMoney';
import { describeValue, parseInput, parseOutput } from './validate';

/** A value from the key-value store, as loosely typed as the edge function leaves it. */
type LegacyRow = Record<string, unknown>;

const rowSchema = z.record(z.string(), z.unknown());
const productListSchema = z.object({ products: z.array(rowSchema) });
const productBodySchema = z.object({ product: rowSchema });
const categoryListSchema = z.object({ categories: z.array(rowSchema) });
const categoryBodySchema = z.object({ category: rowSchema });

/** What the product routes store. Price (dinars) and stock go out as JSON numbers. */
export interface LegacyProductBody {
  readonly name: string;
  readonly price: number;
  /** The category's name: legacy products refer to categories by name, not id. */
  readonly category: string;
  readonly barcode: string;
  readonly description: string;
  readonly image: string;
  readonly stock: number;
}

/** The colour the legacy create route gives a category sent without one. */
const LEGACY_DEFAULT_COLOR = '#3b82f6';

function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function rowId(row: LegacyRow, what: string): string {
  const id = row.id;
  if (typeof id !== 'string' || id === '') {
    throw new AppError('VALIDATION_ERROR', `The server sent ${what} without an id`, {
      details: { row },
    });
  }
  return id;
}

function toPrice(value: unknown, productId: string, name: string): Millimes {
  try {
    return dinarsToMillimes(value);
  } catch (error) {
    const failure = toAppError(error);
    const product = name === '' ? productId : `"${name}" (${productId})`;
    throw new AppError(
      failure.code,
      `Product ${product} has a price the app cannot read: ${describeValue(value)}. ` +
        'Store it as dinars with at most 3 decimals.',
      { details: { productId, price: value }, cause: failure },
    );
  }
}

/**
 * Whole numbers, or their text after an edit through the old form ("12", or "12.0" from a number
 * input); anything else shows as 0.
 */
function toStock(value: unknown, productId: string): number {
  const candidate =
    typeof value === 'string' && /^-?\d+(?:\.0+)?$/.test(value.trim())
      ? Number(value.trim())
      : value;
  if (typeof candidate === 'number' && Number.isSafeInteger(candidate)) {
    return candidate === 0 ? 0 : candidate;
  }
  console.warn(
    `Product ${productId} has a stock of ${describeValue(value)}, which is not a whole number; showing 0`,
  );
  return 0;
}

export function toProduct(row: LegacyRow, categories: readonly Category[]): Product {
  const id = rowId(row, 'a product');
  const name = text(row.name);
  const category = row.category;
  const categoryName = typeof category === 'string' && category !== '' ? category : null;
  return parseOutput(
    productSchema,
    {
      id,
      name,
      priceMillimes: toPrice(row.price, id, name),
      categoryId:
        categoryName === null
          ? null
          : (categories.find((candidate) => candidate.name === categoryName)?.id ?? null),
      categoryName,
      barcode: text(row.barcode),
      description: text(row.description),
      imageUrl: text(row.image),
      stock: toStock(row.stock, id),
      available: row.available !== false,
      createdAt: text(row.createdAt),
      updatedAt: text(row.updatedAt, text(row.createdAt)),
    },
    `product ${id}`,
  );
}

export function toCategory(row: LegacyRow): Category {
  const id = rowId(row, 'a category');
  return parseOutput(
    categorySchema,
    {
      id,
      name: text(row.name),
      color: text(row.color, LEGACY_DEFAULT_COLOR),
      createdAt: text(row.createdAt),
    },
    `category ${id}`,
  );
}

export function toLegacyProductBody(
  input: ProductInput,
  categories: readonly Category[],
): LegacyProductBody {
  let category = '';
  if (input.categoryId !== null) {
    const match = categories.find((candidate) => candidate.id === input.categoryId);
    if (match) {
      category = match.name;
    } else {
      console.warn(
        `Category ${input.categoryId} does not exist; saving the product without a category`,
      );
    }
  }
  return {
    name: input.name,
    price: millimesToDinars(input.priceMillimes),
    category,
    barcode: input.barcode,
    description: input.description,
    image: input.imageUrl,
    stock: input.stock,
  };
}

/**
 * Every product of the list, or one error naming every product that cannot be read, so they can all
 * be corrected at once.
 */
function toProducts(rows: readonly LegacyRow[], categories: readonly Category[]): Product[] {
  const products: Product[] = [];
  const failures: AppError[] = [];
  for (const row of rows) {
    try {
      products.push(toProduct(row, categories));
    } catch (error) {
      // Collected and thrown together below.
      failures.push(toAppError(error));
    }
  }
  if (failures.length === 1) {
    throw failures[0];
  }
  if (failures.length > 1) {
    throw new AppError(
      'VALIDATION_ERROR',
      `${failures.length} products cannot be read. ${failures.map((failure) => failure.message).join(' ')}`,
      {
        details: {
          failures: failures.map(({ code, message, details }) => ({ code, message, details })),
        },
      },
    );
  }
  return products;
}

/** CatalogPort over the legacy edge function: public reads with the anon key, writes as the user. */
export function createSupabaseCatalog(request: EdgeRequest): CatalogPort {
  async function listCategories(): Promise<Category[]> {
    const body = await request('/categories', { method: 'GET', auth: 'anon' });
    return parseOutput(categoryListSchema, body, 'the category list').categories.map((row) =>
      toCategory(row),
    );
  }

  async function saveProduct(
    path: string,
    method: 'POST' | 'PUT',
    input: ProductInput,
  ): Promise<Product> {
    const product = parseInput(productInputSchema, input);
    // Needed twice: the name to send for the category id, and the id for the name that comes back.
    const categories = await listCategories();
    const body = await request(path, {
      method,
      auth: 'user',
      body: toLegacyProductBody(product, categories),
    });
    return toProduct(parseOutput(productBodySchema, body, 'the saved product').product, categories);
  }

  return {
    async listProducts() {
      const [body, categories] = await Promise.all([
        request('/products', { method: 'GET', auth: 'anon' }),
        listCategories(),
      ]);
      return toProducts(
        parseOutput(productListSchema, body, 'the product list').products,
        categories,
      );
    },

    createProduct(input) {
      return saveProduct('/products', 'POST', input);
    },

    updateProduct(id, input) {
      return saveProduct(`/products/${encodeURIComponent(id)}`, 'PUT', input);
    },

    async deleteProduct(id) {
      await request(`/products/${encodeURIComponent(id)}`, { method: 'DELETE', auth: 'user' });
    },

    listCategories,

    async createCategory(input) {
      const category = parseInput(categoryInputSchema, input);
      const body = await request('/categories', {
        method: 'POST',
        auth: 'user',
        body: { name: category.name, color: category.color },
      });
      return toCategory(parseOutput(categoryBodySchema, body, 'the saved category').category);
    },

    async deleteCategory(id) {
      await request(`/categories/${encodeURIComponent(id)}`, { method: 'DELETE', auth: 'user' });
    },
  };
}
