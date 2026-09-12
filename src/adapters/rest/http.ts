import { keysToCamel } from '@/lib/caseConversion';
import { AppError, isErrorCode, type ErrorCode } from '@/lib/errors';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

export interface RestClientOptions {
  readonly baseUrl: string;
  readonly fetch?: typeof fetch;
  /** The bearer token of the current session, or null when signed out. */
  readonly getToken: () => string | null;
}

export interface RestResponse {
  readonly status: number;
  readonly body: unknown;
}

export interface RestRequest {
  readonly body?: unknown;
  readonly query?: Readonly<Record<string, string | number | undefined>>;
  /** Defaults to true: send the bearer token, and refuse to send without one. */
  readonly auth?: boolean;
}

/** contracts/errors.md: a response without a contract code is classified by its status. */
function codeForStatus(status: number): ErrorCode {
  if (status === 401) return 'UNAUTHENTICATED';
  if (status === 403) return 'FORBIDDEN';
  if (status === 404) return 'NOT_FOUND';
  if (status === 429) return 'RATE_LIMITED';
  if (status >= 500) return 'SERVER_ERROR';
  return 'VALIDATION_ERROR';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Turns a failed response into an AppError: the envelope's code when it has one, else the status. */
export function toRestError(status: number, body: unknown): AppError {
  const envelope = isRecord(body) && isRecord(body.error) ? body.error : null;
  if (envelope && isErrorCode(envelope.code)) {
    const details = isRecord(envelope.details)
      ? (keysToCamel(envelope.details) as Record<string, unknown>)
      : undefined;
    const message =
      typeof envelope.message === 'string' && envelope.message ? envelope.message : envelope.code;
    return new AppError(envelope.code, message, { details: { ...details, status } });
  }
  return new AppError(codeForStatus(status), `The server answered with HTTP ${status}.`, {
    details: { status },
  });
}

export function createRestClient(options: RestClientOptions) {
  const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  const base = options.baseUrl.replace(/\/+$/, '');

  return {
    async request(method: HttpMethod, path: string, init: RestRequest = {}): Promise<RestResponse> {
      const url = new URL(`${base}${path}`);
      for (const [key, value] of Object.entries(init.query ?? {})) {
        if (value !== undefined) {
          url.searchParams.set(key, String(value));
        }
      }

      const headers: Record<string, string> = { Accept: 'application/json' };
      if (init.body !== undefined) {
        headers['Content-Type'] = 'application/json';
      }
      if (init.auth !== false) {
        const token = options.getToken();
        if (!token) {
          throw new AppError('UNAUTHENTICATED', 'Sign in to continue.');
        }
        headers.Authorization = `Bearer ${token}`;
      }

      let response: Response;
      let text: string;
      try {
        response = await doFetch(url, {
          method,
          headers,
          body: init.body === undefined ? undefined : JSON.stringify(init.body),
        });
        text = await response.text();
      } catch (error) {
        throw new AppError('NETWORK_ERROR', 'The server could not be reached.', { cause: error });
      }

      let body: unknown = null;
      if (text) {
        try {
          body = JSON.parse(text) as unknown;
        } catch (error) {
          if (response.ok) {
            throw new AppError('SERVER_ERROR', 'The server sent a response that is not JSON.', {
              cause: error,
            });
          }
          // A failed response with a non-JSON body (a proxy error page): classified by status below.
          body = null;
        }
      }

      if (!response.ok) {
        throw toRestError(response.status, body);
      }
      return { status: response.status, body };
    },
  };
}

export type RestClient = ReturnType<typeof createRestClient>;
