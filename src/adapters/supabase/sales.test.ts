import { describe, expect, it } from 'vitest';
import { AppError } from '@/lib/errors';
import { mm } from '@/lib/money';
import type { EdgeRequest, EdgeRequestOptions } from './http';
import { createSupabaseSales } from './sales';

function fakeRequest(respond: (path: string, options: EdgeRequestOptions) => unknown) {
  const calls: { path: string; options: EdgeRequestOptions }[] = [];
  const request: EdgeRequest = (path, options) => {
    calls.push({ path, options });
    return Promise.resolve().then(() => respond(path, options));
  };
  return { calls, request };
}

const lines = [
  { productId: 'p-water', name: 'Eau minérale 1,5 L', qty: 2, unitPriceMillimes: mm(850) },
  { productId: 'p-harissa', name: 'Harissa', qty: 1, unitPriceMillimes: mm(2400) },
];

describe('supabase sales', () => {
  it('creates an instant order with dinar prices, then completes it with the payment method', async () => {
    const { calls, request } = fakeRequest((path) =>
      path === '/orders'
        ? { order: { id: 'o-1', total: 4.1000000000000005 } }
        : { order: { id: 'o-1', status: 'completed' } },
    );

    const result = await createSupabaseSales(request).recordSale({ lines, paymentMethod: 'card' });

    expect(result).toEqual({ saleId: 'o-1' });
    expect(calls).toEqual([
      {
        path: '/orders',
        options: {
          method: 'POST',
          auth: 'user',
          body: {
            items: [
              { productId: 'p-water', name: 'Eau minérale 1,5 L', price: 0.85, quantity: 2 },
              { productId: 'p-harissa', name: 'Harissa', price: 2.4, quantity: 1 },
            ],
            tableNumber: null,
            orderType: 'instant',
          },
        },
      },
      {
        path: '/orders/o-1/complete',
        options: { method: 'POST', auth: 'user', body: { paymentMethod: 'card' } },
      },
    ]);
  });

  it('names the order left active when completing it fails', async () => {
    const { request } = fakeRequest((path) => {
      if (path === '/orders') {
        return { order: { id: 'o-2' } };
      }
      throw new AppError('SERVER_ERROR', 'Error: stock update failed', {
        details: { status: 500 },
      });
    });

    const error: unknown = await createSupabaseSales(request)
      .recordSale({ lines, paymentMethod: 'cash' })
      .then(
        () => null,
        (failure: unknown) => failure,
      );

    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({
      code: 'SERVER_ERROR',
      message: 'Error: stock update failed',
      details: { status: 500, orderId: 'o-2', stage: 'complete' },
    });
  });

  it('sends nothing for a sale without lines', async () => {
    const { calls, request } = fakeRequest(() => ({}));

    const error: unknown = await createSupabaseSales(request)
      .recordSale({ lines: [], paymentMethod: 'cash' })
      .then(
        () => null,
        (failure: unknown) => failure,
      );

    expect(error).toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(calls).toEqual([]);
  });
});
