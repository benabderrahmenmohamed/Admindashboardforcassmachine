import { describe, expect, it } from 'vitest';
import { failureOf, fakeSupabase, json, raised, routes } from './fakeSupabase';
import { createSupabaseTerminals } from './terminals';

describe('supabase terminals', () => {
  it('registers the code as the database stores it and reads the registration in camelCase', async () => {
    const { client, calls } = fakeSupabase(
      routes({
        'POST /rest/v1/rpc/register_terminal': () =>
          json({
            terminal_id: 'term-1',
            code: 'T1',
            last_seq: 41,
            epoch: 3,
            open_session: {
              id: 'session-1',
              terminal_id: 'term-1',
              terminal_code: 'T1',
              opened_by: 'user-cashier',
              opened_at: '2026-09-11T08:00:00+00:00',
              opening_float_millimes: 50000,
              closed_at: null,
              closed_by: null,
              closing_counted_millimes: null,
              force_close_reason: null,
              z_report: null,
            },
          }),
      }),
    );

    const registration = await createSupabaseTerminals(client).register(' t1 ');

    expect(calls[0].body).toEqual({ p_code: 'T1' });
    expect(registration).toEqual({
      terminalId: 'term-1',
      code: 'T1',
      lastSeq: 41,
      epoch: 3,
      openSession: {
        id: 'session-1',
        terminalId: 'term-1',
        terminalCode: 'T1',
        openedBy: 'user-cashier',
        openedAt: '2026-09-11T08:00:00+00:00',
        openingFloatMillimes: 50000,
        closedAt: null,
        closedBy: null,
        closingCountedMillimes: null,
        forceCloseReason: null,
        zReport: null,
      },
    });
  });

  it('rejects a code the database would refuse without sending it', async () => {
    const { client, calls } = fakeSupabase(() => json({}));

    const error = await failureOf(createSupabaseTerminals(client).register('T-1'));

    expect(error.code).toBe('VALIDATION_ERROR');
    expect(calls).toEqual([]);
  });

  it('passes FORBIDDEN on for a cashier', async () => {
    const { client } = fakeSupabase(() =>
      raised('FORBIDDEN', 403, { role: 'cashier' }, 'Your role cannot do this.'),
    );

    const error = await failureOf(createSupabaseTerminals(client).register('T1'));

    expect(error).toMatchObject({
      code: 'FORBIDDEN',
      message: 'Your role cannot do this.',
      details: { role: 'cashier' },
    });
  });
});
