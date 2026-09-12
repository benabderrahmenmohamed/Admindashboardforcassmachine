import { describe, expect, it } from 'vitest';
import {
  failureOf,
  fakeSupabase,
  json,
  profileJson,
  routes,
  type FakeHandler,
} from './fakeSupabase';
import { createSupabaseSettings } from './settings';

function setup(handler: FakeHandler) {
  const { client, calls } = fakeSupabase(handler);
  return { calls, settings: createSupabaseSettings(client) };
}

describe('supabase settings', () => {
  it('reads the receipt footer of the shop', async () => {
    const { calls, settings } = setup(
      routes({
        'GET /rest/v1/shop_settings': () => json([{ receipt_footer: 'Merci pour votre visite !' }]),
      }),
    );

    await expect(settings.getSettings()).resolves.toEqual({
      receiptFooter: 'Merci pour votre visite !',
    });
    expect(calls[0].query.get('select')).toBe('receipt_footer');
  });

  it('shows the column default while the shop has no settings row', async () => {
    const { settings } = setup(() => json([]));

    await expect(settings.getSettings()).resolves.toEqual({
      receiptFooter: 'Thank you for your purchase!',
    });
  });

  it('still loads a footer longer than the limit for new ones', async () => {
    const long = 'Merci ! '.repeat(80);
    const { settings } = setup(() => json([{ receipt_footer: long }]));

    await expect(settings.getSettings()).resolves.toEqual({ receiptFooter: long });
  });

  it('saves the footer as an admin, on the admin’s own shop', async () => {
    const { calls, settings } = setup(
      routes({
        'POST /rest/v1/rpc/my_profile': () => json(profileJson('admin')),
        'PATCH /rest/v1/shop_settings': (call) => json([call.body]),
      }),
    );

    const saved = await settings.updateSettings({ receiptFooter: 'À bientôt' });

    const patch = calls.find((call) => call.method === 'PATCH');
    expect(patch?.body).toEqual({ receipt_footer: 'À bientôt' });
    expect(patch?.query.get('shop_id')).toBe('eq.shop-1');
    expect(patch?.query.get('select')).toBe('receipt_footer');
    expect(saved).toEqual({ receiptFooter: 'À bientôt' });
  });

  it('refuses a cashier before sending the update', async () => {
    const { calls, settings } = setup(
      routes({ 'POST /rest/v1/rpc/my_profile': () => json(profileJson('cashier')) }),
    );

    const error = await failureOf(settings.updateSettings({ receiptFooter: 'À bientôt' }));

    expect(error.code).toBe('FORBIDDEN');
    expect(calls.some((call) => call.method === 'PATCH')).toBe(false);
  });

  it('reports NOT_FOUND when the shop has no settings row to update', async () => {
    const { settings } = setup(
      routes({
        'POST /rest/v1/rpc/my_profile': () => json(profileJson('admin')),
        'PATCH /rest/v1/shop_settings': () => json([]),
      }),
    );

    const error = await failureOf(settings.updateSettings({ receiptFooter: 'À bientôt' }));

    expect(error).toMatchObject({ code: 'NOT_FOUND', details: { shopId: 'shop-1' } });
  });

  it('rejects a new footer over 500 characters without sending anything', async () => {
    const { calls, settings } = setup(() => json([]));

    const error = await failureOf(settings.updateSettings({ receiptFooter: 'x'.repeat(501) }));

    expect(error.code).toBe('VALIDATION_ERROR');
    expect(calls).toEqual([]);
  });
});
