import type { OutboxDiscard, OutboxMeta, OutboxRecord, TerminalMeta } from './types';

/** The queue of a device that has written nothing yet: no records, and not a register. */
export const EMPTY_META: OutboxMeta = { nextOrdinal: 1, terminal: null };

function sameTerminal(a: TerminalMeta | null, b: TerminalMeta | null): boolean {
  if (a === null || b === null) {
    return a === b;
  }
  return (
    a.terminalId === b.terminalId &&
    a.code === b.code &&
    a.epoch === b.epoch &&
    a.lastSeq === b.lastSeq
  );
}

/**
 * Whether the stored meta is still what an append read. The ordinal moves on every append, so it
 * catches another tab appending; the registration is compared too, because another tab may have
 * registered the device again in between — and an append that had read the old registration would
 * write it back over the new one.
 */
export function metaUnchanged(stored: OutboxMeta | null, expected: OutboxMeta | null): boolean {
  if (stored === null || expected === null) {
    return stored === expected;
  }
  return (
    stored.nextOrdinal === expected.nextOrdinal && sameTerminal(stored.terminal, expected.terminal)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isWholeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

/**
 * A meta row as it was stored, in the shape this build reads. Before the café model the row was the
 * terminal registration itself, with the ordinal counter beside its fields; a device that updates
 * reads that row as a register with the same counters, so no receipt number or ordinal is handed
 * out twice. Anything else is not a row this app wrote, and reads as nothing stored.
 */
export function readStoredMeta(row: unknown): OutboxMeta | null {
  if (!isRecord(row) || !isWholeNumber(row.nextOrdinal)) {
    return null;
  }
  if ('terminal' in row) {
    const terminal = row.terminal;
    if (terminal === null) {
      return { nextOrdinal: row.nextOrdinal, terminal: null };
    }
    return isRecord(terminal)
      ? { nextOrdinal: row.nextOrdinal, terminal: terminalOf(terminal) }
      : null;
  }
  // The row before the café model: the registration, flat.
  return { nextOrdinal: row.nextOrdinal, terminal: terminalOf(row) };
}

function terminalOf(row: Record<string, unknown>): TerminalMeta | null {
  const { terminalId, code, epoch, lastSeq, registeredAt } = row;
  if (
    typeof terminalId !== 'string' ||
    typeof code !== 'string' ||
    !isWholeNumber(epoch) ||
    !isWholeNumber(lastSeq) ||
    !isWholeNumber(registeredAt)
  ) {
    return null;
  }
  return { terminalId, code, epoch, lastSeq, registeredAt };
}

/** A record as a build before discarding existed may have stored it: without `discard`. */
type Stored<T> = T extends unknown
  ? Omit<T, 'discard'> & { readonly discard?: OutboxDiscard | null }
  : never;
export type StoredOutboxRecord = Stored<OutboxRecord>;

/**
 * A record as it was stored, in the shape this build reads: a record written before discarding
 * existed has no `discard` field, and reads as one nobody discarded.
 */
export function readStoredRecord(row: StoredOutboxRecord): OutboxRecord {
  return { ...row, discard: row.discard ?? null };
}

/** Records the drain has not finished with: it stops at the first of them. */
export function isUnfinished(record: OutboxRecord): boolean {
  return record.status === 'pending' || record.status === 'sending' || record.status === 'conflict';
}
