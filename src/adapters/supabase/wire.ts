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

/** An RPC result read into a port DTO: keys renamed to camelCase, then checked with `schema`. */
export function fromWire<Schema extends z.ZodType>(
  schema: Schema,
  value: unknown,
  what: string,
): z.output<Schema> {
  return parseOutput(schema, keysToCamel(value), what);
}
