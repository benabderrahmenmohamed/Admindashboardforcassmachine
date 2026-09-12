import type { z } from 'zod';
import { AppError, toAppError } from '@/lib/errors';
import { roleSchema, type AuthState, type RealtimeTopic, type Role } from '@/ports';
import { droppedResponse, type FaultInjector, type MemoryOperation } from './faults';
import type { MemoryProfile } from './seed';
import type { MemoryStore, OrderRecordKind, OrderRecordRow } from './store';

/** An auth state of the memory backend, which has no network and so is never offline. */
export type MemorySession = Exclude<AuthState, { readonly status: 'offline' }>;

/** One client of a memory backend, like one browser: who is signed in on it. */
export interface MemoryClient {
  session: MemorySession;
}

/** What the ports of one client share. */
export interface MemoryContext {
  /** This client's faults. */
  readonly faults: FaultInjector;
  readonly now: () => Date;
  readonly newId: () => string;
  /** Whether the device can reach the backend, read on every call (see `defaultConnectivity`). */
  readonly connectivity: () => boolean;
  /** The data, shared by every client of the backend. */
  readonly store: MemoryStore;
  readonly client: MemoryClient;
  /**
   * Tells the shop's realtime listeners that `topic` changed, shared by every client: a waiter's
   * add reaches the caisse and the kitchen the way the database's publication reaches them. Called
   * once the write is in the store, so a listener that reads sees it.
   */
  readonly emit: (shopId: string, topic: RealtimeTopic) => void;
}

/**
 * Runs the body of the port method `operation`: the device's connectivity first, then pending
 * faults, then `body`. A call made offline throws NETWORK_ERROR before anything else, since a
 * request that never leaves the device reaches no fault and no check of the backend's; a call whose
 * response is dropped runs `body` and throws afterwards, so the write stands and the caller cannot
 * tell. Every outcome, including a synchronous throw, reaches the caller as a promise, like a real
 * backend. Every failure is an AppError: anything else (a throwing clock or id source, say) becomes
 * UNKNOWN with the original as its cause. The body runs to completion before any other call, so
 * each call sees the result of the previous one, like requests serialised by the database's
 * terminal lock.
 */
export function perform<T>(
  context: MemoryContext,
  operation: MemoryOperation,
  body: () => T,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    try {
      if (!context.connectivity()) {
        throw new AppError(
          'NETWORK_ERROR',
          'Could not reach the server. Check the connection and try again.',
        );
      }
      const effect = context.faults.check(operation);
      const value = body();
      if (effect === 'drop') {
        throw droppedResponse();
      }
      resolve(value);
    } catch (error) {
      reject(toAppError(error));
    }
  });
}

/**
 * The caller's shop membership, as private.require_profile: nobody signed in is UNAUTHENTICATED;
 * an account without a profile, or holding none of `allowed` (default: any role), is FORBIDDEN.
 * One person often holds several roles, so membership answers the question "any of these?", never
 * "which one?". Every call on shop data makes this check first in its body: after connectivity and
 * the faults, as a request that never arrives cannot be refused, and before the input is parsed.
 */
export function requireProfile(
  context: MemoryContext,
  allowed: readonly Role[] = roleSchema.options,
): MemoryProfile {
  const { session } = context.client;
  if (session.status === 'anonymous') {
    throw new AppError('UNAUTHENTICATED', 'Sign in to continue.');
  }
  const profile = context.store.profiles.get(session.user.id);
  if (!profile) {
    throw new AppError('FORBIDDEN', 'This account is not a member of any shop.');
  }
  if (!profile.roles.some((role) => allowed.includes(role))) {
    throw new AppError('FORBIDDEN', 'Your role cannot do this.', {
      details: { roles: [...profile.roles] },
    });
  }
  return profile;
}

/** Parses `value` with a schema; failures become VALIDATION_ERROR with the Zod issues. */
export function parseInput<Schema extends z.ZodType>(
  schema: Schema,
  value: unknown,
): z.output<Schema> {
  const result = schema.safeParse(value);
  if (!result.success) {
    const { issues } = result.error;
    throw new AppError('VALIDATION_ERROR', issues[0]?.message ?? 'Invalid input', {
      details: { issues },
    });
  }
  return result.data;
}

/** VALIDATION_ERROR with `{ field }`, as the database's typed payload readers raise it. */
export function invalidField(field: string, message: string): AppError {
  return new AppError('VALIDATION_ERROR', message, { details: { field } });
}

/**
 * The stored outcome of a record that already arrived, as private.order_replay: the same id with
 * the same payload answers what it answered the first time, whatever has changed since; the same id
 * with anything else is a conflict for a person to look at. Every kind shares the id space, because
 * public.order_records is one table.
 */
export function replayOf(
  store: MemoryStore,
  profile: MemoryProfile,
  kind: OrderRecordKind,
  id: string,
  payloadHash: string,
): OrderRecordRow | undefined {
  const stored = store.orderRecords.get(id);
  if (!stored) {
    return undefined;
  }
  if (stored.shopId !== profile.shopId) {
    throw new AppError('FORBIDDEN', 'This record belongs to another shop.', { details: { id } });
  }
  if (stored.kind !== kind || stored.payloadHash !== payloadHash) {
    throw new AppError(
      'IDEMPOTENCY_CONFLICT',
      'A different record was already stored under this id.',
      {
        details: { id },
      },
    );
  }
  return stored;
}

/** The product a stored stock correction moved. A record of that kind always names one. */
export function storedProductId(stored: OrderRecordRow): string {
  if (stored.productId === null) {
    throw new AppError('UNKNOWN', `The stored correction ${stored.id} has no product`);
  }
  return stored.productId;
}

/** The text form of a uuid that the database returns: lowercase, 8-4-4-4-12 hex digits. */
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** `value` as a uuid in its lowercase form, or VALIDATION_ERROR naming `field` (wire name). */
export function parseUuid(value: string, field: string): string {
  const id = value.toLowerCase();
  if (!UUID_PATTERN.test(id)) {
    throw invalidField(field, `${field} must be a UUID.`);
  }
  return id;
}

/**
 * The row id a record that may be malformed names, as private.try_uuid: its lowercase form, or null
 * when it is missing or not a UUID, which names no row. Only void_receipt reads a reference this
 * leniently; every required field of a record goes through parseUuid, as private.json_uuid.
 */
export function parseRef(value: string | null): string | null {
  const id = value === null ? null : value.toLowerCase();
  return id !== null && UUID_PATTERN.test(id) ? id : null;
}

/** `value` as an ISO 8601 timestamp in UTC, or VALIDATION_ERROR naming `field` (wire name). */
export function parseTimestamp(value: string, field: string): string {
  const time = Date.parse(value);
  if (Number.isNaN(time)) {
    throw invalidField(field, `${field} must be an ISO 8601 timestamp.`);
  }
  return new Date(time).toISOString();
}

/** A new id from `context.newId`, refusing anything but an unused lowercase UUID. */
export function freshId(context: MemoryContext, taken: ReadonlyMap<string, unknown>): string {
  const id = context.newId();
  if (!UUID_PATTERN.test(id) || taken.has(id)) {
    throw new AppError('CONFIG_ERROR', `newId must return an unused lowercase UUID, got "${id}"`);
  }
  return id;
}

/** What `defaultConnectivity` reads of the device. `onLine` is missing outside a browser. */
export interface ConnectivitySource {
  readonly onLine?: boolean;
}

/**
 * Whether the device can reach the backend: `navigator.onLine` in a browser, so switching Chrome to
 * offline blocks the demo as a dropped network blocks a real backend, and true anywhere else (node,
 * a runtime without it), where there is no network to lose.
 */
export function defaultConnectivity(
  source: ConnectivitySource | undefined = globalThis.navigator,
): boolean {
  return source?.onLine ?? true;
}

/** The Web Crypto calls `randomId` uses. */
export interface IdRandomness {
  /** Missing outside secure contexts, e.g. a demo opened over plain http on a LAN address. */
  readonly randomUUID?: () => string;
  /** Available in every context. Fills `bytes` and returns them. */
  readonly getRandomValues: (bytes: Uint8Array<ArrayBuffer>) => Uint8Array<ArrayBuffer>;
}

/**
 * A random v4 UUID: `randomUUID()` where it exists, otherwise the same format built from
 * `getRandomValues`, so ids work on pages that are not a secure context.
 */
export function randomId(random: IdRandomness = crypto): string {
  if (typeof random.randomUUID === 'function') {
    return random.randomUUID();
  }
  const bytes = random.getRandomValues(new Uint8Array(16));
  // RFC 9562: version 4 in the high nibble of byte 6, variant 0b10 in the top bits of byte 8.
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
}
