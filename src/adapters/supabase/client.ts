import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { supabaseEnv } from '@/lib/env';
import { AppError } from '@/lib/errors';
import type { Database } from './database.types';

/** A Supabase client typed with the tables and RPCs of supabase/migrations. */
export type SupabaseDatabaseClient = SupabaseClient<Database>;

let client: SupabaseDatabaseClient | undefined;

/**
 * The localStorage key of the Supabase session for the project at `url`. It is set on the client
 * explicitly because the auth adapter reads and removes the session under it when auth-js cannot,
 * offline. The value is the one supabase-js derives by default (`sb-<project-ref>-auth-token`), so
 * devices signed in today stay signed in and no live refresh token is left under an unread key.
 */
export function supabaseAuthStorageKey(url: string): string {
  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch (error) {
    throw new AppError('CONFIG_ERROR', `VITE_SUPABASE_URL is not a valid URL: "${url}".`, {
      cause: error,
    });
  }
  return `sb-${hostname.split('.')[0]}-auth-token`;
}

/**
 * The app's only Supabase client. It is created on first use, so a missing environment variable
 * fails when the Supabase backend is built, never when a module is imported. Tests build their own
 * client and hand it to createSupabaseBackend instead.
 */
export function getSupabaseClient(): SupabaseDatabaseClient {
  if (client === undefined) {
    const { url, anonKey } = supabaseEnv();
    client = createClient<Database>(url, anonKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        storageKey: supabaseAuthStorageKey(url),
      },
    });
  }
  return client;
}
