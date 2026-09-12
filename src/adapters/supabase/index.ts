import type { Backend } from '@/ports';
import { createSupabaseAuth, type StorageLike } from './auth';
import { createSupabaseCatalog } from './catalog';
import { getSupabaseClient, type SupabaseDatabaseClient } from './client';
import { createSupabaseOrders } from './orders';
import { readMyProfile } from './profile';
import { createSupabaseRealtime } from './realtime';
import { createSupabaseSales } from './sales';
import { createSupabaseSessions } from './sessions';
import { createSupabaseSettings } from './settings';
import { createSupabaseTerminals } from './terminals';

export { supabaseAuthStorageKey } from './client';
export type { SupabaseDatabaseClient } from './client';
export type { StorageLike } from './auth';

export interface SupabaseBackendOptions {
  /**
   * The client every port uses. Default: the app's client, from VITE_SUPABASE_URL and
   * VITE_SUPABASE_ANON_KEY. Tests pass their own, one per signed-in user.
   */
  readonly client?: SupabaseDatabaseClient;
  /**
   * Where `client` keeps its session, and where the last signed-in member is kept for offline
   * starts. Default: localStorage, as for the app's client.
   */
  readonly storage?: () => StorageLike;
  /**
   * The storage key `client` keeps its session under (its `auth.storageKey`). Default: the app's
   * client's key. Pass it with an injected client that signs out or starts offline.
   */
  readonly sessionStorageKey?: string;
}

/**
 * The Supabase backend: Supabase Auth, and the tables and RPCs of supabase/migrations behind every
 * port. Row-level security and the RPCs' own checks decide what the signed-in member may do; a
 * request without a session goes out with the anon key, which may do nothing (UNAUTHENTICATED).
 */
export function createSupabaseBackend(options: SupabaseBackendOptions = {}): Backend {
  const client = options.client ?? getSupabaseClient();

  return {
    kind: 'supabase',
    auth: createSupabaseAuth({
      auth: client.auth,
      readProfile: () => readMyProfile(client),
      storage: options.storage,
      sessionStorageKey: options.sessionStorageKey,
    }),
    catalog: createSupabaseCatalog(client),
    orders: createSupabaseOrders(client),
    realtime: createSupabaseRealtime(client),
    sales: createSupabaseSales(client),
    sessions: createSupabaseSessions(client),
    settings: createSupabaseSettings(client),
    terminals: createSupabaseTerminals(client),
  };
}
