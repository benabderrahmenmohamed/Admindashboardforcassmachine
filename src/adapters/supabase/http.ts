import { AppError, toAppError, type ErrorCode } from '@/lib/errors';

/** Where Supabase serves the legacy Hono edge function (supabase/functions/server). */
export const EDGE_FUNCTION_PATH = '/functions/v1/make-server-81f0b18a';

export type EdgeAuth = 'anon' | 'user';

export interface EdgeRequestOptions {
  readonly method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  /** Sent as JSON. */
  readonly body?: unknown;
  /**
   * - `anon`: public reads, authorised with the anon key.
   * - `user`: writes, authorised with the signed-in user's access token. Without a session nothing
   *   is sent: a user request never falls back to the anon key.
   */
  readonly auth: EdgeAuth;
}

/** Sends one request to the edge function and resolves with its parsed JSON body. */
export type EdgeRequest = (path: string, options: EdgeRequestOptions) => Promise<unknown>;

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface EdgeRequestDeps {
  /** Project URL, e.g. https://<project-ref>.supabase.co. */
  readonly url: string;
  readonly anonKey: string;
  /** The current access token, or null when nobody is signed in. Read right before each user request. */
  readonly getAccessToken: () => Promise<string | null>;
  /** Defaults to the global fetch. */
  readonly fetch?: FetchLike;
}

const DEFAULT_MESSAGES: Readonly<Record<ErrorCode, string>> = {
  NETWORK_ERROR: 'Could not reach the server. Check the connection and try again.',
  SERVER_ERROR: 'The server could not handle the request. Try again later.',
  RATE_LIMITED: 'Too many requests. Wait a moment and try again.',
  UNAUTHENTICATED: 'Your session has ended. Sign in again.',
  FORBIDDEN: 'You do not have permission to do this.',
  NOT_FOUND: 'Not found.',
  VALIDATION_ERROR: 'The server rejected the request as invalid.',
  CONFIG_ERROR: 'The app is not configured correctly.',
  UNKNOWN: 'The request failed.',
};

/** Message for an error whose response carried none of its own. */
export function defaultErrorMessage(code: ErrorCode): string {
  return DEFAULT_MESSAGES[code];
}

export function errorCodeForStatus(status: number): ErrorCode {
  switch (status) {
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
      return status >= 500 ? 'SERVER_ERROR' : 'UNKNOWN';
  }
}

// A type alias, not an interface, so it can go into AppError details (Record<string, unknown>).
type RequestContext = {
  readonly method: EdgeRequestOptions['method'];
  readonly path: string;
};

type ResponseBody =
  | { readonly kind: 'empty' }
  | { readonly kind: 'json'; readonly value: unknown }
  | { readonly kind: 'text' };

function readBody(
  text: string,
  context: RequestContext & { readonly status: number },
): ResponseBody {
  if (text.trim() === '') {
    return { kind: 'empty' };
  }
  try {
    const value: unknown = JSON.parse(text);
    return { kind: 'json', value };
  } catch (error) {
    console.warn('The edge function sent a body that is not JSON', context, error);
    return { kind: 'text' };
  }
}

/** The legacy function reports failures as `{ error: string }`. */
function messageFrom(body: ResponseBody): string | null {
  if (body.kind !== 'json' || typeof body.value !== 'object' || body.value === null) {
    return null;
  }
  if ('error' in body.value && typeof body.value.error === 'string' && body.value.error !== '') {
    return body.value.error;
  }
  return null;
}

/**
 * Builds `edgeRequest` over the legacy edge function. Failures become AppErrors: a fetch rejection
 * is NETWORK_ERROR and every other code follows the HTTP status (see errorCodeForStatus).
 */
export function createEdgeRequest(deps: EdgeRequestDeps): EdgeRequest {
  const baseUrl = deps.url.replace(/\/+$/, '') + EDGE_FUNCTION_PATH;
  const send: FetchLike = deps.fetch ?? ((url, init) => fetch(url, init));

  async function authorization(auth: EdgeAuth, context: RequestContext): Promise<string> {
    if (auth === 'anon') {
      return `Bearer ${deps.anonKey}`;
    }
    let token: string | null;
    try {
      token = await deps.getAccessToken();
    } catch (error) {
      throw toAppError(error);
    }
    if (!token) {
      throw new AppError('UNAUTHENTICATED', DEFAULT_MESSAGES.UNAUTHENTICATED, { details: context });
    }
    return `Bearer ${token}`;
  }

  async function exchange(
    url: string,
    init: RequestInit,
    context: RequestContext,
  ): Promise<{ status: number; ok: boolean; text: string }> {
    try {
      const response = await send(url, init);
      return { status: response.status, ok: response.ok, text: await response.text() };
    } catch (error) {
      throw new AppError('NETWORK_ERROR', DEFAULT_MESSAGES.NETWORK_ERROR, {
        details: context,
        cause: error,
      });
    }
  }

  return async (path, options) => {
    const context: RequestContext = { method: options.method, path };
    const hasBody = options.body !== undefined;
    const headers: Record<string, string> = {
      Authorization: await authorization(options.auth, context),
      ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
    };
    const response = await exchange(
      baseUrl + path,
      {
        method: options.method,
        headers,
        body: hasBody ? JSON.stringify(options.body) : undefined,
      },
      context,
    );
    const details = { ...context, status: response.status };
    const body = readBody(response.text, details);

    if (!response.ok) {
      const code = errorCodeForStatus(response.status);
      throw new AppError(code, messageFrom(body) ?? DEFAULT_MESSAGES[code], { details });
    }
    if (body.kind === 'text') {
      throw new AppError('SERVER_ERROR', 'The server sent a response the app cannot read.', {
        details,
      });
    }
    return body.kind === 'json' ? body.value : undefined;
  };
}
