/**
 * The port contract against the local Supabase stack, with supabase/seed.sql loaded
 * (`npm run db:start`, then `npm run db:reset`).
 *
 * Runs only with CONTRACT_BACKEND=supabase and is skipped otherwise. It reads:
 *   SUPABASE_URL               the local API URL, http://127.0.0.1:54321 by default (`supabase status`)
 *   SUPABASE_ANON_KEY          the anon key from `supabase status`
 *   SUPABASE_SERVICE_ROLE_KEY  not used here; security.test.ts, which runs under the same flag, needs it
 * and signs in the seeded accounts of shop A: admin@demo.local and cashier@demo.local. Every test
 * registers terminals under new random codes, so runs never share receipt numbering, and leaves its
 * products, sessions and sales behind in the local database.
 */
import { createClient } from '@supabase/supabase-js';
import { describe, vi } from 'vitest';
import type { AuthUser, Backend } from '@/ports';
import {
  contractBackendIs,
  describeBackendContract,
  freshTerminalCode,
  requireTestEnv,
  type ContractFixture,
} from '@/ports/__contracts__';
import type { Database } from './database.types';
import { createSupabaseBackend, type StorageLike } from './index';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

/** Storage for one client's session, in this process only. */
function memoryStorage(): StorageLike {
  const items = new Map<string, string>();
  return {
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => {
      items.set(key, value);
    },
    removeItem: (key) => {
      items.delete(key);
    },
  };
}

/** A backend with a client of its own, signed in as `email`. */
async function member(
  email: string,
  password: string,
): Promise<{ readonly backend: Backend; readonly user: AuthUser }> {
  const storage = memoryStorage();
  const storageKey = `contract-${email}`;
  const client = createClient<Database>(
    requireTestEnv('SUPABASE_URL'),
    requireTestEnv('SUPABASE_ANON_KEY'),
    {
      auth: {
        persistSession: true,
        autoRefreshToken: false,
        detectSessionInUrl: false,
        storage,
        storageKey,
      },
    },
  );
  const backend = createSupabaseBackend({
    client,
    storage: () => storage,
    sessionStorageKey: storageKey,
  });
  const user = await backend.auth.signIn({ email, password });
  return { backend, user };
}

async function makeFixture(): Promise<ContractFixture> {
  const admin = await member('admin@demo.local', 'demo-admin-2026');
  const cashier = await member('cashier@demo.local', 'demo-cashier-2026');
  return {
    admin: admin.backend,
    cashier: cashier.backend,
    adminUser: admin.user,
    cashierUser: cashier.user,
    newTerminalCode: freshTerminalCode,
  };
}

describe.runIf(contractBackendIs('supabase'))('Supabase backend', () => {
  describeBackendContract(makeFixture);
});
