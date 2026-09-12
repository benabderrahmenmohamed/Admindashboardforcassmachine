/**
 * The words a screen puts on a change this device made that the server does not show yet.
 *
 * Short on purpose: they sit on a row of a waiter's phone. A waiting change says what it is; a
 * refused one says the same thing the sync chip says about it, "Needs attention", because the chip
 * and the Conflicts screen are where it is dealt with.
 */
import type { LocalChanges, LocalSync, RoomItem } from './overlay';

export const NEEDS_ATTENTION = 'Needs attention';

export interface LocalFlag {
  readonly sync: LocalSync;
  readonly text: string;
}

/** The flags of one row, most consequential first; an empty list for a row as the server has it. */
export function itemFlags(item: RoomItem): LocalFlag[] {
  const { local } = item;
  const candidates: readonly (readonly [LocalSync | null, string])[] = [
    [
      local.removing?.sync ?? null,
      local.removing?.cause === 'cancel' ? 'Cancelling' : 'Coming off',
    ],
    [local.paying, 'Being paid'],
    [local.added, 'Not synced'],
    [local.sending, 'Sending'],
    [local.preparing, 'Prepared'],
  ];
  const flags: LocalFlag[] = [];
  for (const [sync, pendingText] of candidates) {
    if (sync === null) {
      continue;
    }
    const text = sync === 'conflict' ? NEEDS_ATTENTION : pendingText;
    if (!flags.some((flag) => flag.text === text)) {
      flags.push({ sync, text });
    }
  }
  return flags;
}

/** The worst standing among a row's changes: a refused one outranks any that are only waiting. */
export function itemSync(item: RoomItem): LocalSync | null {
  const standings = [
    item.local.added,
    item.local.sending,
    item.local.preparing,
    item.local.removing?.sync ?? null,
    item.local.paying,
  ];
  if (standings.includes('conflict')) {
    return 'conflict';
  }
  return standings.includes('pending') ? 'pending' : null;
}

/** One line about a table's changes that have not reached the server, or null when there are none. */
export function changesText(changes: LocalChanges): string | null {
  if (changes.conflicts > 0) {
    const refused = changes.conflicts === 1 ? '1 change' : `${changes.conflicts} changes`;
    return `The server refused ${refused} to this table: see the sync status.`;
  }
  if (changes.pending === 1) {
    return '1 change on this device is not synced yet. It goes out on its own.';
  }
  if (changes.pending > 1) {
    return `${changes.pending} changes on this device are not synced yet. They go out on their own.`;
  }
  return null;
}
