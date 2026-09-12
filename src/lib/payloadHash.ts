import { AppError } from './errors';

/**
 * Canonical JSON: object keys sorted by UTF-16 code unit order at every level, no whitespace, and
 * only whole numbers (money is millimes), so the same record always serialises to the same bytes on
 * every device and in every language. `undefined` properties are left out, as JSON.stringify does.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) {
    return 'null';
  }
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isSafeInteger(value)) {
        throw new AppError(
          'VALIDATION_ERROR',
          `Canonical JSON only holds whole numbers, got ${value}`,
        );
      }
      return String(value === 0 ? 0 : value);
    case 'object': {
      if (Array.isArray(value)) {
        return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
      }
      const entries = Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
    }
    default:
      throw new AppError('VALIDATION_ERROR', `Canonical JSON cannot hold a ${typeof value}`);
  }
}

/**
 * SHA-256, lowercase hex, of the canonical JSON of `record` without its `payloadHash` property.
 * The server stores this and compares it on replay; it never recomputes it.
 */
export async function payloadHash(record: object): Promise<string> {
  const withoutHash: Record<string, unknown> = { ...record };
  delete withoutHash.payloadHash;
  const bytes = new TextEncoder().encode(canonicalJson(withoutHash));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function withPayloadHash<T extends object>(
  record: T,
): Promise<T & { payloadHash: string }> {
  return { ...record, payloadHash: await payloadHash(record) };
}
