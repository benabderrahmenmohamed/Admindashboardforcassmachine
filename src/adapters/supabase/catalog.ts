import { AppError } from '@/lib/errors';
import {
  categoryInputSchema,
  categorySchema,
  productCreateInputSchema,
  productSchema,
  productUpdateInputSchema,
  type CatalogPort,
  type Category,
  type Product,
} from '@/ports';
import type { SupabaseDatabaseClient } from './client';
import type { Tables } from './database.types';
import { unwrap } from './errors';
import { requireAdmin } from './profile';
import { parseInput, parseOutput } from './validate';
import { fromWire, toWire } from './wire';

const PRODUCT_COLUMNS = '*, categories(name)';
const CATEGORY_COLUMNS = 'id, name, color, created_at';

type ProductRow = Tables<'products'> & {
  readonly categories: { readonly name: string } | null;
};

type CategoryRow = Pick<Tables<'categories'>, 'id' | 'name' | 'color' | 'created_at'>;

function toProduct(row: ProductRow): Product {
  return parseOutput(
    productSchema,
    {
      id: row.id,
      name: row.name,
      priceMillimes: row.price_millimes,
      categoryId: row.category_id,
      categoryName: row.categories?.name ?? null,
      barcode: row.barcode ?? '',
      description: row.description,
      imageUrl: row.image_url,
      stock: row.stock,
      available: row.available,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    },
    `product ${row.id}`,
  );
}

function toCategory(row: CategoryRow): Category {
  return parseOutput(
    categorySchema,
    { id: row.id, name: row.name, color: row.color, createdAt: row.created_at },
    `category ${row.id}`,
  );
}

/**
 * CatalogPort over the products and categories tables. Products are written only by save_product
 * and archive_product, which keep stock in the movement log; categories are plain rows.
 */
export function createSupabaseCatalog(client: SupabaseDatabaseClient): CatalogPort {
  /** Creates the product when `fields` has no id; `stockDelta` becomes its stock movement. */
  async function saveProduct(fields: object): Promise<Product> {
    const data = await unwrap(client.rpc('save_product', { p: toWire(fields) }));
    return fromWire(productSchema, data, 'the saved product');
  }

  return {
    async listProducts() {
      const rows = await unwrap(
        client
          .from('products')
          .select(PRODUCT_COLUMNS)
          .is('archived_at', null)
          .order('created_at')
          .order('id'),
      );
      return rows.map((row) => toProduct(row));
    },

    async createProduct(input) {
      const { openingStock, ...fields } = parseInput(productCreateInputSchema, input);
      return saveProduct({ ...fields, stockDelta: openingStock });
    },

    async updateProduct(id, input) {
      const fields = parseInput(productUpdateInputSchema, input);
      return saveProduct({ id, ...fields });
    },

    async deleteProduct(id) {
      await unwrap(client.rpc('archive_product', { p_product_id: id }));
    },

    async listCategories() {
      const rows = await unwrap(
        client.from('categories').select(CATEGORY_COLUMNS).order('created_at').order('id'),
      );
      return rows.map((row) => toCategory(row));
    },

    async createCategory(input) {
      const { name, color } = parseInput(categoryInputSchema, input);
      const row = await unwrap(
        client.from('categories').insert({ name, color }).select(CATEGORY_COLUMNS).single(),
      );
      return toCategory(row);
    },

    async deleteCategory(id) {
      await requireAdmin(client);
      const deleted = await unwrap(client.from('categories').delete().eq('id', id).select('id'));
      if (deleted.length === 0) {
        throw new AppError('NOT_FOUND', 'The category does not exist.', {
          details: { categoryId: id },
        });
      }
    },
  };
}
