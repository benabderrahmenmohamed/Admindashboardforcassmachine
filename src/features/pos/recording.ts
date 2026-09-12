/**
 * What a person is told about a record the register wrote: what it is, what happened to it, and
 * what to do about it. Every message is decided from the error's code, never from its message text,
 * and the POS and the Conflicts screen both read them here so they say the same thing.
 * No React here, so it runs against fakes in tests.
 */
import { receiptNumber } from '@/features/sales/records';
import type { OutboxError, OutboxMeta, OutboxRecord } from '@/features/sync/types';
import type { TerminalContext } from '@/features/terminal/types';
import { AppError, type ErrorCode } from '@/lib/errors';
import { formatTND, mm, neg } from '@/lib/money';
import { isNumbered, syncStatus, type NumberedRecord, type SyncStatus } from './queue';

/** A new record id, chosen on the device. */
export function newRecordId(): string {
  // Missing outside a secure context (a page served over plain http from another machine).
  if (typeof crypto.randomUUID !== 'function') {
    throw new AppError('CONFIG_ERROR', 'Serve the register over https to record sales.');
  }
  return crypto.randomUUID();
}

/** The registration a new record is written under. */
export function terminalContext(meta: OutboxMeta): TerminalContext {
  return { terminalCode: meta.code, epoch: meta.epoch };
}

/** The receipt number a sale or refund took when it was written. */
export function receiptOf(record: NumberedRecord): string {
  return receiptNumber(record.terminalCode, record.seq);
}

/**
 * Answers in which the server looked at the record and refused it, so it will never hold it: its
 * receipt number can be voided and the queue moved on. Retriable and auth errors, CONFIG_ERROR and
 * UNKNOWN may hide a record that did arrive, so they are not here.
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
  // A payment refused because the table moved under it is refused for good: the same lines will
  // never match again, so its receipt number can be voided and the queue moved on.
  'ORDER_CHANGED',
  'ORDER_CLOSED',
  'ITEM_NOT_FOUND',
  'TABLE_INACTIVE',
]);

export function isRefusal(code: ErrorCode): boolean {
  return REFUSALS.has(code);
}

/**
 * Whether an admin can void `record`: only a numbered record the server refused. Voiding spends its
 * receipt number on a void row, which is what keeps numbering gapless once a record is given up on.
 */
export function canVoid(record: OutboxRecord): boolean {
  return (
    isNumbered(record) &&
    record.status === 'conflict' &&
    record.lastError !== null &&
    isRefusal(record.lastError.code)
  );
}

function textDetail(error: OutboxError, key: string): string | null {
  const value = error.details?.[key];
  return typeof value === 'string' && value !== '' ? value : null;
}

function wholeDetail(error: OutboxError, key: string): number | null {
  const value = error.details?.[key];
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : null;
}

function units(count: number): string {
  return `${count} ${count === 1 ? 'unit' : 'units'}`;
}

/** What a person is told when sending `record` failed with `error`. Decided by code only. */
export function recordErrorMessage(error: OutboxError, record: OutboxRecord | null): string {
  const terminalCode = record?.terminalCode ?? null;
  switch (error.code) {
    case 'NETWORK_ERROR':
      return 'The server could not be reached. The record is kept on this device and goes out on its own once the connection is back.';
    case 'SERVER_ERROR':
    case 'RATE_LIMITED':
      return 'The server could not take the record just now. It is kept on this device and tried again in a moment.';
    case 'UNAUTHENTICATED':
      return 'Your sign-in has expired. Sign in again and the queue starts moving: the record is kept on this device.';
    case 'TERMINAL_SUPERSEDED': {
      const code = textDetail(error, 'terminalCode') ?? terminalCode;
      const terminal = code === null ? 'This terminal' : `Terminal ${code}`;
      return `${terminal} was registered again on another device, so this device can no longer record for it. This device must be registered again: ask an admin to do it in Settings.`;
    }
    case 'SEQUENCE_GAP': {
      const expected = wholeDetail(error, 'expectedSeq');
      const received =
        wholeDetail(error, 'receivedSeq') ?? (record && isNumbered(record) ? record.seq : null);
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
    case 'ORDER_CHANGED':
      return 'The table changed before this payment arrived: something on it had already been paid, taken off or altered. Read the table again and take the payment afresh.';
    case 'ORDER_CLOSED':
      return 'That table was paid or cancelled before this record arrived, so there is nothing left on it to pay for.';
    case 'ITEM_NOT_FOUND':
      return 'An item this record pays for is no longer on the table.';
    case 'TABLE_INACTIVE':
      return 'That table is out of service, so nothing can be recorded against it.';
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
          record && isNumbered(record)
            ? record.payload.lines.find((candidate) => candidate.lineNo === lineNo)
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

/** One line naming a record in the queue. */
export function describeRecord(record: OutboxRecord): string {
  switch (record.kind) {
    case 'sale':
    case 'refund': {
      const number = receiptOf(record);
      const method = record.payload.payment.method === 'cash' ? 'cash' : 'card';
      return record.kind === 'refund'
        ? `Refund ${number}: ${formatTND(neg(record.payload.totalMillimes))} paid back by ${method}`
        : `Sale ${number}: ${formatTND(record.payload.totalMillimes)} paid by ${method}`;
    }
    case 'session_open':
      return `Opening a session on terminal ${record.terminalCode} with a float of ${formatTND(record.payload.openingFloatMillimes)}`;
    case 'session_close':
      return `Closing the session on terminal ${record.terminalCode} with ${formatTND(record.payload.closingCountedMillimes)} counted`;
  }
}

/**
 * What the cashier is told the moment a record is written. It is on this device for good by then:
 * the queue sends it, and nothing on this screen waits for the server.
 */
export function recordedMessage(record: OutboxRecord): string {
  switch (record.kind) {
    case 'sale':
      return `Sale ${receiptOf(record)} recorded`;
    case 'refund':
      return `Refund ${receiptOf(record)} recorded`;
    case 'session_open':
      return 'Session opened';
    case 'session_close':
      return 'Session closed';
  }
}

const SYNC_STATUS_LABELS: Record<SyncStatus, string> = {
  synced: 'Sent',
  pending: 'Waiting to send',
  conflict: 'Needs attention',
  voided: 'Voided',
};

export function syncStatusLabel(status: SyncStatus): string {
  return SYNC_STATUS_LABELS[status];
}

/** A sentence about where `record` stands, for the receipt and the queue. */
export function syncStatusMessage(record: OutboxRecord): string {
  switch (syncStatus(record)) {
    case 'synced':
      return 'The server has this record.';
    case 'pending':
      return record.lastError
        ? recordErrorMessage(record.lastError, record)
        : 'Kept on this device until the server takes it.';
    case 'conflict':
      return record.lastError
        ? recordErrorMessage(record.lastError, record)
        : 'The server refused this record.';
    case 'voided':
      return 'An admin voided this record, so it is not in the ledger.';
  }
}

/** The question asked before voiding a record the server refused. */
export function voidQuestion(record: NumberedRecord): string {
  return (
    `Void receipt ${receiptOf(record)}? The server refused this record, so it is not in the ledger. ` +
    'Voiding spends its number on a void row, which lets the records behind it go out.'
  );
}
