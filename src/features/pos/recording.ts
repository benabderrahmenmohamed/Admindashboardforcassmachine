/**
 * How the register sends the records it writes (sales, refunds, session open and close) while
 * recording is online: one record at a time, kept in the terminal store's pending slot until the
 * server answers, and resent exactly as written. No React here, so it runs against fakes in tests.
 */
import { receiptNumber } from '@/features/sales/records';
import type {
  PendingRecord,
  StoredTerminal,
  TerminalStore,
} from '@/features/terminal/terminalStore';
import type { TerminalContext } from '@/features/terminal/types';
import { AppError, toAppError, type ErrorCode } from '@/lib/errors';
import { formatTND, mm, neg } from '@/lib/money';
import type {
  CloseSessionRecord,
  CloseSessionResult,
  OpenSessionRecord,
  OpenSessionResult,
  RecordSaleResult,
  SaleRecord,
} from '@/ports';

/** The part of the terminal store that recording reads and writes. */
export type RecordingStore = Pick<
  TerminalStore,
  'read' | 'readPending' | 'writePending' | 'clearPending' | 'commitSeq'
>;

/** Where records go: the record mutations of the sales and sessions hooks. */
export interface RecordingPorts {
  readonly recordSale: (record: SaleRecord) => Promise<RecordSaleResult>;
  readonly openSession: (record: OpenSessionRecord) => Promise<OpenSessionResult>;
  readonly closeSession: (record: CloseSessionRecord) => Promise<CloseSessionResult>;
}

/** A record the server answered, with its answer. */
export type RecordOutcome =
  | { readonly type: 'sale'; readonly record: SaleRecord; readonly result: RecordSaleResult }
  | {
      readonly type: 'session_open';
      readonly record: OpenSessionRecord;
      readonly result: OpenSessionResult;
    }
  | {
      readonly type: 'session_close';
      readonly record: CloseSessionRecord;
      readonly result: CloseSessionResult;
    };

/** A new record id, chosen on the device. */
export function newRecordId(): string {
  // Missing outside a secure context (a page served over plain http from another machine).
  if (typeof crypto.randomUUID !== 'function') {
    throw new AppError('CONFIG_ERROR', 'Serve the register over https to record sales.');
  }
  return crypto.randomUUID();
}

/** The registration a new record is written under. */
export function terminalContext(terminal: StoredTerminal): TerminalContext {
  return { terminalCode: terminal.code, epoch: terminal.epoch };
}

/** The number a new sale or refund takes: one past the last this device used or adopted. */
export function nextSeq(terminal: StoredTerminal): number {
  return terminal.lastSeq + 1;
}

async function deliver(pending: PendingRecord, ports: RecordingPorts): Promise<RecordOutcome> {
  switch (pending.type) {
    case 'sale':
      return {
        type: 'sale',
        record: pending.record,
        result: await ports.recordSale(pending.record),
      };
    case 'session_open':
      return {
        type: 'session_open',
        record: pending.record,
        result: await ports.openSession(pending.record),
      };
    case 'session_close':
      return {
        type: 'session_close',
        record: pending.record,
        result: await ports.closeSession(pending.record),
      };
  }
}

/**
 * Sends `pending` and settles it. A new record is stored in the pending slot first, which holds one
 * record at a time, so a lost answer never costs a receipt number: the stored record (same id, same
 * hash) is what gets resent. Once the server answers, the number is committed before the slot is
 * cleared, so a crash in between leaves a record whose resend is a harmless replay. On failure the
 * record stays pending and the error is thrown.
 */
export async function sendPending(
  pending: PendingRecord,
  store: RecordingStore,
  ports: RecordingPorts,
): Promise<RecordOutcome> {
  const stored = store.readPending();
  if (stored && stored.record.id !== pending.record.id) {
    throw new AppError(
      'VALIDATION_ERROR',
      'This device still has a record waiting to be sent. Send it before recording anything else.',
    );
  }
  if (!stored) {
    store.writePending(pending);
  }
  const outcome = await deliver(stored ?? pending, ports);
  // A voided record used its number as well. A record written under another terminal code (the
  // device was registered as something else since) never moves this device's counter.
  if (outcome.type === 'sale' && store.read()?.code === outcome.record.terminalCode) {
    store.commitSeq(outcome.record.seq);
  }
  store.clearPending();
  return outcome;
}

export type RecorderState =
  | { readonly status: 'idle' }
  /** `first`: the record was written just now, not resent from the unsent-record card. */
  | { readonly status: 'sending'; readonly id: string; readonly first: boolean }
  | { readonly status: 'failed'; readonly id: string; readonly error: AppError };

export type RecordAttempt =
  | { readonly ok: true; readonly outcome: RecordOutcome }
  /** `kept`: the record is in the pending slot; false when it never got that far. */
  | { readonly ok: false; readonly error: AppError; readonly kept: boolean };

const IDLE: RecorderState = { status: 'idle' };

/**
 * Sends records one at a time and publishes what it is doing. It is an external store (read with
 * useSyncExternalStore) so the screen sees "sending" in the same render as the new pending record.
 * Methods are plain functions, so they can be passed around unbound.
 */
export function createRecorder(store: RecordingStore) {
  let state: RecorderState = IDLE;
  const listeners = new Set<() => void>();

  const setState = (next: RecorderState): void => {
    state = next;
    listeners.forEach((listener) => listener());
  };

  const run = async (
    pending: PendingRecord,
    ports: RecordingPorts,
    first: boolean,
  ): Promise<RecordAttempt> => {
    if (state.status === 'sending') {
      return {
        ok: false,
        error: new AppError('VALIDATION_ERROR', 'A record is already being sent. Wait for it.'),
        kept: false,
      };
    }
    setState({ status: 'sending', id: pending.record.id, first });
    try {
      const outcome = await sendPending(pending, store, ports);
      setState(IDLE);
      return { ok: true, outcome };
    } catch (caught) {
      const error = toAppError(caught);
      const kept = store.readPending()?.record.id === pending.record.id;
      setState(kept ? { status: 'failed', id: pending.record.id, error } : IDLE);
      return { ok: false, error, kept };
    }
  };

  return {
    snapshot: (): RecorderState => state,

    subscribe: (listener: () => void): (() => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    /** Stores a newly written record as pending and sends it. */
    send: (pending: PendingRecord, ports: RecordingPorts): Promise<RecordAttempt> =>
      run(pending, ports, true),

    /** Resends the stored pending record exactly as it was written. */
    retry: (ports: RecordingPorts): Promise<RecordAttempt> => {
      const pending = store.readPending();
      if (!pending) {
        return Promise.resolve({
          ok: false,
          error: new AppError('VALIDATION_ERROR', 'There is no unsent record.'),
          kept: false,
        });
      }
      return run(pending, ports, false);
    },

    /** Gives up on the stored record. Offer it only once the server has refused it (canDiscard). */
    discard: (): void => {
      if (state.status === 'sending') {
        return;
      }
      store.clearPending();
      setState(IDLE);
    },
  };
}

export type Recorder = ReturnType<typeof createRecorder>;

/**
 * Answers in which the server looked at the record and refused it, so it was not stored and giving
 * it up loses nothing: its receipt number was never used and goes to the next record. Retriable and
 * auth errors, CONFIG_ERROR and UNKNOWN may hide a record that did arrive, so they are not here.
 */
const REFUSALS: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  'FORBIDDEN',
  'NOT_FOUND',
  'VALIDATION_ERROR',
  'IDEMPOTENCY_CONFLICT',
  'SEQUENCE_GAP',
  'SESSION_CLOSED',
  'SESSION_ALREADY_OPEN',
  'TERMINAL_SUPERSEDED',
]);

export function canDiscard(error: AppError): boolean {
  return REFUSALS.has(error.code);
}

function textDetail(error: AppError, key: string): string | null {
  const value = error.details?.[key];
  return typeof value === 'string' && value !== '' ? value : null;
}

function wholeDetail(error: AppError, key: string): number | null {
  const value = error.details?.[key];
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : null;
}

function units(count: number): string {
  return `${count} ${count === 1 ? 'unit' : 'units'}`;
}

/** What the cashier is told when sending `pending` failed with `error`. Decided by code only. */
export function recordErrorMessage(error: AppError, pending: PendingRecord | null): string {
  const terminalCode = pending?.record.terminalCode ?? null;
  switch (error.code) {
    case 'NETWORK_ERROR':
      return 'The server could not be reached. The record is kept on this device: retry once the connection is back.';
    case 'SERVER_ERROR':
    case 'RATE_LIMITED':
      return 'The server could not take the record just now. It is kept on this device: retry in a moment.';
    case 'UNAUTHENTICATED':
      return 'Your sign-in has expired. Sign in again, then retry: the record is kept on this device.';
    case 'TERMINAL_SUPERSEDED': {
      const code = textDetail(error, 'terminalCode') ?? terminalCode;
      const terminal = code === null ? 'This terminal' : `Terminal ${code}`;
      return `${terminal} was registered again on another device, so this device can no longer record for it. This device must be registered again: ask an admin to do it in Settings.`;
    }
    case 'SEQUENCE_GAP': {
      const expected = wholeDetail(error, 'expectedSeq');
      const received =
        wholeDetail(error, 'receivedSeq') ?? (pending?.type === 'sale' ? pending.record.seq : null);
      if (expected === null || received === null || terminalCode === null) {
        return 'Receipt numbers on this device are out of step with the server. An admin has to look at this terminal before it can record again.';
      }
      const next = receiptNumber(terminalCode, expected);
      // Registering adopts the server's counter only when it is ahead: the device's never goes back.
      return expected > received
        ? `This device is behind the server, which expects receipt ${next}. Ask an admin to register this device again so it takes the server's numbering.`
        : `This device is ahead of the server, which expects receipt ${next}: the receipts in between never reached it. Registering again does not move this device's numbering back, so an admin has to look at this terminal before it can record again.`;
    }
    case 'SESSION_CLOSED':
      return 'The session was closed before this record arrived, so it cannot be recorded in it. Open a new session to continue.';
    case 'SESSION_ALREADY_OPEN':
      return 'This terminal already has an open session, so another one cannot be opened.';
    case 'IDEMPOTENCY_CONFLICT':
      return 'The server already holds a different record under this id, so this one can never be recorded.';
    case 'FORBIDDEN': {
      const code = textDetail(error, 'terminalCode');
      if (code !== null) {
        return `Terminal ${code} is not registered in your shop. Ask an admin to register this device again.`;
      }
      if (textDetail(error, 'sessionId') !== null) {
        return 'The session on this record belongs to another terminal.';
      }
      if (textDetail(error, 'actorUserId') !== null) {
        return 'The person on this record is not a member of your shop.';
      }
      return 'Your account is not allowed to record this.';
    }
    case 'NOT_FOUND':
      if (textDetail(error, 'productId') !== null) {
        return 'A product on this record does not exist in your shop.';
      }
      if (textDetail(error, 'saleId') !== null) {
        return 'The sale being refunded does not exist in your shop.';
      }
      if (textDetail(error, 'sessionId') !== null) {
        return 'The session on this record does not exist.';
      }
      return 'Something this record names does not exist.';
    case 'VALIDATION_ERROR': {
      const lineNo = wholeDetail(error, 'lineNo');
      const remainingQty = wholeDetail(error, 'remainingQty');
      const remainingMillimes = wholeDetail(error, 'remainingMillimes');
      if (lineNo !== null && remainingQty !== null && remainingMillimes !== null) {
        const line =
          pending?.type === 'sale'
            ? pending.record.lines.find((candidate) => candidate.lineNo === lineNo)
            : undefined;
        return `${line?.productName ?? `Line ${lineNo}`}: only ${units(remainingQty)} (${formatTND(mm(remainingMillimes))}) left to refund, and a refund of the last units must pay exactly that.`;
      }
      return `This record was refused: ${error.message}`;
    }
    case 'CONFIG_ERROR':
      return `This device is not set up correctly: ${error.message}`;
    case 'UNKNOWN':
      return `Something went wrong: ${error.message}`;
  }
}

/** What the cashier is told once the server has answered a record. */
export function recordedMessage(outcome: RecordOutcome): string {
  switch (outcome.type) {
    case 'sale': {
      const { receiptNumber: number, status } = outcome.result;
      if (status === 'voided') {
        return `Receipt ${number} was voided by an admin and is not in the ledger`;
      }
      return `${outcome.record.kind === 'refund' ? 'Refund' : 'Sale'} ${number} recorded`;
    }
    case 'session_open':
      return 'Session opened';
    case 'session_close':
      return 'Session closed';
  }
}

/** One line naming an unsent record. */
export function describePending(pending: PendingRecord): string {
  switch (pending.type) {
    case 'sale': {
      const { record } = pending;
      const number = receiptNumber(record.terminalCode, record.seq);
      const method = record.payment.method === 'cash' ? 'cash' : 'card';
      return record.kind === 'refund'
        ? `Refund ${number}: ${formatTND(neg(record.totalMillimes))} paid back by ${method}`
        : `Sale ${number}: ${formatTND(record.totalMillimes)} paid by ${method}`;
    }
    case 'session_open':
      return `Opening a session on terminal ${pending.record.terminalCode} with a float of ${formatTND(pending.record.openingFloatMillimes)}`;
    case 'session_close':
      return `Closing the session on terminal ${pending.record.terminalCode} with ${formatTND(pending.record.closingCountedMillimes)} counted`;
  }
}

/** The confirmation asked before giving up on a refused record. */
export function discardQuestion(pending: PendingRecord): string {
  const refused = 'The server refused this record, so it is not in the ledger.';
  if (pending.type === 'sale') {
    const number = receiptNumber(pending.record.terminalCode, pending.record.seq);
    return `Discard it? ${refused} Receipt number ${number} goes to the next sale or refund.`;
  }
  return `Discard it? ${refused}`;
}
