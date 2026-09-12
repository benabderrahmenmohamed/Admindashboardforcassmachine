import { describe, expect, it } from 'vitest';
import { mm } from '@/lib/money';
import type { CloseSessionRecord, OpenSessionRecord, ZReport } from '@/ports';
import { failureOf, fakeSupabase, json, raised, routes, type FakeHandler } from './fakeSupabase';
import { createSupabaseSessions } from './sessions';

function setup(handler: FakeHandler) {
  const { client, calls } = fakeSupabase(handler);
  return { calls, sessions: createSupabaseSessions(client) };
}

const SESSION_ID = '5f0c2a3e-7b1d-4e8a-9c6f-2d4b8a1e3c70';

const openRecord: OpenSessionRecord = {
  id: SESSION_ID,
  terminalCode: 'T1',
  epoch: 1,
  actorUserId: 'user-cashier',
  openedAt: '2026-09-11T08:00:00.000Z',
  openingFloatMillimes: mm(50000),
  payloadHash: '0f'.repeat(32),
};

const zReport: ZReport = {
  sessionId: SESSION_ID,
  openingFloatMillimes: mm(50000),
  salesCount: 3,
  refundsCount: 1,
  grossMillimes: mm(15500),
  refundsMillimes: mm(1250),
  netMillimes: mm(14250),
  byMethod: {
    cash: { salesMillimes: mm(13550), refundsMillimes: mm(1250), netMillimes: mm(12300) },
    card: { salesMillimes: mm(1950), refundsMillimes: mm(0), netMillimes: mm(1950) },
  },
  expectedCashMillimes: mm(62300),
  countedCashMillimes: mm(62000),
  varianceMillimes: mm(-300),
  voidsCount: 0,
};

/** The same report as private.compute_z_report writes it. */
const zReportJson = {
  session_id: SESSION_ID,
  opening_float_millimes: 50000,
  sales_count: 3,
  refunds_count: 1,
  gross_millimes: 15500,
  refunds_millimes: 1250,
  net_millimes: 14250,
  by_method: {
    cash: { sales_millimes: 13550, refunds_millimes: 1250, net_millimes: 12300 },
    card: { sales_millimes: 1950, refunds_millimes: 0, net_millimes: 1950 },
  },
  expected_cash_millimes: 62300,
  counted_cash_millimes: 62000,
  variance_millimes: -300,
  voids_count: 0,
};

const closeRecord: CloseSessionRecord = {
  id: '9a1d3c5e-2b4f-4a6c-8d0e-1f3a5c7e9b20',
  sessionId: SESSION_ID,
  terminalCode: 'T1',
  epoch: 1,
  actorUserId: 'user-cashier',
  closedAt: '2026-09-11T18:00:00.000Z',
  closingCountedMillimes: mm(62000),
  clientZReport: zReport,
  payloadHash: 'c3'.repeat(32),
};

const openSessionRow = {
  id: SESSION_ID,
  terminal_id: 'term-1',
  opened_by: 'user-cashier',
  opened_at: '2026-09-11T08:00:00+00:00',
  opening_float_millimes: 50000,
  closed_at: null,
  closed_by: null,
  closing_counted_millimes: null,
  force_close_reason: null,
  server_z_report: null,
  terminals: { code: 'T1' },
};

describe('supabase sessions', () => {
  it('opens a session with the record in snake_case and its hash unchanged', async () => {
    const { calls, sessions } = setup(
      routes({
        'POST /rest/v1/rpc/open_session': () =>
          json({
            session_id: SESSION_ID,
            status: 'created',
            session: {
              ...openSessionRow,
              terminals: undefined,
              server_z_report: undefined,
              terminal_code: 'T1',
              z_report: null,
            },
          }),
      }),
    );

    const result = await sessions.open(openRecord);

    expect(calls[0].body).toEqual({
      p: {
        id: SESSION_ID,
        terminal_code: 'T1',
        epoch: 1,
        actor_user_id: 'user-cashier',
        opened_at: '2026-09-11T08:00:00.000Z',
        opening_float_millimes: 50000,
        payload_hash: '0f'.repeat(32),
      },
    });
    expect(result).toEqual({
      sessionId: SESSION_ID,
      status: 'created',
      session: {
        id: SESSION_ID,
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

  it('passes SESSION_ALREADY_OPEN on with the id of the open session', async () => {
    const { sessions } = setup(() =>
      raised('SESSION_ALREADY_OPEN', 409, { open_session_id: 'session-0' }),
    );

    const error = await failureOf(sessions.open(openRecord));

    expect(error).toMatchObject({
      code: 'SESSION_ALREADY_OPEN',
      details: { openSessionId: 'session-0' },
    });
  });

  it('closes a session, renaming the keys inside the client Z-report too', async () => {
    const { calls, sessions } = setup(
      routes({
        'POST /rest/v1/rpc/close_session': () =>
          json({ session_id: SESSION_ID, status: 'replayed', z_report: zReportJson }),
      }),
    );

    const result = await sessions.close(closeRecord);

    expect(calls[0].body).toEqual({
      p: {
        id: '9a1d3c5e-2b4f-4a6c-8d0e-1f3a5c7e9b20',
        session_id: SESSION_ID,
        terminal_code: 'T1',
        epoch: 1,
        actor_user_id: 'user-cashier',
        closed_at: '2026-09-11T18:00:00.000Z',
        closing_counted_millimes: 62000,
        client_z_report: zReportJson,
        payload_hash: 'c3'.repeat(32),
      },
    });
    expect(result).toEqual({ sessionId: SESSION_ID, status: 'replayed', zReport });
  });

  it('rejects a record without a valid payload hash, sending nothing', async () => {
    const { calls, sessions } = setup(() => json({}));

    const error = await failureOf(sessions.close({ ...closeRecord, payloadHash: 'C3' }));

    expect(error.code).toBe('VALIDATION_ERROR');
    expect(calls).toEqual([]);
  });

  it('reads the open session of a terminal from cash_sessions', async () => {
    const { calls, sessions } = setup(
      routes({ 'GET /rest/v1/cash_sessions': () => json([openSessionRow]) }),
    );

    const session = await sessions.current('term-1');

    expect(calls[0].query.get('select')).toBe(
      'id,terminal_id,opened_by,opened_at,opening_float_millimes,closed_at,closed_by,closing_counted_millimes,force_close_reason,server_z_report,terminals(code)',
    );
    expect(calls[0].query.get('terminal_id')).toBe('eq.term-1');
    expect(calls[0].query.get('closed_at')).toBe('is.null');
    expect(session).toEqual({
      id: SESSION_ID,
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
    });
  });

  it('is null for a terminal without an open session', async () => {
    const { sessions } = setup(() => json([]));

    await expect(sessions.current('term-1')).resolves.toBeNull();
  });

  it('reads a Z-report in camelCase', async () => {
    const { calls, sessions } = setup(
      routes({ 'POST /rest/v1/rpc/z_report': () => json(zReportJson) }),
    );

    await expect(sessions.zReport(SESSION_ID)).resolves.toEqual(zReport);
    expect(calls[0].body).toEqual({ p_session_id: SESSION_ID });
  });

  it('passes NOT_FOUND on with the session id', async () => {
    const { sessions } = setup(() =>
      raised('NOT_FOUND', 404, { session_id: 'session-x' }, 'The session does not exist.'),
    );

    const error = await failureOf(sessions.zReport('session-x'));

    expect(error).toMatchObject({ code: 'NOT_FOUND', details: { sessionId: 'session-x' } });
  });
});
