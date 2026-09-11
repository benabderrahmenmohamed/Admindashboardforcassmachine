import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppError, type ErrorCode } from '@/lib/errors';
import {
  createEdgeRequest,
  defaultErrorMessage,
  type EdgeRequestOptions,
  type FetchLike,
} from './http';

const PROJECT_URL = 'https://project-ref.supabase.co';
const ANON_KEY = 'anon-key';

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function setup(respond: FetchLike, token: string | null = 'user-token') {
  const fetch = vi.fn(respond);
  const getAccessToken = vi.fn(() => Promise.resolve(token));
  const request = createEdgeRequest({ url: PROJECT_URL, anonKey: ANON_KEY, getAccessToken, fetch });
  return { fetch, getAccessToken, request };
}

async function failureOf(promise: Promise<unknown>): Promise<AppError> {
  const outcome: unknown = await promise.then(
    () => null,
    (error: unknown) => error,
  );
  if (!(outcome instanceof AppError)) {
    return expect.unreachable('expected the request to fail with an AppError');
  }
  return outcome;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('edgeRequest', () => {
  it('sends public reads with the anon key and resolves with the parsed JSON', async () => {
    const { fetch, getAccessToken, request } = setup(() =>
      Promise.resolve(json(200, { products: [] })),
    );

    await expect(request('/products', { method: 'GET', auth: 'anon' })).resolves.toEqual({
      products: [],
    });

    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe('https://project-ref.supabase.co/functions/v1/make-server-81f0b18a/products');
    expect(init.method).toBe('GET');
    expect(new Headers(init.headers).get('Authorization')).toBe(`Bearer ${ANON_KEY}`);
    expect(init.body).toBeUndefined();
    expect(getAccessToken).not.toHaveBeenCalled();
  });

  it('sends user requests with the access token read right before sending, as JSON', async () => {
    const { fetch, getAccessToken, request } = setup(() =>
      Promise.resolve(json(200, { product: { id: 'p1' } })),
    );

    await request('/products', {
      method: 'POST',
      auth: 'user',
      body: { name: 'Lait', price: 1.35 },
    });

    expect(getAccessToken).toHaveBeenCalledTimes(1);
    const [, init] = fetch.mock.calls[0];
    const headers = new Headers(init.headers);
    expect(headers.get('Authorization')).toBe('Bearer user-token');
    expect(headers.get('Content-Type')).toBe('application/json');
    expect(init.body).toBe('{"name":"Lait","price":1.35}');
  });

  it('reads the token again for every user request and stops once the session has ended', async () => {
    const fetch = vi.fn<FetchLike>(() => Promise.resolve(json(200, { message: 'ok' })));
    const getAccessToken = vi
      .fn<() => Promise<string | null>>()
      .mockResolvedValueOnce('token-1')
      .mockResolvedValueOnce('token-2')
      .mockResolvedValueOnce(null);
    const request = createEdgeRequest({
      url: PROJECT_URL,
      anonKey: ANON_KEY,
      getAccessToken,
      fetch,
    });
    const asUser: EdgeRequestOptions = { method: 'DELETE', auth: 'user' };

    await request('/products/p1', asUser);
    await request('/products/p2', asUser);
    const error = await failureOf(request('/products/p3', asUser));

    expect(getAccessToken).toHaveBeenCalledTimes(3);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(new Headers(fetch.mock.calls[0][1].headers).get('Authorization')).toBe('Bearer token-1');
    expect(new Headers(fetch.mock.calls[1][1].headers).get('Authorization')).toBe('Bearer token-2');
    expect(error.code).toBe('UNAUTHENTICATED');
  });

  it('throws UNAUTHENTICATED for a user request without a session and sends nothing', async () => {
    const { fetch, request } = setup(() => Promise.resolve(json(200, {})), null);

    const error = await failureOf(
      request('/products', { method: 'POST', auth: 'user', body: { name: 'Lait' } }),
    );

    expect(error.code).toBe('UNAUTHENTICATED');
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each<[number, ErrorCode]>([
    [400, 'VALIDATION_ERROR'],
    [401, 'UNAUTHENTICATED'],
    [403, 'FORBIDDEN'],
    [404, 'NOT_FOUND'],
    [409, 'VALIDATION_ERROR'],
    [422, 'VALIDATION_ERROR'],
    [429, 'RATE_LIMITED'],
    [500, 'SERVER_ERROR'],
    [503, 'SERVER_ERROR'],
    [418, 'UNKNOWN'],
  ])('maps HTTP %i to %s with the message from the JSON body', async (status, code) => {
    const { request } = setup(() => Promise.resolve(json(status, { error: `Failure ${status}` })));

    const error = await failureOf(request('/products/p1', { method: 'DELETE', auth: 'user' }));

    expect(error.code).toBe(code);
    expect(error.message).toBe(`Failure ${status}`);
    expect(error.details).toMatchObject({ status, method: 'DELETE', path: '/products/p1' });
  });

  it('uses a default message when a JSON error body carries no error text', async () => {
    const { request } = setup(() => Promise.resolve(json(404, { message: 'nope' })));

    const error = await failureOf(request('/products/p1', { method: 'GET', auth: 'anon' }));

    expect(error.code).toBe('NOT_FOUND');
    expect(error.message).toBe(defaultErrorMessage('NOT_FOUND'));
  });

  it('tolerates an error body that is not JSON', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { request } = setup(() =>
      Promise.resolve(new Response('<html><body>502 Bad Gateway</body></html>', { status: 502 })),
    );

    const error = await failureOf(request('/products', { method: 'GET', auth: 'anon' }));

    expect(error.code).toBe('SERVER_ERROR');
    expect(error.message).toBe(defaultErrorMessage('SERVER_ERROR'));
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('treats a successful response that is not JSON as SERVER_ERROR', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { request } = setup(() => Promise.resolve(new Response('OK', { status: 200 })));

    const error = await failureOf(request('/settings', { method: 'GET', auth: 'anon' }));

    expect(error.code).toBe('SERVER_ERROR');
  });

  it('maps a fetch rejection to NETWORK_ERROR and keeps it as the cause', async () => {
    const offline = new TypeError('Failed to fetch');
    const { request } = setup(() => Promise.reject(offline));

    const error = await failureOf(request('/products', { method: 'GET', auth: 'anon' }));

    expect(error.code).toBe('NETWORK_ERROR');
    expect(error.cause).toBe(offline);
  });
});
