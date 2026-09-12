import { AppError } from '@/lib/errors';
import {
  categoryInputSchema,
  productCreateInputSchema,
  productUpdateInputSchema,
  type CatalogPort,
  type Category,
  type Product,
} from '@/ports';
import type { MemoryProfile } from './seed';
import { moveStock, type CategoryRow, type ProductRow } from './store';
import {
  freshId,
  invalidField,
  parseInput,
  parseUuid,
  perform,
  requireProfile,
  type MemoryContext,
} from './support';

/**
 * The caller's shop's products and categories, as save_product, archive_product and the categories
 * table behave: members read them, only an admin changes them. Stock changes only through
 * movements, and deleting a product archives it.
 */
export function createMemoryCatalog(context: MemoryContext): CatalogPort {
  const { store } = context;

  function productView(row: ProductRow): Product {
    return {
      id: row.id,
      name: row.name,
      priceMillimes: row.priceMillimes,
      categoryId: row.categoryId,
      categoryName:
        row.categoryId === null ? null : (store.categories.get(row.categoryId)?.name ?? null),
      barcode: row.barcode,
      description: row.description,
      imageUrl: row.imageUrl,
      stock: row.stock,
      available: row.available,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  function categoryView(row: CategoryRow): Category {
    return { id: row.id, name: row.name, color: row.color, createdAt: row.createdAt };
  }

  /** The category id to store, or VALIDATION_ERROR when the shop has no such category. */
  function categoryIdFor(profile: MemoryProfile, categoryId: string | null): string | null {
    if (categoryId === null) {
      return null;
    }
    const id = parseUuid(categoryId, 'category_id');
    if (store.categories.get(id)?.shopId !== profile.shopId) {
      throw invalidField('category_id', 'The category does not exist.');
    }
    return id;
  }

  /** As the unique index on (shop, barcode) of products that are not archived. */
  function requireFreeBarcode(
    profile: MemoryProfile,
    barcode: string,
    productId: string | null,
  ): void {
    if (barcode === '') {
      return;
    }
    for (const other of store.products.values()) {
      if (
        other.shopId === profile.shopId &&
        other.archivedAt === null &&
        other.barcode === barcode &&
        other.id !== productId
      ) {
        throw invalidField('barcode', 'Another product already uses this barcode.');
      }
    }
  }

  function liveProduct(profile: MemoryProfile, id: string): ProductRow {
    const row = store.products.get(id);
    if (!row || row.shopId !== profile.shopId || row.archivedAt !== null) {
      throw new AppError('NOT_FOUND', 'The product does not exist.', {
        details: { productId: id },
      });
    }
    return row;
  }

  return {
    listProducts: () =>
      perform(context, 'catalog.listProducts', () => {
        const profile = requireProfile(context);
        return Array.from(store.products.values())
          .filter((row) => row.shopId === profile.shopId && row.archivedAt === null)
          .map(productView);
      }),

    createProduct: (input) =>
      perform(context, 'catalog.createProduct', () => {
        const profile = requireProfile(context, ['admin']);
        const fields = parseInput(productCreateInputSchema, input);
        const categoryId = categoryIdFor(profile, fields.categoryId);
        requireFreeBarcode(profile, fields.barcode, null);
        const timestamp = context.now().toISOString();
        const row: ProductRow = {
          id: freshId(context, store.products),
          shopId: profile.shopId,
          categoryId,
          name: fields.name,
          priceMillimes: fields.priceMillimes,
          barcode: fields.barcode,
          description: fields.description,
          imageUrl: fields.imageUrl,
          stock: 0,
          available: true,
          archivedAt: null,
          createdAt: timestamp,
          updatedAt: timestamp,
        };
        store.products.set(row.id, row);
        const stocked = moveStock(store, {
          shopId: profile.shopId,
          productId: row.id,
          delta: fields.openingStock,
          reason: 'opening',
          saleId: null,
          note: '',
          createdBy: profile.userId,
          createdAt: timestamp,
        });
        return productView(stocked);
      }),

    updateProduct: (id, input) =>
      perform(context, 'catalog.updateProduct', () => {
        const profile = requireProfile(context, ['admin']);
        const productId = parseUuid(id, 'id');
        const fields = parseInput(productUpdateInputSchema, input);
        const categoryId = categoryIdFor(profile, fields.categoryId);
        const existing = liveProduct(profile, productId);
        requireFreeBarcode(profile, fields.barcode, productId);
        const timestamp = context.now().toISOString();
        // Stock, availability and createdAt stay; the delta below is the only stock change.
        store.products.set(productId, {
          ...existing,
          categoryId,
          name: fields.name,
          priceMillimes: fields.priceMillimes,
          barcode: fields.barcode,
          description: fields.description,
          imageUrl: fields.imageUrl,
          updatedAt: timestamp,
        });
        const stocked = moveStock(store, {
          shopId: profile.shopId,
          productId,
          delta: fields.stockDelta,
          reason: 'adjustment',
          saleId: null,
          note: '',
          createdBy: profile.userId,
          createdAt: timestamp,
        });
        return productView(stocked);
      }),

    deleteProduct: (id) =>
      perform(context, 'catalog.deleteProduct', () => {
        const profile = requireProfile(context, ['admin']);
        const productId = parseUuid(id, 'product_id');
        const existing = liveProduct(profile, productId);
        const timestamp = context.now().toISOString();
        store.products.set(productId, { ...existing, archivedAt: timestamp, updatedAt: timestamp });
      }),

    listCategories: () =>
      perform(context, 'catalog.listCategories', () => {
        const profile = requireProfile(context);
        return Array.from(store.categories.values())
          .filter((row) => row.shopId === profile.shopId)
          .map(categoryView);
      }),

    createCategory: (input) =>
      perform(context, 'catalog.createCategory', () => {
        const profile = requireProfile(context, ['admin']);
        // The schema trims the name. Duplicate names are allowed, as in the database.
        const fields = parseInput(categoryInputSchema, input);
        const row: CategoryRow = {
          id: freshId(context, store.categories),
          shopId: profile.shopId,
          name: fields.name,
          color: fields.color,
          createdAt: context.now().toISOString(),
        };
        store.categories.set(row.id, row);
        return categoryView(row);
      }),

    deleteCategory: (id) =>
      perform(context, 'catalog.deleteCategory', () => {
        const profile = requireProfile(context, ['admin']);
        const categoryId = parseUuid(id, 'id');
        if (store.categories.get(categoryId)?.shopId !== profile.shopId) {
          throw new AppError('NOT_FOUND', 'The category does not exist.', {
            details: { categoryId },
          });
        }
        store.categories.delete(categoryId);
        // As the foreign key's on delete set null, archived products included.
        for (const product of store.products.values()) {
          if (product.categoryId === categoryId) {
            store.products.set(product.id, { ...product, categoryId: null });
          }
        }
      }),
  };
}
