import type { OutboxMeta, OutboxRecord } from '@/features/sync/types';
import type { CashSession } from '@/ports';
import { closedHere, localSession, queueState } from './queue';

/**
 * The `terminal:<code>` Web Lock the register holds while it is on screen. It is what makes this
 * device a single writer of the terminal's receipt numbers, so a second tab must not sell.
 */
export type TerminalLock = 'pending' | 'held' | 'taken' | 'unavailable';

/**
 * What the register screen shows, in this order of precedence:
 * - `insecure`: the page is not in a secure context, so crypto, Web Locks and the queue are missing.
 * - `unregistered`: this device is not a terminal yet; an admin registers it in Settings.
 * - `locked`: another tab holds this terminal, or the browser cannot coordinate tabs at all.
 * - `blocked`: the server refused a record and the queue stops at it. Selling goes on while records
 *   are merely waiting to be sent; it stops here, because the next receipt would queue behind one
 *   that can never be recorded.
 * - `loading` / `error`: the terminal's session is being read from the server, or could not be read,
 *   and this device has no session of its own to fall back on.
 * - `closed`: the terminal has no open session; the cashier opens one.
 * - `open`: the selling screen.
 */
export type PosGate =
  | { readonly kind: 'insecure' }
  | { readonly kind: 'unregistered' }
  | { readonly kind: 'locked'; readonly reason: 'taken' | 'unavailable' }
  | { readonly kind: 'blocked'; readonly record: OutboxRecord }
  | { readonly kind: 'loading' }
  | { readonly kind: 'error'; readonly error: unknown }
  | { readonly kind: 'closed'; readonly terminal: OutboxMeta }
  | {
      readonly kind: 'open';
      readonly terminal: OutboxMeta;
      readonly session: CashSession;
      /** True for a session this device opened itself, which it knows without the server. */
      readonly isLocal: boolean;
    };

export interface PosGateInput {
  /** `window.isSecureContext`: false on plain http from another machine. */
  readonly secureContext: boolean;
  /** This device's registration, or undefined while it is still being read. */
  readonly terminal: OutboxMeta | null | undefined;
  readonly lock: TerminalLock;
  /** This device's outbox, in ordinal order. */
  readonly records: readonly OutboxRecord[];
  /** The terminal's open session as the server last answered, or undefined before any answer. */
  readonly session: CashSession | null | undefined;
  /** Why the session could not be read; null while a read is still running. */
  readonly sessionError: unknown;
}

export function posGate({
  secureContext,
  terminal,
  lock,
  records,
  session,
  sessionError,
}: PosGateInput): PosGate {
  if (!secureContext) {
    return { kind: 'insecure' };
  }
  if (terminal === undefined) {
    return { kind: 'loading' };
  }
  if (terminal === null) {
    return { kind: 'unregistered' };
  }
  if (lock === 'pending') {
    return { kind: 'loading' };
  }
  if (lock !== 'held') {
    return { kind: 'locked', reason: lock };
  }
  const { blocked } = queueState(records);
  if (blocked) {
    return { kind: 'blocked', record: blocked };
  }
  // A session this device opened is its own: it needs no answer from the server to sell in it.
  const local = localSession(terminal, records);
  if (local) {
    return { kind: 'open', terminal, session: local, isLocal: true };
  }
  if (session === undefined) {
    return sessionError ? { kind: 'error', error: sessionError } : { kind: 'loading' };
  }
  // A replayed open hands back its session as stored, which may have been closed since; and a
  // session this device closed is closed even while the server still lists it as open.
  if (session === null || session.closedAt !== null || closedHere(records, session.id)) {
    return { kind: 'closed', terminal };
  }
  return { kind: 'open', terminal, session, isLocal: false };
}
