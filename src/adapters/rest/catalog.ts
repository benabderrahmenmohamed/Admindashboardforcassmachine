import { z } from 'zod';
import { parseOrInvalid } from '@/lib/validation';
import {
  categoryInputSchema,
  categorySchema,
  productCreateInputSchema,
  productSchema,
  productUpdateInputSchema,
  stockAdjustmentResultSchema,
  stockAdjustmentSchema,
  type CatalogPort,
} from '@/ports';
import type { RestClient } from './http';
import { pathSegment } from './paths';
import {
  fromWire,
  toWire,
  type WireCategoryCreate,
  type WireProductAvailability,
  type WireProductCreate,
  type WireProductUpdate,
  type WireStockAdjustment,
} from './wire';
import { checkWriteOutcome } from './writes';

const productsSchema = z.array(productSchema);
const categoriesSchema = z.array(categorySchema);

/**
 * CatalogPort over /products and /categories. Input is checked here so a call the contract already
 * refuses never leaves the device; everything else — who may write, whether a product exists, how
 * stock moves — is the server's decision, and arrives as its code.
 */
export function createRestCatalog(client: RestClient): CatalogPort {
  return {
    async listProducts() {
      const response = await client.request('GET', '/products');
      return fromWire(productsSchema, response.body, 'the products');
    },

    async createProduct(input) {
      const fields = parseOrInvalid(productCreateInputSchema, input, 'the product');
      const response = await client.request('POST', '/products', {
        body: toWire<WireProductCreate>(fields),
      });
      return fromWire(productSchema, response.body, 'the created product');
    },

    async updateProduct(id, input) {
      const fields = parseOrInvalid(productUpdateInputSchema, input, 'the product');
      const response = await client.request(
        'PUT',
        `/products/${pathSegment(id, 'the product id')}`,
        {
          body: toWire<WireProductUpdate>(fields),
        },
      );
      return fromWire(productSchema, response.body, 'the saved product');
    },

    async deleteProduct(id) {
      await client.request('DELETE', `/products/${pathSegment(id, 'the product id')}`);
    },

    async setAvailability(productId, isAvailable) {
      // Its own path rather than an edit: the daily sold-out toggle belongs to the floor as well as
      // to the admin, and it must touch nothing else about the product.
      const response = await client.request(
        'PUT',
        `/products/${pathSegment(productId, 'the product id')}/availability`,
        { body: toWire<WireProductAvailability>({ isAvailable }) },
      );
      return fromWire(productSchema, response.body, 'the product');
    },

    async adjustStock(adjustment) {
      const record = parseOrInvalid(stockAdjustmentSchema, adjustment, 'the stock correction');
      const response = await client.request('POST', '/stock-adjustments', {
        body: toWire<WireStockAdjustment>(record),
      });
      const result = fromWire(stockAdjustmentResultSchema, response.body, 'the stock correction');
      // A correction is a record like any other: 201 counted it now, 200 says it was already counted.
      checkWriteOutcome(response.status, result.status, 'created', 'a stock correction');
      return result;
    },

    async listCategories() {
      const response = await client.request('GET', '/categories');
      return fromWire(categoriesSchema, response.body, 'the categories');
    },

    async createCategory(input) {
      const fields = parseOrInvalid(categoryInputSchema, input, 'the category');
      const response = await client.request('POST', '/categories', {
        body: toWire<WireCategoryCreate>(fields),
      });
      return fromWire(categorySchema, response.body, 'the created category');
    },

    async deleteCategory(id) {
      await client.request('DELETE', `/categories/${pathSegment(id, 'the category id')}`);
    },
  };
}
