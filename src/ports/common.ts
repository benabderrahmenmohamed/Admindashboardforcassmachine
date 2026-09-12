import { z } from 'zod';
import type { Millimes } from '@/lib/money';

/** A whole, safe-integer number of millimes. */
export const millimesSchema = z
  .number()
  .int()
  .transform((value) => (value === 0 ? 0 : value) as Millimes);

/** SHA-256 of a record's canonical JSON, lowercase hex (src/lib/payloadHash.ts). */
export const payloadHashSchema = z
  .string()
  .regex(/^[0-9a-f]{64}$/, 'Expected a SHA-256 hex digest');

/** An id chosen by the device for a record it writes. */
export const recordIdSchema = z.uuid();

/** ISO 8601 timestamp text. */
export const timestampSchema = z.string().min(1);
