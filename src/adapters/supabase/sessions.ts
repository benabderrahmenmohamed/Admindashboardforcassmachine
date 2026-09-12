import { keysToCamel } from '@/lib/caseConversion';
import {
  cashSessionSchema,
  closeSessionRecordSchema,
  closeSessionResultSchema,
  openSessionRecordSchema,
  openSessionResultSchema,
  zReportSchema,
  type CashSession,
  type SessionsPort,
} from '@/ports';
import type { SupabaseDatabaseClient } from './client';
import type { Tables } from './database.types';
import { unwrap } from './errors';
import { parseInput, parseOutput } from './validate';
import { fromWire, toWire } from './wire';

const SESSION_COLUMNS =
  'id, terminal_id, opened_by, opened_at, opening_float_millimes, closed_at, closed_by, closing_counted_millimes, force_close_reason, server_z_report, terminals(code)';

type SessionRow = Pick<
  Tables<'cash_sessions'>,
  | 'id'
  | 'terminal_id'
  | 'opened_by'
  | 'opened_at'
  | 'opening_float_millimes'
  | 'closed_at'
  | 'closed_by'
  | 'closing_counted_millimes'
  | 'force_close_reason'
  | 'server_z_report'
> & { readonly terminals: { readonly code: string } | null };

function toCashSession(row: SessionRow): CashSession {
  return parseOutput(
    cashSessionSchema,
    {
      id: row.id,
      terminalId: row.terminal_id,
      terminalCode: row.terminals?.code ?? '',
      openedBy: row.opened_by,
      openedAt: row.opened_at,
      openingFloatMillimes: row.opening_float_millimes,
      closedAt: row.closed_at,
      closedBy: row.closed_by,
      closingCountedMillimes: row.closing_counted_millimes,
      forceCloseReason: row.force_close_reason,
      zReport: keysToCamel(row.server_z_report),
    },
    `session ${row.id}`,
  );
}

/**
 * SessionsPort over open_session, close_session and z_report, which apply the order of checks in
 * contracts/errors.md, and the cash_sessions table for the open session of a terminal.
 */
export function createSupabaseSessions(client: SupabaseDatabaseClient): SessionsPort {
  return {
    async open(record) {
      const payload = parseInput(openSessionRecordSchema, record);
      const data = await unwrap(client.rpc('open_session', { p: toWire(payload) }));
      return fromWire(openSessionResultSchema, data, 'the opened session');
    },

    async close(record) {
      const payload = parseInput(closeSessionRecordSchema, record);
      const data = await unwrap(client.rpc('close_session', { p: toWire(payload) }));
      return fromWire(closeSessionResultSchema, data, 'the closed session');
    },

    async current(terminalId) {
      const row = await unwrap(
        client
          .from('cash_sessions')
          .select(SESSION_COLUMNS)
          .eq('terminal_id', terminalId)
          .is('closed_at', null)
          .maybeSingle(),
      );
      return row === null ? null : toCashSession(row);
    },

    async zReport(sessionId) {
      const data = await unwrap(client.rpc('z_report', { p_session_id: sessionId }));
      return fromWire(zReportSchema, data, 'the Z-report');
    },
  };
}
