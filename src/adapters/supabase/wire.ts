import type { z } from 'zod';
import { keysToCamel, keysToSnake } from '@/lib/caseConversion';
import type { Json } from './database.types';
import { parseOutput } from './validate';

/**
 * A port DTO as an RPC argument: every key renamed to snake_case, every value exactly as it was, so
 * `payload_hash` still matches the record it was computed over (contracts/errors.md).
 */
export function toWire(value: object): Json {
  // Port DTOs are JSON data (strings, whole numbers, booleans, null, arrays, plain objects), and
  // renaming keys keeps them JSON.
  return keysToSnake(value) as Json;
}

/**
 * A timestamp the database wrote, in the form every adapter answers with: UTC to the millisecond,
 * ending in `Z`, as `Date.prototype.toISOString` writes it. PostgREST writes the same instant as
 * `2026-09-12T10:00:00.123456+00:00`, and anything comparing timestamps as text — the contract suite
 * does, with the moment a device sent — would see two moments. Text that is not a timestamp is left
 * as it is for the port schema to judge.
 */
export function isoTimestamp(value: string): string {
  const time = Date.parse(value);
  return Number.isNaN(time) ? value : new Date(time).toISOString();
}

/** `isoTimestamp` for a column that may be empty. */
export function isoTimestampOrNull(value: string | null): string | null {
  return value === null ? null : isoTimestamp(value);
}

/** An RPC result read into a port DTO: keys renamed to camelCase, then checked with `schema`. */
export function fromWire<Schema extends z.ZodType>(
  schema: Schema,
  value: unknown,
  what: string,
): z.output<Schema> {
  return parseOutput(schema, keysToCamel(value), what);
}
