import { AppError } from '@/lib/errors';
import type { CloseSessionResult, OpenSessionResult, SessionsPort } from '@/ports';
import {
  openSessionOn,
  requireEpoch,
  requireMember,
  sessionView,
  storedZReport,
  terminalFor,
  zReportOf,
} from './ledger';
import { closeSessionInput, openSessionInput } from './shapes';
import type { SessionRow } from './store';
import {
  invalidField,
  parseInput,
  parseTimestamp,
  parseUuid,
  perform,
  requireProfile,
  type MemoryContext,
} from './support';

/**
 * Cash sessions, as open_session, close_session and z_report, in their order of checks
 * (contracts/errors.md): caller, terminal, replay, registration, session, then the record's own
 * values. Any member may open or close a session; only the terminal that owns it closes it.
 */
export function createMemorySessions(context: MemoryContext): SessionsPort {
  const { store } = context;

  return {
    open: (record) =>
      perform(context, 'sessions.open', (): OpenSessionResult => {
        const profile = requireProfile(context);
        const input = parseInput(openSessionInput, record);
        const id = input.id.toLowerCase();
        const terminal = terminalFor(store, profile.shopId, input.terminalCode);

        const existing = store.sessions.get(id);
        if (existing) {
          if (existing.shopId !== profile.shopId) {
            throw new AppError('FORBIDDEN', 'This session belongs to another shop.');
          }
          if (existing.openPayloadHash !== input.payloadHash) {
            throw new AppError(
              'IDEMPOTENCY_CONFLICT',
              'A different session was already opened under this id.',
              { details: { id } },
            );
          }
          return { sessionId: id, status: 'replayed', session: sessionView(store, existing) };
        }

        requireEpoch(terminal, input.epoch);
        const open = openSessionOn(store, terminal.id);
        if (open) {
          throw new AppError('SESSION_ALREADY_OPEN', 'This terminal already has an open session.', {
            details: { openSessionId: open.id },
          });
        }
        const actor = parseUuid(input.actorUserId, 'actor_user_id');
        requireMember(store, profile.shopId, actor);
        if (input.openingFloatMillimes < 0) {
          throw invalidField('opening_float_millimes', 'The opening float cannot be negative.');
        }

        const session: SessionRow = {
          id,
          shopId: profile.shopId,
          terminalId: terminal.id,
          openedBy: actor,
          openSubmittedBy: profile.userId,
          openedAt: parseTimestamp(input.openedAt, 'opened_at'),
          openReceivedAt: context.now().toISOString(),
          openingFloatMillimes: input.openingFloatMillimes,
          openPayloadHash: input.payloadHash,
          closeRequestId: null,
          closedAt: null,
          closedBy: null,
          closeSubmittedBy: null,
          closeReceivedAt: null,
          closingCountedMillimes: null,
          closePayloadHash: null,
          serverZReport: null,
          clientZReport: null,
        };
        store.sessions.set(id, session);
        return { sessionId: id, status: 'created', session: sessionView(store, session) };
      }),

    close: (record) =>
      perform(context, 'sessions.close', (): CloseSessionResult => {
        const profile = requireProfile(context);
        const input = parseInput(closeSessionInput, record);
        const requestId = input.id.toLowerCase();
        const terminal = terminalFor(store, profile.shopId, input.terminalCode);

        const closed = Array.from(store.sessions.values()).find(
          (candidate) => candidate.closeRequestId === requestId,
        );
        if (closed) {
          if (closed.shopId !== profile.shopId) {
            throw new AppError('FORBIDDEN', 'This session belongs to another shop.');
          }
          if (closed.closePayloadHash !== input.payloadHash) {
            throw new AppError(
              'IDEMPOTENCY_CONFLICT',
              'A different close was already stored under this id.',
              { details: { id: requestId } },
            );
          }
          return { sessionId: closed.id, status: 'replayed', zReport: storedZReport(closed) };
        }

        requireEpoch(terminal, input.epoch);
        const sessionId = parseUuid(input.sessionId, 'session_id');
        const session = store.sessions.get(sessionId);
        if (!session) {
          throw new AppError('NOT_FOUND', 'The session does not exist.', {
            details: { sessionId },
          });
        }
        if (session.shopId !== profile.shopId || session.terminalId !== terminal.id) {
          throw new AppError('FORBIDDEN', 'Only the terminal that opened a session can close it.', {
            details: { sessionId: session.id },
          });
        }
        if (session.closedAt !== null) {
          throw new AppError('SESSION_CLOSED', 'The session is already closed.', {
            details: { sessionId: session.id },
          });
        }
        const actor = parseUuid(input.actorUserId, 'actor_user_id');
        requireMember(store, profile.shopId, actor);
        if (input.closingCountedMillimes < 0) {
          throw invalidField('closing_counted_millimes', 'Counted cash cannot be negative.');
        }
        const closedAt = parseTimestamp(input.closedAt, 'closed_at');

        const report = zReportOf(store, session, input.closingCountedMillimes);
        store.sessions.set(session.id, {
          ...session,
          closeRequestId: requestId,
          closedAt,
          closedBy: actor,
          closeSubmittedBy: profile.userId,
          closeReceivedAt: context.now().toISOString(),
          closingCountedMillimes: input.closingCountedMillimes,
          closePayloadHash: input.payloadHash,
          serverZReport: report,
          clientZReport: input.clientZReport,
        });
        return { sessionId: session.id, status: 'created', zReport: structuredClone(report) };
      }),

    current: (terminalId) =>
      perform(context, 'sessions.current', () => {
        const profile = requireProfile(context);
        const id = parseUuid(terminalId, 'terminal_id');
        const open = openSessionOn(store, id);
        if (!open || open.shopId !== profile.shopId) {
          return null;
        }
        return sessionView(store, open);
      }),

    zReport: (sessionId) =>
      perform(context, 'sessions.zReport', () => {
        const profile = requireProfile(context);
        const id = parseUuid(sessionId, 'session_id');
        const session = store.sessions.get(id);
        if (!session) {
          throw new AppError('NOT_FOUND', 'The session does not exist.', {
            details: { sessionId: id },
          });
        }
        if (session.shopId !== profile.shopId) {
          throw new AppError('FORBIDDEN', 'This session belongs to another shop.', {
            details: { sessionId: id },
          });
        }
        return session.closedAt === null ? zReportOf(store, session, null) : storedZReport(session);
      }),
  };
}
