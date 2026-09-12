/** `lineNo` → `line_no`, `clientZReport` → `client_z_report`. */
export function camelToSnake(key: string): string {
  return key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

/** `line_no` → `lineNo`, `client_z_report` → `clientZReport`. */
export function snakeToCamel(key: string): string {
  return key.replace(/_([a-z0-9])/g, (_match, char: string) => char.toUpperCase());
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function mapKeys(value: unknown, rename: (key: string) => string): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => mapKeys(item, rename));
  }
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [rename(key), mapKeys(item, rename)]),
    );
  }
  return value;
}

/**
 * Renames every key of plain objects, at any depth, from camelCase to snake_case: the wire format of
 * the RPCs and the REST API (contracts/errors.md). Values are left exactly as they are.
 */
export function keysToSnake(value: unknown): unknown {
  return mapKeys(value, camelToSnake);
}

/** Renames every key of plain objects, at any depth, from snake_case to camelCase: the port DTOs. */
export function keysToCamel(value: unknown): unknown {
  return mapKeys(value, snakeToCamel);
}
