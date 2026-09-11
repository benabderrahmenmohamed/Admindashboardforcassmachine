import { z } from 'zod';
import { AppError, toAppError } from '@/lib/errors';
import { recordSaleInputSchema, recordSaleResultSchema, type SalesPort } from '@/ports';
import type { EdgeRequest } from './http';
import { millimesToDinars } from './legacyMoney';
import { parseInput, parseOutput } from './validate';

const createdOrderSchema = z.object({ order: z.object({ id: z.string().min(1) }) });

/**
 * SalesPort over the legacy order routes: create an instant order, then complete it, which records
 * the payment and decrements stock. The `total` the function computes in floating point is never
 * read.
 */
export function createSupabaseSales(request: EdgeRequest): SalesPort {
  return {
    async recordSale(input) {
      const sale = parseInput(recordSaleInputSchema, input);
      const created = await request('/orders', {
        method: 'POST',
        auth: 'user',
        body: {
          items: sale.lines.map((line) => ({
            productId: line.productId,
            name: line.name,
            price: millimesToDinars(line.unitPriceMillimes),
            quantity: line.qty,
          })),
          tableNumber: null,
          orderType: 'instant',
        },
      });
      const orderId = parseOutput(createdOrderSchema, created, 'the new order').order.id;

      try {
        await request(`/orders/${encodeURIComponent(orderId)}/complete`, {
          method: 'POST',
          auth: 'user',
          body: { paymentMethod: sale.paymentMethod },
        });
      } catch (error) {
        // Legacy limitation: the order created above stays active; the details say which one.
        const failure = toAppError(error);
        throw new AppError(failure.code, failure.message, {
          details: { ...failure.details, orderId, stage: 'complete' },
          cause: failure,
        });
      }

      return parseOutput(recordSaleResultSchema, { saleId: orderId }, 'the sale');
    },
  };
}
