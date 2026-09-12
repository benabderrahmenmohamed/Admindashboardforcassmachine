/**
 * What the Conflicts screen shows, kept out of the components so it runs without a DOM: the record
 * the queue stopped at and the records held up behind it. Every word comes from the register's own
 * wording (src/features/pos/recording.ts), so the POS and this screen say the same thing about the
 * same record.
 */
import {
  isNumbered,
  queueState,
  syncStatus,
  waitingBehind,
  type NumberedRecord,
} from '@/features/pos/queue';
import {
  canVoid,
  describeRecord,
  receiptOf,
  syncStatusLabel,
  syncStatusMessage,
} from '@/features/pos/recording';
import type { ErrorCode } from '@/lib/errors';
import type { OutboxRecord } from '../types';

const KIND_LABELS: Record<OutboxRecord['kind'], string> = {
  sale: 'Sale',
  refund: 'Refund',
  session_open: 'Session opening',
  session_close: 'Session close',
};

/** `conflict`: the queue stopped here. `waiting`: written later, so it cannot go out before it. */
export type ConflictRowStatus = 'conflict' | 'waiting';

export interface ConflictRow {
  readonly id: string;
  readonly ordinal: number;
  readonly status: ConflictRowStatus;
  readonly kindLabel: string;
  /** The number this device gave the record; sales and refunds only. */
  readonly receipt: string | null;
  readonly sessionId: string;
  /** When this device wrote the record, by its own clock. */
  readonly writtenAt: number;
  /** The record in one line: what it would record. */
  readonly summary: string;
  /** Where it stands, in two words: "Needs attention", "Waiting to send". */
  readonly statusLabel: string;
  readonly errorCode: ErrorCode | null;
  /** Why it is here, decided by the error's code alone. */
  readonly message: string;
  readonly attempts: number;
  /** The record an admin may void: a numbered one the server refused. */
  readonly voidable: NumberedRecord | null;
}

function toRow(record: OutboxRecord): ConflictRow {
  return {
    id: record.id,
    ordinal: record.ordinal,
    status: record.status === 'conflict' ? 'conflict' : 'waiting',
    kindLabel: KIND_LABELS[record.kind],
    receipt: isNumbered(record) ? receiptOf(record) : null,
    sessionId: record.sessionId,
    writtenAt: record.createdAt,
    summary: describeRecord(record),
    statusLabel: syncStatusLabel(syncStatus(record)),
    errorCode: record.lastError?.code ?? null,
    message: syncStatusMessage(record),
    attempts: record.attempts,
    voidable: isNumbered(record) && canVoid(record) ? record : null,
  };
}

/**
 * The record the queue stopped at and everything held up behind it, in the order they were written.
 * A queue with no conflict has no rows: nothing in it needs a person.
 */
export function conflictRows(records: readonly OutboxRecord[]): ConflictRow[] {
  const { blocked } = queueState(records);
  if (!blocked) {
    return [];
  }
  return [blocked, ...waitingBehind(records, blocked)].map(toRow);
}
