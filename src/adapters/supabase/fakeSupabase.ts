import { createClient } from '@supabase/supabase-js';
import { expect } from 'vitest';
import { AppError } from '@/lib/errors';
import type { StorageLike } from './auth';
import type { SupabaseDatabaseClient } from './client';
import type { Database } from './database.types';

/** Test support only. The project URL of the fake; recorded paths start after it. */
export const FAKE_PROJECT_URL = 'http://127.0.0.1:54321';

/** One request the client sent. */
export interface FakeCall {
  readonly method: string;
  /** e.g. `/rest/v1/rpc/record_sale` or `/rest/v1/sales`. */
  readonly path: string;
  readonly query: URLSearchParams;
  readonly headers: Headers;
  /** The body exactly as it was sent. */
  readonly rawBody: string | undefined;
  /** The body read as JSON; undefined without one. */
  readonly body: unknown;
}

export type FakeReply =
  | { readonly kind: 'json'; readonly status: number; readonly value: unknown }
  | { readonly kind: 'text'; readonly status: number; readonly text: string }
  | { readonly kind: 'empty'; readonly status: number }
  | { readonly kind: 'unreachable'; readonly error: Error };

export type FakeHandler = (call: FakeCall) => FakeReply;

export function json(value: unknown, status = 200): FakeReply {
  return { kind: 'json', status, value };
}

export function text(body: string, status: number): FakeReply {
  return { kind: 'text', status, text: body };
}

export function noContent(): FakeReply {
  return { kind: 'empty', status: 204 };
}

/** A request that never gets a response. */
export function unreachable(error: Error = new TypeError('fetch failed')): FakeReply {
  return { kind: 'unreachable', error };
}

/** An error raised by private.raise_error, as PostgREST sends it (contracts/errors.md). */
export function raised(
  code: string,
  status: number,
  details: Record<string, unknown> = {},
  hint = '',
): FakeReply {
  return json(
    { code: `PT${status}`, message: code, details: JSON.stringify(details), hint },
    status,
  );
}

/** What `my_profile()` returns for a member of shop-1. */
export function profileJson(role: 'admin' | 'cashier') {
  return role === 'admin'
    ? {
        user_id: 'user-admin',
        shop_id: 'shop-1',
        role,
        display_name: 'Amel',
        email: 'admin@demo.local',
      }
    : {
        user_id: 'user-cashier',
        shop_id: 'shop-1',
        role,
        display_name: 'Karim',
        email: 'cashier@demo.local',
      };
}

/** Answers `"METHOD /path"` from `table`; any other request gets a 404 naming it. */
export function routes(table: Readonly<Record<string, FakeHandler>>): FakeHandler {
  return (call) => {
    const route = table[`${call.method} ${call.path}`];
    return route
      ? route(call)
      : json({ code: 'TEST404', message: `No route for ${call.method} ${call.path}` }, 404);
  };
}

function toResponse(reply: FakeReply): Promise<Response> {
  switch (reply.kind) {
    case 'json':
      return Promise.resolve(
        new Response(JSON.stringify(reply.value), {
          status: reply.status,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    case 'text':
      return Promise.resolve(new Response(reply.text, { status: reply.status }));
    case 'empty':
      return Promise.resolve(new Response(null, { status: reply.status }));
    case 'unreachable':
      return Promise.reject(reply.error);
  }
}

export function memoryStorage(initial: Record<string, string> = {}) {
  const entries = new Map(Object.entries(initial));
  const storage: StorageLike = {
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => {
      entries.set(key, value);
    },
    removeItem: (key) => {
      entries.delete(key);
    },
  };
  return { entries, storage };
}

/**
 * A real supabase-js client whose requests reach `handler` instead of the network: tests see the
 * URLs and bodies PostgREST would receive, and postgrest-js reads the replies as it reads PostgREST's.
 */
export function fakeSupabase(handler: FakeHandler): {
  client: SupabaseDatabaseClient;
  calls: FakeCall[];
} {
  const calls: FakeCall[] = [];
  const fetch: typeof globalThis.fetch = (input, init) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    );
    const rawBody = typeof init?.body === 'string' ? init.body : undefined;
    const body: unknown = rawBody === undefined ? undefined : JSON.parse(rawBody);
    const call: FakeCall = {
      method: init?.method ?? 'GET',
      path: url.pathname,
      query: url.searchParams,
      headers: new Headers(init?.headers),
      rawBody,
      body,
    };
    calls.push(call);
    return toResponse(handler(call));
  };
  const client = createClient<Database>(FAKE_PROJECT_URL, 'anon-key', {
    auth: {
      storage: memoryStorage().storage,
      persistSession: true,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
    // postgrest-js retries a failed GET with a delay of seconds; the fake answers at once.
    db: { retry: false },
    global: { fetch },
  });
  return { client, calls };
}

/** The AppError `promise` rejects with; the test fails when it resolves or rejects with anything else. */
export async function failureOf(promise: Promise<unknown>): Promise<AppError> {
  const outcome: unknown = await promise.then(
    () => null,
    (error: unknown) => error,
  );
  if (!(outcome instanceof AppError)) {
    return expect.unreachable('expected a failure with an AppError');
  }
  return outcome;
}
