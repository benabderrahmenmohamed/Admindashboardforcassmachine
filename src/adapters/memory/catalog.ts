import {
  categoryInputSchema,
  productInputSchema,
  type CatalogPort,
  type Category,
  type Product,
} from '@/ports';
import type { MemoryStore } from './store';
import { authorize, freshId, notFound, parseInput, perform, type MemoryContext } from './support';

/**
 * Products and categories with the legacy edge function's behaviour, as the UI sees it. Anyone may
 * list them; only an admin may change them, as on the legacy product and category routes.
 */
export function createMemoryCatalog(context: MemoryContext, store: MemoryStore): CatalogPort {
  function existingProduct(id: string): Product {
    const product = store.products.get(id);
    if (!product) {
      throw notFound('Product', id);
    }
    return product;
  }

  function categoryNameFor(categoryId: string | null): string | null {
    if (categoryId === null) {
      return null;
    }
    const category = store.categories.get(categoryId);
    if (!category) {
      throw notFound('Category', categoryId);
    }
    return category.name;
  }

  return {
    listProducts: () =>
      perform(context, 'catalog.listProducts', () =>
        Array.from(store.products.values(), (product) => structuredClone(product)),
      ),

    createProduct: (input) =>
      perform(context, 'catalog.createProduct', () => {
        authorize(store, ['admin']);
        const fields = parseInput(productInputSchema, input);
        const categoryName = categoryNameFor(fields.categoryId);
        const timestamp = context.now().toISOString();
        const product: Product = {
          id: freshId(context, store.products),
          name: fields.name,
          priceMillimes: fields.priceMillimes,
          categoryId: fields.categoryId,
          categoryName,
          barcode: fields.barcode,
          description: fields.description,
          imageUrl: fields.imageUrl,
          stock: fields.stock,
          available: true,
          createdAt: timestamp,
          updatedAt: timestamp,
        };
        store.products.set(product.id, product);
        return structuredClone(product);
      }),

    updateProduct: (id, input) =>
      perform(context, 'catalog.updateProduct', () => {
        authorize(store, ['admin']);
        const fields = parseInput(productInputSchema, input);
        const existing = existingProduct(id);
        // id, available and createdAt stay; everything the form edits is replaced.
        const product: Product = {
          ...existing,
          name: fields.name,
          priceMillimes: fields.priceMillimes,
          categoryId: fields.categoryId,
          categoryName: categoryNameFor(fields.categoryId),
          barcode: fields.barcode,
          description: fields.description,
          imageUrl: fields.imageUrl,
          stock: fields.stock,
          updatedAt: context.now().toISOString(),
        };
        store.products.set(id, product);
        return structuredClone(product);
      }),

    deleteProduct: (id) =>
      perform(context, 'catalog.deleteProduct', () => {
        authorize(store, ['admin']);
        existingProduct(id);
        store.products.delete(id);
      }),

    listCategories: () =>
      perform(context, 'catalog.listCategories', () =>
        Array.from(store.categories.values(), (category) => structuredClone(category)),
      ),

    createCategory: (input) =>
      perform(context, 'catalog.createCategory', () => {
        authorize(store, ['admin']);
        // The schema trims the name. Duplicate names are allowed, as in the legacy backend.
        const fields = parseInput(categoryInputSchema, input);
        const category: Category = {
          id: freshId(context, store.categories),
          name: fields.name,
          color: fields.color,
          createdAt: context.now().toISOString(),
        };
        store.categories.set(category.id, category);
        return structuredClone(category);
      }),

    deleteCategory: (id) =>
      perform(context, 'catalog.deleteCategory', () => {
        authorize(store, ['admin']);
        if (!store.categories.has(id)) {
          throw notFound('Category', id);
        }
        store.categories.delete(id);
        for (const product of store.products.values()) {
          if (product.categoryId === id) {
            store.products.set(product.id, { ...product, categoryId: null, categoryName: null });
          }
        }
      }),
  };
}
