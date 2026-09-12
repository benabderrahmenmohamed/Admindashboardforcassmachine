/**
 * Every failure that crosses a port is an AppError carrying one of these codes (contracts/errors.md).
 * Callers decide what to do from the code alone, never from the message text: see `errorClass`.
 */
export const ERROR_CODES = [
  'NETWORK_ERROR',
  'SERVER_ERROR',
  'RATE_LIMITED',
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'NOT_FOUND',
  'VALIDATION_ERROR',
  'IDEMPOTENCY_CONFLICT',
  'SEQUENCE_GAP',
  'SESSION_CLOSED',
  'SESSION_ALREADY_OPEN',
  'TERMINAL_SUPERSEDED',
  'ORDER_CHANGED',
  'ORDER_CLOSED',
  'ITEM_NOT_FOUND',
  'TABLE_INACTIVE',
  'CONFIG_ERROR',
  'UNKNOWN',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/**
 * - `retriable`: the same request can succeed later (connectivity, overload).
 * - `auth`: wait until the user is signed in again, then retry.
 * - `conflict`: repeating the request gives the same answer, so a person has to act.
 */
export type ErrorClass = 'retriable' | 'auth' | 'conflict';

const ERROR_CLASS: Record<ErrorCode, ErrorClass> = {
  NETWORK_ERROR: 'retriable',
  SERVER_ERROR: 'retriable',
  RATE_LIMITED: 'retriable',
  UNAUTHENTICATED: 'auth',
  FORBIDDEN: 'conflict',
  NOT_FOUND: 'conflict',
  VALIDATION_ERROR: 'conflict',
  IDEMPOTENCY_CONFLICT: 'conflict',
  SEQUENCE_GAP: 'conflict',
  SESSION_CLOSED: 'conflict',
  SESSION_ALREADY_OPEN: 'conflict',
  TERMINAL_SUPERSEDED: 'conflict',
  ORDER_CHANGED: 'conflict',
  ORDER_CLOSED: 'conflict',
  ITEM_NOT_FOUND: 'conflict',
  TABLE_INACTIVE: 'conflict',
  CONFIG_ERROR: 'conflict',
  UNKNOWN: 'conflict',
};

export function errorClass(code: ErrorCode): ErrorClass {
  return ERROR_CLASS[code];
}

/**
 * The kinds of queued record a person may throw away instead of sending. An order event that can no
 * longer land — a stale item on a table the caisse already closed — must not block a waiter's phone
 * for ever. A ledger record is never discardable: one that reached the server must not be dropped,
 * and one that did not has to be looked at.
 */
export const DISCARDABLE_KINDS = [
  'order_item_add',
  'order_item_remove',
  'order_send',
  'order_item_prepare',
  'order_cancel',
] as const;

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && (ERROR_CODES as readonly string[]).includes(value);
}

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly details: Readonly<Record<string, unknown>> | undefined;

  constructor(
    code: ErrorCode,
    message: string,
    options: { details?: Record<string, unknown>; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = 'AppError';
    this.code = code;
    this.details = options.details;
  }
}

export function isAppError(value: unknown): value is AppError {
  return value instanceof AppError;
}

/** Keeps an AppError as it is and wraps anything else as UNKNOWN, preserving it as the cause. */
export function toAppError(value: unknown): AppError {
  if (value instanceof AppError) {
    return value;
  }
  const message = value instanceof Error && value.message ? value.message : 'Unexpected error';
  return new AppError('UNKNOWN', message, { cause: value });
}

/** Text to show a person: the error's own message when there is one, otherwise `fallback`. */
export function errorMessage(value: unknown, fallback: string): string {
  return value instanceof Error && value.message ? value.message : fallback;
}
