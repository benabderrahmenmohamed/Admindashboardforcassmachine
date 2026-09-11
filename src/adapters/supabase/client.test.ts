import { createClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';
import { AppError } from '@/lib/errors';
import { supabaseAuthStorageKey } from './client';

function thrownBy(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  return expect.unreachable('expected a throw');
}

describe('supabaseAuthStorageKey', () => {
  it.each<[string, string]>([
    ['https://abcdefghijklmnop.supabase.co', 'sb-abcdefghijklmnop-auth-token'],
    ['http://127.0.0.1:54321', 'sb-127-auth-token'],
  ])('keys the session of %s as %s', (url, key) => {
    expect(supabaseAuthStorageKey(url)).toBe(key);
  });

  it('is the key supabase-js reads by default, so sessions stored before carry over', async () => {
    const url = 'https://abcdefghijklmnop.supabase.co';
    const getItem = vi.fn<(key: string) => string | null>(() => null);
    const client = createClient(url, 'anon-key', {
      auth: {
        storage: { getItem, setItem: () => undefined, removeItem: () => undefined },
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
    });

    await client.auth.getSession();

    expect(getItem).toHaveBeenCalledWith(supabaseAuthStorageKey(url));
  });

  it('turns a malformed URL into CONFIG_ERROR', () => {
    const error = thrownBy(() => supabaseAuthStorageKey('not a url'));

    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({ code: 'CONFIG_ERROR' });
  });
});
