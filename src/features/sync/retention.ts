/**
 * How long this device keeps a record the server has taken. Every tap in a busy café is a record,
 * and the screens read the whole queue on every change, so a queue that only ever grew would slow a
 * cheap phone down within weeks. No React, no clock and no I/O: the moment comes in with the call.
 */
import { isOrderRecord, type LedgerOutboxRecord, type OutboxRecord } from './types';

/**
 * A week. Any read of the room made since an ack shows what it acked, so the screens stopped drawing
 * such a record long before; the week is for a person looking back at what this device sent.
 */
export const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/** Ids as the server stores them: a uuid column reads back lowercase whatever was written. */
function idKey(id: string): string {
  return id.toLowerCase();
}

/** The server has had it for at least RETENTION_MS. */
function isExpired(record: OutboxRecord, now: number): boolean {
  return (
    record.status === 'acked' && record.ackedAt !== null && record.ackedAt + RETENTION_MS <= now
  );
}

/** The record the server took last: the latest ack, and of two in one millisecond the later record. */
function lastAcked(records: readonly OutboxRecord[]): OutboxRecord | null {
  let last: OutboxRecord | null = null;
  let lastAt = 0;
  for (const record of records) {
    if (record.status !== 'acked' || record.ackedAt === null) {
      continue;
    }
    if (
      last === null ||
      record.ackedAt > lastAt ||
      (record.ackedAt === lastAt && record.ordinal > last.ordinal)
    ) {
      last = record;
      lastAt = record.ackedAt;
    }
  }
  return last;
}

/**
 * The session the till is still in: the one its latest ledger record belongs to — opened here or
 * taken over from another device — unless this device has closed it. A voided record never happened
 * here, so it neither names the session nor closes it, as in `localSession`.
 */
function currentSession(records: readonly OutboxRecord[]): string | null {
  let latest: LedgerOutboxRecord | null = null;
  for (const record of records) {
    if (
      !isOrderRecord(record) &&
      record.status !== 'voided' &&
      (latest === null || record.ordinal > latest.ordinal)
    ) {
      latest = record;
    }
  }
  if (latest === null) {
    return null;
  }
  const { sessionId } = latest;
  const closed = records.some(
    (record) =>
      record.kind === 'session_close' &&
      record.status !== 'voided' &&
      record.payload.sessionId === sessionId,
  );
  return closed ? null : sessionId;
}

/** The records `record` is described by: a removal or a prepare its item's add, a refund its sale. */
function namedIds(record: OutboxRecord): string[] {
  switch (record.kind) {
    case 'order_item_remove':
    case 'order_item_prepare':
      // An added item's id is its add record's id.
      return [record.payload.itemId];
    case 'refund':
      return record.payload.refundsSaleId === null ? [] : [record.payload.refundsSaleId];
    default:
      return [];
  }
}

/**
 * The ids of the records this device no longer needs: the ones the server took (`acked`) at least
 * RETENTION_MS before `now`. Nothing else is ever deleted — a record still on its way or refused is
 * data only this device has, a voided one is a receipt number that was spent, and a discarded one is
 * the dead-letter list the admin reads. Of the records old enough, these stay all the same:
 *
 * - the last one the server took, so the device can still say when it last reached the server;
 * - every record of the session the till is still in, which its own Z-report is counted from;
 * - a record that a record staying is described by: the add of an item a removal or a prepare
 *   names, and the sale a refund takes back. The Conflicts screen names an item by its add, the grid
 *   finds a removal's table by it, and the refund form counts what was already taken back against
 *   the sale this device holds.
 */
export function prunable(records: readonly OutboxRecord[], now: number): string[] {
  const last = lastAcked(records);
  const session = currentSession(records);
  const stays = (record: OutboxRecord) =>
    !isExpired(record, now) ||
    record === last ||
    (session !== null && record.sessionId === session);
  // A removal, a prepare or a refund is never itself named by another record, so whether it stays
  // is settled above, before the records it names are looked at.
  const named = new Set(records.filter(stays).flatMap(namedIds).map(idKey));
  return records
    .filter((record) => !stays(record) && !named.has(idKey(record.id)))
    .map((record) => record.id);
}
