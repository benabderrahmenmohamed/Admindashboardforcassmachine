/**
 * What the Conflicts screen shows, kept out of the components so it runs without a DOM: the record
 * the queue stopped at, the records held up behind it, and the records a person gave up on. Every
 * word about a record comes from the register's own wording (src/features/pos/recording.ts), so the
 * POS and this screen say the same thing about the same record.
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
  NO_NAMES,
  receiptOf,
  syncStatusLabel,
  syncStatusMessage,
  type RecordNames,
} from '@/features/pos/recording';
import type { ErrorCode } from '@/lib/errors';
import type { AuthUser } from '@/ports';
import { isOrderRecord, type LedgerKind, type OutboxDiscard, type OutboxRecord } from '../types';

const KIND_LABELS: Record<OutboxRecord['kind'], string> = {
  sale: 'Sale',
  refund: 'Refund',
  session_open: 'Session opening',
  session_close: 'Session close',
  order_item_add: 'Item added',
  order_item_remove: 'Item removed',
  order_send: 'Sent to the kitchen',
  order_item_prepare: 'Item prepared',
  order_cancel: 'Table cancelled',
};

/**
 * Why a record of the ledger offers no discard, in the one sentence a person reads where they look
 * for the button. An order record is working state and may be given up on; these move money or a
 * till, and one dropped from the queue would be money nobody can account for.
 */
const NO_DISCARD: Record<LedgerKind, string> = {
  sale: 'A sale cannot be discarded: it records money that was taken, so it is sent again or voided by an admin, never dropped.',
  refund:
    'A refund cannot be discarded: it records money that was handed back, so it is sent again or voided by an admin, never dropped.',
  session_open:
    'A session opening cannot be discarded: every sale of that session belongs to it, so it can only be sent again.',
  session_close:
    'A session close cannot be discarded: it holds the cash counted at the end of the shift, so it can only be sent again.',
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
  /** The session a register's record belongs to; null for an order record, which has none. */
  readonly sessionId: string | null;
  /** When this device wrote the record, by its own clock. */
  readonly writtenAt: number;
  /** The record in one line: what it would record, with the names this device has cached. */
  readonly summary: string;
  /** Where it stands, in two words: "Needs attention", "Waiting to send". */
  readonly statusLabel: string;
  readonly errorCode: ErrorCode | null;
  /** Why it is here, decided by the error's code alone. */
  readonly message: string;
  readonly attempts: number;
  /** The record an admin may void: a numbered one the server refused. */
  readonly voidable: NumberedRecord | null;
  /** Whether a person may give up on it, with a reason: an order record the queue stopped at. */
  readonly discardable: boolean;
  /** For a ledger record the queue stopped at, why there is no discard; null for any other row. */
  readonly whyNoDiscard: string | null;
}

function toRow(record: OutboxRecord, names: RecordNames): ConflictRow {
  const stopped = record.status === 'conflict';
  return {
    id: record.id,
    ordinal: record.ordinal,
    status: stopped ? 'conflict' : 'waiting',
    kindLabel: KIND_LABELS[record.kind],
    receipt: isNumbered(record) ? receiptOf(record) : null,
    sessionId: record.sessionId,
    writtenAt: record.createdAt,
    summary: describeRecord(record, names),
    statusLabel: syncStatusLabel(syncStatus(record)),
    errorCode: record.lastError?.code ?? null,
    message: syncStatusMessage(record),
    attempts: record.attempts,
    voidable: isNumbered(record) && canVoid(record) ? record : null,
    // The outbox refuses a discard of anything else; the screen never offers what it would refuse.
    discardable: stopped && isOrderRecord(record),
    whyNoDiscard: stopped && !isOrderRecord(record) ? NO_DISCARD[record.kind] : null,
  };
}

/**
 * The record the queue stopped at and everything held up behind it, in the order they were written.
 * A queue with no conflict has no rows: nothing in it needs a person.
 */
export function conflictRows(
  records: readonly OutboxRecord[],
  names: RecordNames = NO_NAMES,
): ConflictRow[] {
  const { blocked } = queueState(records);
  if (!blocked) {
    return [];
  }
  return [blocked, ...waitingBehind(records, blocked)].map((record) => toRow(record, names));
}

/** Who is reading the screen, so a discard they made themselves reads as theirs. */
export type Viewer = Pick<AuthUser, 'id' | 'name'>;

/** One record of the dead-letter list: an order record a person gave up on, and why. */
export interface DeadLetterRow {
  readonly id: string;
  readonly kindLabel: string;
  /** What it would have recorded, with the names this device has cached. */
  readonly summary: string;
  /** Why it was given up on, as the person typed it. */
  readonly reason: string;
  /** Who gave up on it, as the reader knows them. */
  readonly discardedBy: string;
  readonly discardedAt: number;
  /** When this device wrote the record, by its own clock. */
  readonly writtenAt: number;
  /** The code the server refused it with: why it stopped the queue in the first place. */
  readonly errorCode: ErrorCode | null;
}

/**
 * The person who discarded a record, by the name they had when they did. A record from before names
 * were kept has only the account id, and this device has no list of the shop's people to look it up
 * in: the start of the id is then enough to find the account.
 */
export function discardedByLabel(
  discard: Pick<OutboxDiscard, 'discardedBy' | 'discardedByName'>,
  viewer: Viewer,
): string {
  const { discardedBy, discardedByName } = discard;
  if (discardedBy === null) {
    return 'Nobody signed in';
  }
  const name = discardedByName ?? (discardedBy === viewer.id ? viewer.name : '');
  if (discardedBy === viewer.id) {
    return name === '' ? 'You' : `${name} (you)`;
  }
  return name === '' ? `Another account (${discardedBy.slice(0, 8)})` : name;
}

/**
 * This device's dead-letter list, the latest discard first. The records stay on the device for good,
 * because the list is what the admin is shown of what never reached the server.
 */
export function deadLetterRows(
  records: readonly OutboxRecord[],
  viewer: Viewer,
  names: RecordNames = NO_NAMES,
): DeadLetterRow[] {
  return records
    .flatMap((record) =>
      record.status === 'discarded' && record.discard !== null
        ? [{ record, discard: record.discard }]
        : [],
    )
    .sort(
      (a, b) =>
        b.discard.discardedAt - a.discard.discardedAt || b.record.ordinal - a.record.ordinal,
    )
    .map(({ record, discard }) => ({
      id: record.id,
      kindLabel: KIND_LABELS[record.kind],
      summary: describeRecord(record, names),
      reason: discard.reason,
      discardedBy: discardedByLabel(discard, viewer),
      discardedAt: discard.discardedAt,
      writtenAt: record.createdAt,
      errorCode: record.lastError?.code ?? null,
    }));
}

/** The dead-letter list in one line, for the admin's first page. */
export function deadLetterHeadline(count: number): string {
  return count === 1
    ? '1 order record was discarded on this device'
    : `${count} order records were discarded on this device`;
}
