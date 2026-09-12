import {
  isAuthApiError,
  isAuthRetryableFetchError,
  type PostgrestSingleResponse,
} from '@supabase/supabase-js';
import { keysToCamel } from '@/lib/caseConversion';
import { AppError, isErrorCode, toAppError, type ErrorCode } from '@/lib/errors';

const DEFAULT_MESSAGES: Readonly<Record<ErrorCode, string>> = {
  NETWORK_ERROR: 'Could not reach the server. Check the connection and try again.',
  SERVER_ERROR: 'The server could not handle the request. Try again later.',
  RATE_LIMITED: 'Too many requests. Wait a moment and try again.',
  UNAUTHENTICATED: 'Your session has ended. Sign in again.',
  FORBIDDEN: 'You do not have permission to do this.',
  NOT_FOUND: 'Not found.',
  VALIDATION_ERROR: 'The server rejected the request as invalid.',
  IDEMPOTENCY_CONFLICT: 'A different record was already stored under this id.',
  SEQUENCE_GAP: 'This receipt number is not the next one for this terminal.',
  SESSION_CLOSED: 'The cash session is already closed.',
  SESSION_ALREADY_OPEN: 'This terminal already has an open cash session.',
  TERMINAL_SUPERSEDED: 'This terminal was registered again on another device.',
  CONFIG_ERROR: 'The app is not configured correctly.',
  UNKNOWN: 'The request failed.',
};

/** Message for an error whose response carried none of its own. */
export function defaultErrorMessage(code: ErrorCode): string {
  return DEFAULT_MESSAGES[code];
}

/** The code of a response without a contract code, from its HTTP status (contracts/errors.md). */
export function errorCodeForStatus(status: number): ErrorCode {
  switch (status) {
    case 0:
      return 'NETWORK_ERROR';
    case 400:
    case 409:
    case 422:
      return 'VALIDATION_ERROR';
    case 401:
      return 'UNAUTHENTICATED';
    case 403:
      return 'FORBIDDEN';
    case 404:
      return 'NOT_FOUND';
    case 429:
      return 'RATE_LIMITED';
    default:
      return status >= 500 && status <= 599 ? 'SERVER_ERROR' : 'UNKNOWN';
  }
}

/**
 * A failure as postgrest-js reports it. Typed loosely on purpose: a proxy error page arrives as
 * `{ message: <the page> }`, and any JSON error body as it was sent.
 */
export interface PostgrestFailure {
  readonly message?: unknown;
  readonly details?: unknown;
  readonly hint?: unknown;
  readonly code?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The JSON object an RPC raised as `detail`, keys in camelCase like every port DTO. */
function contractDetails(details: unknown): Record<string, unknown> | undefined {
  if (typeof details !== 'string' || details.trim() === '') {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(details);
  } catch (error) {
    console.warn('Ignoring error details that are not JSON', details, error);
    return undefined;
  }
  const camel = keysToCamel(parsed);
  if (!isRecord(camel)) {
    console.warn('Ignoring error details that are not a JSON object', details);
    return undefined;
  }
  return camel;
}

/**
 * Turns a failed PostgREST request into an AppError. An RPC raises with a contract code as `message`,
 * a sentence for people as `hint` and a JSON object as `details`; anything else is classified by its
 * HTTP status, where status 0 means no response arrived.
 */
export function toPostgrestAppError(failure: PostgrestFailure, status: number): AppError {
  const { message, hint } = failure;
  if (isErrorCode(message)) {
    return new AppError(
      message,
      typeof hint === 'string' && hint.trim() !== '' ? hint : defaultErrorMessage(message),
      { details: contractDetails(failure.details), cause: failure },
    );
  }
  const code = errorCodeForStatus(status);
  return new AppError(code, defaultErrorMessage(code), {
    details: {
      status,
      ...(typeof failure.code === 'string' && failure.code !== ''
        ? { postgrestCode: failure.code }
        : {}),
    },
    cause: failure,
  });
}

/** The data of a finished postgrest-js request, or its failure as an AppError. */
export async function unwrap<T>(request: PromiseLike<PostgrestSingleResponse<T>>): Promise<T> {
  let response: PostgrestSingleResponse<T>;
  try {
    response = await request;
  } catch (error) {
    // postgrest-js reports failures, network ones included, in the response; a throw is a bug.
    throw toAppError(error);
  }
  if (response.error !== null) {
    throw toPostgrestAppError(response.error, response.status);
  }
  return response.data;
}

/** Turns what supabase.auth returned or threw into an AppError, from its type and status only. */
export function toAuthAppError(error: unknown): AppError {
  if (error instanceof AppError) {
    return error;
  }
  if (isAuthRetryableFetchError(error)) {
    return new AppError('NETWORK_ERROR', defaultErrorMessage('NETWORK_ERROR'), {
      details: { status: error.status },
      cause: error,
    });
  }
  if (isAuthApiError(error)) {
    // Auth answers 400 when it refuses credentials (invalid_credentials, email_not_confirmed).
    const code =
      error.status === 400 && error.code !== 'validation_failed'
        ? 'UNAUTHENTICATED'
        : errorCodeForStatus(error.status);
    return new AppError(code, error.message || defaultErrorMessage(code), {
      details: { status: error.status, authCode: error.code },
      cause: error,
    });
  }
  return toAppError(error);
}
