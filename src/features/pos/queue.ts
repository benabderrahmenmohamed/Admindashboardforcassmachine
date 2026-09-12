/**
 * What the register reads off the outbox: how far each record got, what stops the queue, the session
 * this device is in, and the documents of a session. Records are the register's own copy of what it
 * wrote, so every answer here is available offline. No React and no I/O, so it runs without a DOM.
 */
import type { ZReportDocument } from '@/features/sessions/zReport';
import type { Outbox } from '@/features/sync/outbox';
import type { OutboxMeta, OutboxRecord, OutboxStorage } from '@/features/sync/types';
import type { CashSession } from '@/ports';

/**
 * What the register needs from the sync runtime (`src/features/sync/hooks`): the outbox to append
 * to, the storage its meta row — this device's registration and counters — lives in, and a way to
 * ask for a drain pass after writing something. Nothing on screen ever waits for that pass.
 */
export interface OutboxHandle {
  readonly outbox: Outbox;
  readonly storage: OutboxStorage;
  readonly drain: () => void;
}

/** A sale or a refund: the kinds that carry a receipt number. */
export type NumberedRecord = Extract<OutboxRecord, { readonly kind: 'sale' | 'refund' }>;
export type SessionOpenRecord = Extract<OutboxRecord, { readonly kind: 'session_open' }>;
export type SessionCloseRecord = Extract<OutboxRecord, { readonly kind: 'session_close' }>;

/**
 * How far a record got, as a screen shows it:
 * - `pending`: written here, waiting its turn or its next attempt;
 * - `conflict`: the server refused it and the queue stops at it until a person acts;
 * - `voided`: an admin gave up on it, and its receipt number is spent;
 * - `synced`: the server holds it.
 */
export type SyncStatus = 'synced' | 'pending' | 'conflict' | 'voided';

export function syncStatus(record: OutboxRecord): SyncStatus {
  switch (record.status) {
    case 'acked':
      return 'synced';
    case 'pending':
    case 'sending':
      return 'pending';
    case 'conflict':
      return 'conflict';
    case 'voided':
      return 'voided';
  }
}

export function isNumbered(record: OutboxRecord): record is NumberedRecord {
  return record.kind === 'sale' || record.kind === 'refund';
}

export function isSessionClose(record: OutboxRecord): record is SessionCloseRecord {
  return record.kind === 'session_close';
}

/** The record `id` names, as the queue holds it now. */
export function findRecord(
  records: readonly OutboxRecord[],
  id: string | null,
): OutboxRecord | null {
  return id === null ? null : (records.find((record) => record.id === id) ?? null);
}

/** A record the server has neither taken nor refused for good: it still has to go somewhere. */
export function isUnfinished(record: OutboxRecord): boolean {
  return record.status === 'pending' || record.status === 'sending' || record.status === 'conflict';
}

export interface QueueState {
  /** Records written here and not yet acked or voided. */
  readonly pending: number;
  readonly conflicts: number;
  /** The record the queue stops at, or null while everything can still go. */
  readonly blocked: OutboxRecord | null;
}

/**
 * The queue in one glance. The drain sends records in ordinal order and stops at the first one it
 * cannot send, so the earliest record in conflict is the one holding everything behind it up.
 */
export function queueState(records: readonly OutboxRecord[]): QueueState {
  let pending = 0;
  let conflicts = 0;
  let blocked: OutboxRecord | null = null;
  for (const record of records) {
    if (record.status === 'pending' || record.status === 'sending') {
      pending += 1;
    }
    if (record.status === 'conflict') {
      conflicts += 1;
      blocked ??= record;
    }
  }
  return { pending, conflicts, blocked };
}

/** The records waiting behind `blocked`, in the order they will be sent. */
export function waitingBehind(
  records: readonly OutboxRecord[],
  blocked: OutboxRecord,
): OutboxRecord[] {
  return records.filter((record) => record.ordinal > blocked.ordinal && isUnfinished(record));
}

/**
 * The session this device is in, built from its own records: the last session it opened that it has
 * not closed. It needs no network, so a cashier who opened a session offline keeps selling in it.
 * A record written under another terminal code belongs to a registration this device has left.
 * A voided record is one an admin gave up on, so the session it opens or closes never happened here.
 */
export function localSession(
  meta: OutboxMeta,
  records: readonly OutboxRecord[],
): CashSession | null {
  let open: SessionOpenRecord | null = null;
  for (const record of records) {
    if (record.status === 'voided' || record.terminalCode !== meta.code) {
      continue;
    }
    if (record.kind === 'session_open') {
      open = record;
    } else if (record.kind === 'session_close' && open?.payload.id === record.payload.sessionId) {
      open = null;
    }
  }
  if (!open) {
    return null;
  }
  return {
    id: open.payload.id,
    terminalId: meta.terminalId,
    terminalCode: open.payload.terminalCode,
    openedBy: open.payload.actorUserId,
    openedAt: open.payload.openedAt,
    openingFloatMillimes: open.payload.openingFloatMillimes,
    closedAt: null,
    closedBy: null,
    closingCountedMillimes: null,
    forceCloseReason: null,
    zReport: null,
  };
}

/** True when this device opened `sessionId` itself, so its records are the whole session. */
export function openedHere(records: readonly OutboxRecord[], sessionId: string): boolean {
  return records.some(
    (record) =>
      record.kind === 'session_open' &&
      record.payload.id === sessionId &&
      record.status !== 'voided',
  );
}

/**
 * True when this device wrote the close of `sessionId`. The session is over here from that moment,
 * however long the close takes to reach the server, so nothing else is recorded in it.
 */
export function closedHere(records: readonly OutboxRecord[], sessionId: string): boolean {
  return records.some(
    (record) =>
      record.kind === 'session_close' &&
      record.payload.sessionId === sessionId &&
      record.status !== 'voided',
  );
}

/**
 * The sales and refunds this device wrote in `sessionId`, for its own Z-report. A record in conflict
 * was refused by the server and is not in the ledger, and a voided one was given up on, so neither
 * counts; every other record either is in the ledger or is on its way there.
 */
export function sessionDocuments(
  records: readonly OutboxRecord[],
  sessionId: string,
): ZReportDocument[] {
  return records
    .filter(isNumbered)
    .filter(
      (record) =>
        record.sessionId === sessionId &&
        record.status !== 'voided' &&
        record.status !== 'conflict',
    )
    .map((record) => ({
      kind: record.payload.kind,
      paymentMethod: record.payload.payment.method,
      totalMillimes: record.payload.totalMillimes,
    }));
}
