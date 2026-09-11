import { supabaseEnv } from '@/lib/env';
import type { Backend } from '@/ports';
import { createSupabaseAuth, readAccessToken } from './auth';
import { createSupabaseCatalog } from './catalog';
import { getSupabaseClient } from './client';
import { createEdgeRequest } from './http';
import { createSupabaseSales } from './sales';
import { createSupabaseSettings } from './settings';

/**
 * The Supabase backend of today: Supabase Auth plus the legacy key-value edge function. Phase 3
 * replaces the edge function with tables and RPCs behind the same ports.
 */
export function createSupabaseBackend(): Backend {
  const { url, anonKey } = supabaseEnv();
  const client = getSupabaseClient();
  const request = createEdgeRequest({
    url,
    anonKey,
    getAccessToken: () => readAccessToken(client.auth),
  });

  return {
    kind: 'supabase',
    auth: createSupabaseAuth({ auth: client.auth }),
    catalog: createSupabaseCatalog(request),
    sales: createSupabaseSales(request),
    settings: createSupabaseSettings(request),
  };
}
