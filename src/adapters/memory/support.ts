import type { z } from 'zod';
import { AppError, toAppError } from '@/lib/errors';
import { roleSchema, type AuthState, type Role } from '@/ports';
import type { FaultInjector, MemoryOperation } from './faults';
import type { MemoryProfile } from './seed';
import type { MemoryStore } from './store';

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
  /** The data, shared by every client of the backend. */
  readonly store: MemoryStore;
  readonly client: MemoryClient;
}

/**
 * Runs the body of the port method `operation`: pending faults first, then `body`. Every outcome,
 * including a synchronous throw, reaches the caller as a promise, like a real backend. Every
 * failure is an AppError: anything else (a throwing clock or id source, say) becomes UNKNOWN with
 * the original as its cause. The body runs to completion before any other call, so each call sees
 * the result of the previous one, like requests serialised by the database's terminal lock.
 */
export function perform<T>(
  context: MemoryContext,
  operation: MemoryOperation,
  body: () => T,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    try {
      context.faults.check(operation);
      resolve(body());
    } catch (error) {
      reject(toAppError(error));
    }
  });
}

/**
 * The caller's shop membership, as private.require_profile: nobody signed in is UNAUTHENTICATED;
 * an account without a profile, or with a role outside `allowed` (default: any role), is
 * FORBIDDEN. Every call on shop data makes this check first in its body: after the faults, as a
 * request that never arrives cannot be refused, and before the input is parsed.
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
  if (!allowed.includes(profile.role)) {
    throw new AppError('FORBIDDEN', 'Your role cannot do this.', {
      details: { role: profile.role },
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
