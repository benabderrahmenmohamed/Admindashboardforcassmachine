import { z } from 'zod';
import { parseOrInvalid } from '@/lib/validation';

const segmentSchema = z.string().min(1);

/**
 * `value` as one path segment. A blank id would address the collection itself (`DELETE /products`)
 * and a slash another resource, so an id that cannot be a segment is VALIDATION_ERROR before
 * anything is sent.
 */
export function pathSegment(value: string, what: string): string {
  return encodeURIComponent(parseOrInvalid(segmentSchema, value, what));
}
