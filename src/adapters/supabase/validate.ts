import type { z } from 'zod';
import { AppError } from '@/lib/errors';

/**
 * Checks what a caller hands to a port. Throws VALIDATION_ERROR whose message is the first problem,
 * ready to show to a person, with every Zod issue in `details`.
 */
export function parseInput<Schema extends z.ZodType>(
  schema: Schema,
  value: unknown,
): z.output<Schema> {
  const result = schema.safeParse(value);
  if (!result.success) {
    const [first] = result.error.issues;
    throw new AppError('VALIDATION_ERROR', first?.message ?? 'Invalid input', {
      details: { issues: result.error.issues },
      cause: result.error,
    });
  }
  return result.data;
}

/**
 * Checks what the edge function sent back. Data the app cannot read will not become readable on a
 * retry, so this is VALIDATION_ERROR too, naming `what` could not be read.
 */
export function parseOutput<Schema extends z.ZodType>(
  schema: Schema,
  value: unknown,
  what: string,
): z.output<Schema> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new AppError('VALIDATION_ERROR', `The server sent ${what} that the app cannot read`, {
      details: { issues: result.error.issues },
      cause: result.error,
    });
  }
  return result.data;
}

/** Short text for a value of unknown type, for messages and logs. */
export function describeValue(value: unknown): string {
  if (typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  return value === null ? 'null' : typeof value;
}
