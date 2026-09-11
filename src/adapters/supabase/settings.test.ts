import { describe, expect, it } from 'vitest';
import type { EdgeRequest, EdgeRequestOptions } from './http';
import { createSupabaseSettings } from './settings';

function fakeRequest(respond: (path: string, options: EdgeRequestOptions) => unknown) {
  const calls: { path: string; options: EdgeRequestOptions }[] = [];
  const request: EdgeRequest = (path, options) => {
    calls.push({ path, options });
    return Promise.resolve().then(() => respond(path, options));
  };
  return { calls, request };
}

describe('supabase settings', () => {
  it('uses the legacy default footer when none is stored', async () => {
    const { calls, request } = fakeRequest(() => ({ settings: { mode: 'table', currency: '$' } }));

    await expect(createSupabaseSettings(request).getSettings()).resolves.toEqual({
      receiptFooter: 'Thank you for your purchase!',
    });
    expect(calls).toEqual([{ path: '/settings', options: { method: 'GET', auth: 'anon' } }]);
  });

  it('keeps the legacy keys when it saves the footer', async () => {
    const stored = { mode: 'barcode', currency: 'DT', taxRate: 0, receiptFooter: 'Au revoir' };
    const { calls, request } = fakeRequest((_path, options) =>
      options.method === 'PUT' ? { settings: options.body } : { settings: stored },
    );

    const saved = await createSupabaseSettings(request).updateSettings({
      receiptFooter: 'Merci pour votre visite !',
    });

    expect(saved).toEqual({ receiptFooter: 'Merci pour votre visite !' });
    expect(calls).toEqual([
      { path: '/settings', options: { method: 'GET', auth: 'anon' } },
      {
        path: '/settings',
        options: {
          method: 'PUT',
          auth: 'user',
          body: { ...stored, receiptFooter: 'Merci pour votre visite !' },
        },
      },
    ]);
  });
});
