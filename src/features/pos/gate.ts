import type { PendingRecord, StoredTerminal } from '@/features/terminal/terminalStore';
import type { CashSession } from '@/ports';

/**
 * What the register screen shows, in this order of precedence:
 * - `pending`: an unsent record is offered for retry before anything else can be recorded. It comes
 *   before the registration check because the record carries its own terminal code and epoch, and
 *   an admin cannot register this device again while a record is waiting.
 * - `unregistered`: this device is not a terminal yet; an admin registers it in Settings.
 * - `loading` / `error`: the terminal's open session is being read, or could not be read.
 * - `closed`: the terminal has no open session; the cashier opens one.
 * - `open`: the selling screen.
 */
export type PosGate =
  | { readonly kind: 'pending'; readonly pending: PendingRecord }
  | { readonly kind: 'unregistered' }
  | { readonly kind: 'loading' }
  | { readonly kind: 'error'; readonly error: unknown }
  | { readonly kind: 'closed'; readonly terminal: StoredTerminal }
  | { readonly kind: 'open'; readonly terminal: StoredTerminal; readonly session: CashSession };

export interface PosGateInput {
  readonly terminal: StoredTerminal | null;
  readonly pending: PendingRecord | null;
  /**
   * The id of a record on its first send. The screen that wrote it stays up while it is sent, instead
   * of the unsent-record card flashing in; the card takes over only if the send fails.
   */
  readonly firstSendId: string | null;
  /** The terminal's open session as last read, or undefined before the first answer. */
  readonly session: CashSession | null | undefined;
  /** Why the session could not be read; null while a read is still running. */
  readonly sessionError: unknown;
}

export function posGate({
  terminal,
  pending,
  firstSendId,
  session,
  sessionError,
}: PosGateInput): PosGate {
  if (pending && pending.record.id !== firstSendId) {
    return { kind: 'pending', pending };
  }
  if (!terminal) {
    return { kind: 'unregistered' };
  }
  if (session === undefined) {
    return sessionError ? { kind: 'error', error: sessionError } : { kind: 'loading' };
  }
  // A replayed open hands back its session as stored, which may have been closed since.
  if (session === null || session.closedAt !== null) {
    return { kind: 'closed', terminal };
  }
  return { kind: 'open', terminal, session };
}
