import {
  createClient,
  type REALTIME_SUBSCRIBE_STATES,
  type RealtimeChannel,
} from '@supabase/supabase-js';
import { expect } from 'vitest';
import { AppError } from '@/lib/errors';
import type { Role } from '@/ports';
import type { StorageLike } from './auth';
import type { SupabaseDatabaseClient } from './client';
import type { Database } from './database.types';
import type { SupabaseRealtimeApi } from './realtime';

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

/** What `my_profile()` returns for a member of shop-1, who may hold more than one role. */
export function profileJson(
  role: 'admin' | 'cashier' | 'waiter' | 'kitchen',
  ...alsoRoles: Role[]
) {
  const roles = [role, ...alsoRoles];
  const member =
    role === 'admin'
      ? { user_id: 'user-admin', display_name: 'Amel', email: 'admin@demo.local' }
      : role === 'cashier'
        ? { user_id: 'user-cashier', display_name: 'Karim', email: 'cashier@demo.local' }
        : role === 'waiter'
          ? { user_id: 'user-waiter', display_name: 'Sonia', email: 'waiter@demo.local' }
          : { user_id: 'user-kitchen', display_name: 'Mehdi', email: 'kitchen@demo.local' };
  return { ...member, shop_id: 'shop-1', roles };
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

/** One `on('postgres_changes', …)` a channel was given. */
export interface FakeBinding {
  readonly table: string;
  /** e.g. `shop_id=eq.shop-1`. */
  readonly filter: string;
  readonly handler: (payload: unknown) => void;
}

/** A Realtime channel that opens no socket: the test decides what the server does to it. */
export interface FakeChannel {
  readonly name: string;
  readonly bindings: readonly FakeBinding[];
  /** True once subscribe() was called, and again false once the client removed the channel. */
  open: boolean;
  removed: boolean;
  /** Delivers a change on `table` to every handler bound to it. */
  change(table: string): void;
  /** Reports a subscription status, as the server does. */
  report(status: REALTIME_SUBSCRIBE_STATES, error?: Error): void;
}

type SubscribeCallback = (status: REALTIME_SUBSCRIBE_STATES, error?: Error) => void;

function fakeChannel(name: string): FakeChannel {
  const bindings: FakeBinding[] = [];
  let callback: SubscribeCallback | undefined;
  const channel = {
    name,
    bindings,
    open: false,
    removed: false,
    on(_type: string, filter: { table?: string; filter?: string }, handler: (p: unknown) => void) {
      bindings.push({ table: filter.table ?? '', filter: filter.filter ?? '', handler });
      return channel;
    },
    subscribe(onStatus?: SubscribeCallback) {
      callback = onStatus;
      channel.open = true;
      return channel;
    },
    change(table: string) {
      for (const binding of bindings.filter((entry) => entry.table === table)) {
        binding.handler({ table });
      }
    },
    report(status: REALTIME_SUBSCRIBE_STATES, error?: Error) {
      callback?.(status, error);
    },
  };
  return channel;
}

/**
 * A stand-in for the client's Realtime side. `channels` holds every channel that was opened, newest
 * last, so a test can watch a subscription drop and come back.
 */
export function fakeRealtime(
  removeChannel: (channel: FakeChannel) => Promise<'ok' | 'timed out' | 'error'> = () =>
    Promise.resolve('ok'),
): { api: SupabaseRealtimeApi; channels: FakeChannel[] } {
  const channels: FakeChannel[] = [];
  const asChannel = (channel: FakeChannel) => channel as unknown as RealtimeChannel;
  const fromChannel = (channel: RealtimeChannel) => channel as unknown as FakeChannel;
  return {
    channels,
    api: {
      channel(name) {
        const opened = fakeChannel(name);
        channels.push(opened);
        return asChannel(opened);
      },
      removeChannel(channel) {
        const opened = fromChannel(channel);
        opened.open = false;
        opened.removed = true;
        return removeChannel(opened);
      },
    },
  };
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
