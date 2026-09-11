import type { z } from 'zod';
import { AppError, toAppError } from '@/lib/errors';
import { roleSchema, type Role } from '@/ports';
import type { FaultInjector, MemoryOperation } from './faults';
import type { MemoryStore } from './store';

/** What every memory port shares: the fault injector, the clock and the id source. */
export interface MemoryContext {
  readonly faults: FaultInjector;
  readonly now: () => Date;
  readonly newId: () => string;
}

/**
 * Runs the body of the port method `operation`: pending faults first, then `body`. Every outcome,
 * including a synchronous throw, reaches the caller as a promise, like a real backend. Every
 * failure is an AppError: anything else (a throwing clock or id source, say) becomes UNKNOWN with
 * the original as its cause.
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
 * Refuses the call unless someone is signed in with a role in `allowed` (default: any role), the
 * check the legacy edge function makes before a write: nobody signed in is UNAUTHENTICATED (its
 * 401), another role FORBIDDEN (its 403). Writes call it first in their body: after the faults, as
 * a request that never arrives cannot be refused, and before the input is parsed.
 */
export function authorize(store: MemoryStore, allowed: readonly Role[] = roleSchema.options): void {
  const session = store.session;
  if (session.status === 'anonymous') {
    throw new AppError('UNAUTHENTICATED', 'Your session has ended. Sign in again.');
  }
  if (!allowed.includes(session.user.role)) {
    throw new AppError('FORBIDDEN', 'You do not have permission to do this.', {
      details: { role: session.user.role, allowed: [...allowed] },
    });
  }
}

/** Parses `value` with a port schema; failures become VALIDATION_ERROR with the Zod issues. */
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

export function notFound(what: string, id: string): AppError {
  return new AppError('NOT_FOUND', `${what} not found`, { details: { id } });
}

/** A new id from `context.newId`, refusing one that would overwrite an existing record. */
export function freshId(context: MemoryContext, taken: ReadonlyMap<string, unknown>): string {
  const id = context.newId();
  if (id.length === 0 || taken.has(id)) {
    throw new AppError('CONFIG_ERROR', `newId returned an empty or already used id: "${id}"`);
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
