import { describe, expect, it } from 'vitest';
import { fakeSupabase, json, profileJson, routes } from './fakeSupabase';
import { createSupabaseBackend } from './index';

describe('createSupabaseBackend', () => {
  it('builds every port around an injected client', async () => {
    const { client, calls } = fakeSupabase(
      routes({
        'POST /rest/v1/rpc/my_profile': () => json(profileJson('admin')),
        'GET /rest/v1/shop_settings': () => json([{ receipt_footer: 'Merci !' }]),
      }),
    );

    const backend = createSupabaseBackend({ client });

    expect(backend.kind).toBe('supabase');
    expect(Object.keys(backend).sort()).toEqual([
      'auth',
      'catalog',
      'kind',
      'orders',
      'realtime',
      'sales',
      'sessions',
      'settings',
      'terminals',
    ]);
    await expect(backend.settings.getSettings()).resolves.toEqual({ receiptFooter: 'Merci !' });
    expect(calls.map((call) => call.path)).toEqual(['/rest/v1/shop_settings']);
  });
});
