import { z } from 'zod';
import { AppError } from './errors';

/**
 * Parses `value` with a schema and turns a failure into a VALIDATION_ERROR carrying the Zod issues,
 * never a raw ZodError: every failure that leaves a module of this app has a code to decide from.
 */
export function parseOrInvalid<Schema extends z.ZodType>(
  schema: Schema,
  value: unknown,
  what: string,
): z.output<Schema> {
  const result = schema.safeParse(value);
  if (!result.success) {
    const { issues } = result.error;
    throw new AppError('VALIDATION_ERROR', issues[0]?.message ?? `Invalid ${what}`, {
      details: { what, issues },
    });
  }
  return result.data;
}
