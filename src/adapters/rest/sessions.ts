import { z } from 'zod';
import { parseOrInvalid } from '@/lib/validation';
import {
  cashSessionSchema,
  closeSessionRecordSchema,
  closeSessionResultSchema,
  openSessionRecordSchema,
  openSessionResultSchema,
  zReportSchema,
  type SessionsPort,
} from '@/ports';
import type { RestClient } from './http';
import { pathSegment } from './paths';
import { fromWire, toWire, type WireCloseSessionRecord, type WireOpenSessionRecord } from './wire';
import { checkWriteOutcome } from './writes';

const sessionsSchema = z.array(cashSessionSchema);
const terminalIdSchema = z.string().min(1);

/**
 * SessionsPort over /cash-sessions. Opens and closes carry the record the terminal wrote, so they
 * are idempotent by its id: 201 for the session this record opened or closed now, 200 for a replay,
 * which answers with the Z-report stored at close time (contracts/errors.md).
 */
export function createRestSessions(client: RestClient): SessionsPort {
  return {
    async open(record) {
      const payload = parseOrInvalid(openSessionRecordSchema, record, 'the session record');
      const response = await client.request('POST', '/cash-sessions', {
        body: toWire<WireOpenSessionRecord>(payload),
      });
      const result = fromWire(openSessionResultSchema, response.body, 'the opened session');
      checkWriteOutcome(response.status, result.status, 'created', 'an opened session');
      return result;
    },

    async close(record) {
      const payload = parseOrInvalid(closeSessionRecordSchema, record, 'the close record');
      // The session the record names owns the closure; the record goes in the body as it was
      // written, so the server sees the same payload the hash was taken over.
      const response = await client.request(
        'POST',
        `/cash-sessions/${pathSegment(payload.sessionId, 'the session id')}/closures`,
        { body: toWire<WireCloseSessionRecord>(payload) },
      );
      const result = fromWire(closeSessionResultSchema, response.body, 'the closed session');
      checkWriteOutcome(response.status, result.status, 'created', 'a closed session');
      return result;
    },

    async current(terminalId) {
      const id = parseOrInvalid(terminalIdSchema, terminalId, 'the terminal id');
      const response = await client.request('GET', '/cash-sessions', {
        query: { terminal_id: id, status: 'open' },
      });
      const sessions = fromWire(sessionsSchema, response.body, "the terminal's sessions");
      // `status=open` answers with at most one session (contracts/openapi.yaml).
      return sessions.length === 0 ? null : sessions[0];
    },

    async zReport(sessionId) {
      const response = await client.request(
        'GET',
        `/cash-sessions/${pathSegment(sessionId, 'the session id')}/z-report`,
      );
      return fromWire(zReportSchema, response.body, 'the Z-report');
    },
  };
}
