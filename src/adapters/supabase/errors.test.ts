import { AuthApiError, AuthRetryableFetchError } from '@supabase/supabase-js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppError, type ErrorCode } from '@/lib/errors';
import { defaultErrorMessage, toAuthAppError, toPostgrestAppError, unwrap } from './errors';
import { failureOf, fakeSupabase, json, raised, text, unreachable } from './fakeSupabase';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('toPostgrestAppError', () => {
  it('takes the code from message, the text from hint and camelCase details from details', () => {
    const error = toPostgrestAppError(
      {
        code: 'PT409',
        message: 'SEQUENCE_GAP',
        details: '{"expected_seq": 42, "received_seq": 43}',
        hint: 'Expected receipt T1-42.',
      },
      409,
    );

    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({
      code: 'SEQUENCE_GAP',
      message: 'Expected receipt T1-42.',
      details: { expectedSeq: 42, receivedSeq: 43 },
    });
  });

  it('renames detail keys at any depth and leaves every value as it is', () => {
    const error = toPostgrestAppError(
      {
        message: 'VALIDATION_ERROR',
        details: JSON.stringify({
          line_no: 2,
          remaining_qty: 1,
          remaining_millimes: 1250,
          field: 'payment.method',
          earlier_lines: [{ line_no: 1, refunded_qty: 3 }],
        }),
        hint: 'The refund is more than what is left to refund on this line.',
      },
      422,
    );

    expect(error.details).toEqual({
      lineNo: 2,
      remainingQty: 1,
      remainingMillimes: 1250,
      field: 'payment.method',
      earlierLines: [{ lineNo: 1, refundedQty: 3 }],
    });
  });

  it('trusts the contract code over the HTTP status', () => {
    const error = toPostgrestAppError(
      {
        message: 'TERMINAL_SUPERSEDED',
        details: '{"terminal_code": "T1", "current_epoch": 3}',
        hint: '',
      },
      400,
    );

    expect(error).toMatchObject({
      code: 'TERMINAL_SUPERSEDED',
      message: defaultErrorMessage('TERMINAL_SUPERSEDED'),
      details: { terminalCode: 'T1', currentEpoch: 3 },
    });
  });

  it.each<[string, unknown]>([
    ['not JSON', 'Key (id)=(1) already exists.'],
    ['a JSON array', '[1, 2]'],
  ])('keeps the contract code of details that are %s, without details', (_case, details) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const error = toPostgrestAppError({ message: 'FORBIDDEN', details, hint: 'No.' }, 403);

    expect(error).toMatchObject({ code: 'FORBIDDEN', message: 'No.', details: undefined });
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it.each<[number, ErrorCode]>([
    [0, 'NETWORK_ERROR'],
    [400, 'VALIDATION_ERROR'],
    [401, 'UNAUTHENTICATED'],
    [403, 'FORBIDDEN'],
    [404, 'NOT_FOUND'],
    [406, 'UNKNOWN'],
    [409, 'VALIDATION_ERROR'],
    [422, 'VALIDATION_ERROR'],
    [429, 'RATE_LIMITED'],
    [500, 'SERVER_ERROR'],
    [503, 'SERVER_ERROR'],
  ])('classifies a failure without a contract code by HTTP %i as %s', (status, code) => {
    const error = toPostgrestAppError(
      { code: '42501', message: 'permission denied for table sales', details: null, hint: null },
      status,
    );

    expect(error).toMatchObject({
      code,
      message: defaultErrorMessage(code),
      details: { status, postgrestCode: '42501' },
    });
  });
});

describe('unwrap', () => {
  it('resolves with the data of a successful response', async () => {
    const { client } = fakeSupabase(() => json({ session_id: 's-1' }));

    await expect(unwrap(client.rpc('z_report', { p_session_id: 's-1' }))).resolves.toEqual({
      session_id: 's-1',
    });
  });

  it('reads a raised contract error from the response postgrest-js hands over', async () => {
    const { client } = fakeSupabase(() =>
      raised(
        'SEQUENCE_GAP',
        409,
        { expected_seq: 42, received_seq: 43 },
        'Expected receipt T1-42.',
      ),
    );

    const error = await failureOf(unwrap(client.rpc('record_sale', { p: {} })));

    expect(error).toMatchObject({
      code: 'SEQUENCE_GAP',
      message: 'Expected receipt T1-42.',
      details: { expectedSeq: 42, receivedSeq: 43 },
    });
  });

  it('turns a request that never got a response into NETWORK_ERROR', async () => {
    const { client } = fakeSupabase(() => unreachable());

    const error = await failureOf(unwrap(client.rpc('record_sale', { p: {} })));

    expect(error).toMatchObject({ code: 'NETWORK_ERROR', details: { status: 0 } });
  });

  it('turns a proxy error page into SERVER_ERROR', async () => {
    const { client } = fakeSupabase(() => text('<html><body>502 Bad Gateway</body></html>', 502));

    const error = await failureOf(unwrap(client.from('sales').select('id')));

    expect(error).toMatchObject({ code: 'SERVER_ERROR', details: { status: 502 } });
  });

  // A throw means no response came back at all, so nothing was decided. NETWORK_ERROR is retriable;
  // UNKNOWN would be a conflict, and the outbox would stop the queue and block selling.
  it('turns a thrown failure into NETWORK_ERROR', async () => {
    const error = await failureOf(unwrap(Promise.reject(new TypeError('Failed to fetch'))));

    expect(error).toMatchObject({ code: 'NETWORK_ERROR' });
    expect(error.cause).toBeInstanceOf(TypeError);
  });

  it('keeps an AppError the request threw as it is', async () => {
    const thrown = new AppError('UNAUTHENTICATED', 'The session has ended.');

    const error = await failureOf(unwrap(Promise.reject(thrown)));

    expect(error).toBe(thrown);
  });
});

describe('toAuthAppError', () => {
  it.each<[string, unknown, ErrorCode]>([
    ['a failed connection', new AuthRetryableFetchError('Failed to fetch', 0), 'NETWORK_ERROR'],
    [
      'refused credentials',
      new AuthApiError('Invalid login credentials', 400, 'invalid_credentials'),
      'UNAUTHENTICATED',
    ],
    [
      'a malformed request',
      new AuthApiError('Password is too short', 400, 'validation_failed'),
      'VALIDATION_ERROR',
    ],
    [
      'a rate limit',
      new AuthApiError('Too many requests', 429, 'over_request_rate_limit'),
      'RATE_LIMITED',
    ],
    ['a server failure', new AuthApiError('Boom', 500, 'unexpected_failure'), 'SERVER_ERROR'],
    ['anything else', new TypeError('Cannot read properties of undefined'), 'UNKNOWN'],
  ])('maps %s to %s', (_case, thrown, code) => {
    expect(toAuthAppError(thrown).code).toBe(code);
  });

  it('keeps an AppError as it is', () => {
    const error = new AppError('FORBIDDEN', 'No membership');

    expect(toAuthAppError(error)).toBe(error);
  });
});
