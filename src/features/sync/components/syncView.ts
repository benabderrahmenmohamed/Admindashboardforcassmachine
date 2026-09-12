/**
 * What the sync chip says, kept out of the component so it runs without a DOM. The chip is the one
 * place a cashier can read whether what they sold has reached the server.
 */
import type { SyncState } from '../runtime';
import type { OutboxSummary } from '../types';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** How long ago, in as few words as a chip has room for. */
export function timeSince(at: number, now: number): string {
  const elapsed = Math.max(now - at, 0);
  if (elapsed < MINUTE) {
    return 'just now';
  }
  if (elapsed < HOUR) {
    return `${Math.floor(elapsed / MINUTE)} min ago`;
  }
  if (elapsed < DAY) {
    const hours = Math.floor(elapsed / HOUR);
    return `${hours} ${hours === 1 ? 'hour' : 'hours'} ago`;
  }
  const days = Math.floor(elapsed / DAY);
  return `${days} ${days === 1 ? 'day' : 'days'} ago`;
}

function counted(count: number, noun: string): string {
  return `${count} ${count === 1 ? noun : `${noun}s`}`;
}

/**
 * - `conflict`: a record needs a person; `failed`: this device cannot run its queue at all.
 * - `working`: a pass is running, here or in another tab; `pending`: records are waiting.
 * - `paused`: nothing is sent until someone signs in on the device again.
 */
export type SyncTone = 'synced' | 'working' | 'pending' | 'paused' | 'conflict' | 'failed';

/** The dead-letter list as the chip counts it. */
export interface DiscardedCount {
  readonly count: number;
  /** "2 discarded". */
  readonly label: string;
}

export interface SyncChipView {
  readonly tone: SyncTone;
  /** The chip's own words, e.g. "2 to send". */
  readonly label: string;
  /** When the server last took a record, e.g. "last sent 3 min ago". */
  readonly lastAck: string;
  /** The whole state in one sentence, for the chip's title and its accessible name. */
  readonly detail: string;
  /**
   * The order records given up on here, or null while there are none. Never part of the tone: the
   * list is history for the admin to read, and a live conflict is what needs someone now.
   */
  readonly discarded: DiscardedCount | null;
}

function stateDetail(state: SyncState, pending: number, now: number): string {
  switch (state.kind) {
    case 'sending':
      return 'Sending to the server.';
    case 'busy':
      return 'Another tab on this device is sending.';
    case 'waiting': {
      const seconds = Math.max(Math.ceil((state.retryAt - now) / 1000), 0);
      return `The server could not be reached. Trying again in ${counted(seconds, 'second')}.`;
    }
    case 'paused':
      // An expired sign-in, or a server this device cannot reach at all. Being registered is not a
      // reason: a waiter's phone never is, and it sends its records all the same.
      return 'Nothing is sent until this device is signed in again; the records are kept on it.';
    case 'failed':
      return `This device cannot run its queue: ${state.error.message}`;
    default:
      return pending > 0 ? 'Waiting to send.' : 'Everything written here has reached the server.';
  }
}

function tone(state: SyncState, pending: number): SyncTone {
  switch (state.kind) {
    case 'failed':
      return 'failed';
    case 'paused':
      return 'paused';
    case 'sending':
    case 'busy':
      return 'working';
    default:
      return pending > 0 ? 'pending' : 'synced';
  }
}

/** The sentence the dead-letter list adds after the state's own, or nothing while it is empty. */
function discardedDetail(discarded: number): string {
  if (discarded === 0) {
    return '';
  }
  const records = discarded === 1 ? 'A discarded record is' : `${discarded} discarded records are`;
  return ` ${records} kept on this device for the admin, on the Conflicts screen.`;
}

/**
 * The chip. Conflicts come first: they are the only state that needs someone to act. The dead-letter
 * list only ever adds a quiet count and a closing sentence, whatever the state.
 */
export function syncChipView(summary: OutboxSummary, state: SyncState, now: number): SyncChipView {
  const lastAck =
    summary.lastAckAt === null
      ? 'nothing sent yet'
      : `last sent ${timeSince(summary.lastAckAt, now)}`;
  const discarded =
    summary.discarded > 0
      ? { count: summary.discarded, label: `${summary.discarded} discarded` }
      : null;
  if (summary.conflicts > 0) {
    const them = summary.conflicts === 1 ? 'it' : 'them';
    return {
      tone: 'conflict',
      label: counted(summary.conflicts, 'conflict'),
      lastAck,
      detail:
        `${counted(summary.conflicts, 'record')} cannot be recorded as written. Open ${them} to retry, discard or void ${them}.` +
        discardedDetail(summary.discarded),
      discarded,
    };
  }
  return {
    tone: tone(state, summary.pending),
    label: summary.pending > 0 ? `${summary.pending} to send` : 'Synced',
    lastAck,
    detail: stateDetail(state, summary.pending, now) + discardedDetail(summary.discarded),
    discarded,
  };
}
