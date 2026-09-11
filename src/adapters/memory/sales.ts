import { add, mulQty } from '@/lib/money';
import { recordSaleInputSchema, type Product, type SalesPort } from '@/ports';
import type { MemoryStore } from './store';
import { authorize, freshId, notFound, parseInput, perform, type MemoryContext } from './support';

/** Any signed-in user may record a sale, as on the legacy order routes. */
export function createMemorySales(context: MemoryContext, store: MemoryStore): SalesPort {
  return {
    recordSale: (input) =>
      perform(context, 'sales.recordSale', () => {
        authorize(store);
        const { lines, paymentMethod } = parseInput(recordSaleInputSchema, input);

        // Work out every change before applying any, so a rejected sale leaves the store as it was.
        const restocked = new Map<string, Product>();
        for (const line of lines) {
          const product = restocked.get(line.productId) ?? store.products.get(line.productId);
          if (!product) {
            throw notFound('Product', line.productId);
          }
          // Legacy behaviour: stock never goes below zero and a sold-out product is unavailable.
          const stock = Math.max(0, product.stock - line.qty);
          restocked.set(line.productId, { ...product, stock, available: stock > 0 });
        }
        const totalMillimes = add(...lines.map((line) => mulQty(line.unitPriceMillimes, line.qty)));
        const saleId = freshId(context, store.sales);
        const createdAt = context.now().toISOString();

        for (const [productId, product] of restocked) {
          store.products.set(productId, product);
        }
        store.sales.set(saleId, { id: saleId, lines, paymentMethod, createdAt, totalMillimes });
        return { saleId };
      }),
  };
}
