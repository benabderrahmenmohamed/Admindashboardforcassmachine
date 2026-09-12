import { describe, expect, it } from 'vitest';
import { isAppError, type ErrorCode } from '@/lib/errors';
import { createRestClient, toRestError } from './http';

const BASE_URL = 'http://api.test/api/v1';

interface Call {
  readonly url: string;
  readonly init: RequestInit;
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** What a call was made to, however fetch was given it. */
function urlOf(input: RequestInfo | URL): string {
  if (input instanceof URL) {
    return input.href;
  }
  return typeof input === 'string' ? input : input.url;
}

/** A client whose fetch answers with `respond`, and the calls it made. */
function clientAnswering(
  respond: () => Promise<Response>,
  token: string | null = 'token-1',
): { readonly calls: Call[]; readonly client: ReturnType<typeof createRestClient> } {
  const calls: Call[] = [];
  const doFetch: typeof fetch = (input, init) => {
    calls.push({ url: urlOf(input), init: init ?? {} });
    return respond();
  };
  return {
    calls,
    client: createRestClient({ baseUrl: BASE_URL, fetch: doFetch, getToken: () => token }),
  };
}

function answering(body: unknown, status = 200): ReturnType<typeof clientAnswering> {
  return clientAnswering(() => Promise.resolve(jsonResponse(body, status)));
}

/** Fails the test unless `promise` rejects with an AppError of `code`. */
async function rejectsWith(promise: Promise<unknown>, code: ErrorCode): Promise<unknown> {
  const outcome = await promise.then(
    (value: unknown) => ({ settled: 'resolved' as const, value }),
    (error: unknown) => ({ settled: 'rejected' as const, error }),
  );
  if (outcome.settled === 'resolved') {
    return expect.unreachable(`Expected ${code}, got ${JSON.stringify(outcome.value)}`);
  }
  if (!isAppError(outcome.error)) {
    return expect.unreachable(`Expected an AppError ${code}, got ${String(outcome.error)}`);
  }
  expect(outcome.error.code, outcome.error.message).toBe(code);
  return outcome.error.details;
}

describe('the REST client', () => {
  it('sends the bearer token, a JSON body and the query it is given', async () => {
    const { client, calls } = answering({ ok: true });

    const response = await client.request('POST', '/sales', {
      body: { terminalCode: 'T1' },
      query: { limit: 2, terminal_id: 'T1', session_id: undefined },
    });

    expect(response).toEqual({ status: 200, body: { ok: true } });
    expect(calls).toHaveLength(1);
    // An undefined query value is left out rather than sent as "undefined".
    expect(calls[0].url).toBe(`${BASE_URL}/sales?limit=2&terminal_id=T1`);
    const headers = new Headers(calls[0].init.headers);
    expect(headers.get('Authorization')).toBe('Bearer token-1');
    expect(headers.get('Content-Type')).toBe('application/json');
    expect(headers.get('Accept')).toBe('application/json');
    expect(calls[0].init.method).toBe('POST');
    expect(calls[0].init.body).toBe(JSON.stringify({ terminalCode: 'T1' }));
  });

  it('sends no Content-Type when there is no body', async () => {
    const { client, calls } = answering(null);

    await client.request('POST', '/terminals/T1/registrations');

    expect(new Headers(calls[0].init.headers).get('Content-Type')).toBeNull();
    expect(calls[0].init.body).toBeUndefined();
  });

  it('refuses to send a request without a token, and sends nothing', async () => {
    const { client, calls } = clientAnswering(() => Promise.resolve(jsonResponse(null, 200)), null);

    await rejectsWith(client.request('GET', '/products'), 'UNAUTHENTICATED');

    expect(calls).toHaveLength(0);
  });

  it('sends no token for the one request that needs none', async () => {
    const { client, calls } = clientAnswering(
      () => Promise.resolve(jsonResponse({ access_token: 'a' }, 200)),
      null,
    );

    await client.request('POST', '/auth/token', { auth: false, body: { email: 'a@b.c' } });

    expect(new Headers(calls[0].init.headers).get('Authorization')).toBeNull();
  });

  it('reads an empty body as null, so a 204 is an answer like any other', async () => {
    const { client } = clientAnswering(() => Promise.resolve(new Response(null, { status: 204 })));

    await expect(client.request('DELETE', '/products/1')).resolves.toEqual({
      status: 204,
      body: null,
    });
  });

  it('is NETWORK_ERROR when the request never got a response', async () => {
    const { client } = clientAnswering(() => Promise.reject(new TypeError('fetch failed')));

    await rejectsWith(client.request('GET', '/products'), 'NETWORK_ERROR');
  });

  it('is SERVER_ERROR when a successful response is not JSON', async () => {
    const { client } = clientAnswering(() =>
      Promise.resolve(new Response('<html>proxy</html>', { status: 200 })),
    );

    await rejectsWith(client.request('GET', '/products'), 'SERVER_ERROR');
  });
});

describe('an answer the request failed on', () => {
  const byStatus: readonly (readonly [number, ErrorCode])[] = [
    [400, 'VALIDATION_ERROR'],
    [401, 'UNAUTHENTICATED'],
    [403, 'FORBIDDEN'],
    [404, 'NOT_FOUND'],
    [409, 'VALIDATION_ERROR'],
    [422, 'VALIDATION_ERROR'],
    [429, 'RATE_LIMITED'],
    [500, 'SERVER_ERROR'],
    [503, 'SERVER_ERROR'],
  ];

  it.each(byStatus)(
    'with no contract code is classified by its status: %i is %s',
    async (status, code) => {
      // A proxy error page: a failed response whose body is not even JSON.
      const { client } = clientAnswering(() =>
        Promise.resolve(new Response('<html>Gateway</html>', { status })),
      );

      const details = await rejectsWith(client.request('GET', '/products'), code);

      expect(details).toMatchObject({ status });
    },
  );

  const byEnvelope: readonly (readonly [ErrorCode, number])[] = [
    ['UNAUTHENTICATED', 401],
    ['FORBIDDEN', 403],
    ['NOT_FOUND', 404],
    ['VALIDATION_ERROR', 422],
    ['IDEMPOTENCY_CONFLICT', 409],
    ['SEQUENCE_GAP', 409],
    ['SESSION_CLOSED', 409],
    ['SESSION_ALREADY_OPEN', 409],
    ['TERMINAL_SUPERSEDED', 409],
    ['RATE_LIMITED', 429],
    ['SERVER_ERROR', 500],
  ];

  it.each(byEnvelope)('carrying the contract code %s arrives as %s', async (code, status) => {
    const { client } = answering({ error: { code, message: 'Told to a person.' } }, status);

    await rejectsWith(client.request('POST', '/sales', { body: {} }), code);
  });

  it('takes the code from the envelope even when the status says otherwise', async () => {
    const { client } = answering(
      { error: { code: 'SEQUENCE_GAP', message: 'Expected receipt T1-42.' } },
      500,
    );

    await rejectsWith(client.request('POST', '/sales', { body: {} }), 'SEQUENCE_GAP');
  });

  it('reads the details of an envelope as camelCase, next to the status', async () => {
    const { client } = answering(
      {
        error: {
          code: 'SEQUENCE_GAP',
          message: 'Expected receipt T1-42.',
          details: { expected_seq: 42, received_seq: 43 },
        },
      },
      409,
    );

    const details = await rejectsWith(
      client.request('POST', '/sales', { body: {} }),
      'SEQUENCE_GAP',
    );

    expect(details).toEqual({ expectedSeq: 42, receivedSeq: 43, status: 409 });
  });

  it('falls back to the status for a code the app does not know', async () => {
    const { client } = answering({ error: { code: 'TEAPOT', message: 'Short and stout.' } }, 409);

    await rejectsWith(client.request('GET', '/products'), 'VALIDATION_ERROR');
  });
});

describe('toRestError', () => {
  it('classifies a body that is not an envelope by the status alone', () => {
    for (const body of [
      null,
      'a string',
      [1, 2],
      { error: 'not an object' },
      { code: 'NOT_FOUND' },
    ]) {
      const error = toRestError(404, body);
      expect(error.code).toBe('NOT_FOUND');
      expect(error.details).toEqual({ status: 404 });
    }
  });

  it('keeps the envelope message for a person and falls back to the code', () => {
    expect(
      toRestError(409, { error: { code: 'SESSION_CLOSED', message: 'Closed at 18:00.' } }),
    ).toMatchObject({ code: 'SESSION_CLOSED', message: 'Closed at 18:00.' });
    expect(toRestError(409, { error: { code: 'SESSION_CLOSED', message: '' } })).toMatchObject({
      code: 'SESSION_CLOSED',
      message: 'SESSION_CLOSED',
    });
  });
});
