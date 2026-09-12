import { AppError } from '@/lib/errors';
import {
  categoryInputSchema,
  productCreateInputSchema,
  productUpdateInputSchema,
  stockAdjustmentSchema,
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
  replayOf,
  requireProfile,
  storedProductId,
  type MemoryContext,
} from './support';

/**
 * The caller's shop's menu and categories, as save_product, archive_product and the categories
 * table behave: members read them, only an admin changes them. Stock changes only through
 * movements, and deleting a product archives it.
 *
 * Every change tells the shop's 'products' topic, so a waiter's menu and the caisse follow a price
 * or an availability change without reloading; a category change moves the menu too.
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
      isAvailable: row.isAvailable,
      trackStock: row.trackStock,
      stockQty: row.stockQty,
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
          stockQty: 0,
          isAvailable: fields.isAvailable,
          trackStock: fields.trackStock,
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
        context.emit(profile.shopId, 'products');
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
        // Stock and createdAt stay; the delta below is the only stock change.
        store.products.set(productId, {
          ...existing,
          categoryId,
          name: fields.name,
          priceMillimes: fields.priceMillimes,
          barcode: fields.barcode,
          description: fields.description,
          imageUrl: fields.imageUrl,
          isAvailable: fields.isAvailable,
          trackStock: fields.trackStock,
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
        context.emit(profile.shopId, 'products');
        return productView(stocked);
      }),

    setAvailability: (productId, isAvailable) =>
      perform(context, 'catalog.setAvailability', () => {
        // The floor uses this: a dish runs out and leaves the menu without anyone touching a price.
        const profile = requireProfile(context, ['admin', 'cashier', 'waiter']);
        const id = parseUuid(productId, 'product_id');
        const existing = liveProduct(profile, id);
        const row: ProductRow = {
          ...existing,
          isAvailable,
          updatedAt: context.now().toISOString(),
        };
        store.products.set(id, row);
        context.emit(profile.shopId, 'products');
        return productView(row);
      }),

    adjustStock: (adjustment) =>
      perform(context, 'catalog.adjustStock', () => {
        const profile = requireProfile(context, ['admin']);
        const input = parseInput(stockAdjustmentSchema, adjustment);
        const id = parseUuid(input.id, 'id');
        const replay = replayOf(store, profile, 'stock_adjustment', id, input.payloadHash);
        if (replay) {
          return {
            status: 'replayed' as const,
            productId: storedProductId(replay),
            stockQty: replay.stockQty ?? 0,
          };
        }
        const existing = liveProduct(profile, parseUuid(input.productId, 'product_id'));
        const timestamp = context.now().toISOString();
        const moved = moveStock(store, {
          shopId: profile.shopId,
          productId: existing.id,
          delta: input.qtyDelta,
          reason: 'adjustment',
          saleId: null,
          note: input.reason,
          createdBy: profile.userId,
          createdAt: timestamp,
        });
        store.orderRecords.set(id, {
          id,
          shopId: profile.shopId,
          kind: 'stock_adjustment',
          deviceId: '',
          payloadHash: input.payloadHash,
          orderId: null,
          itemId: null,
          affected: 1,
          productId: moved.id,
          stockQty: moved.stockQty,
          receivedAt: timestamp,
        });
        context.emit(profile.shopId, 'products');
        return { status: 'created' as const, productId: moved.id, stockQty: moved.stockQty };
      }),

    deleteProduct: (id) =>
      perform(context, 'catalog.deleteProduct', () => {
        const profile = requireProfile(context, ['admin']);
        const productId = parseUuid(id, 'product_id');
        const existing = liveProduct(profile, productId);
        const timestamp = context.now().toISOString();
        store.products.set(productId, { ...existing, archivedAt: timestamp, updatedAt: timestamp });
        context.emit(profile.shopId, 'products');
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
        context.emit(profile.shopId, 'products');
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
        context.emit(profile.shopId, 'products');
      }),
  };
}
