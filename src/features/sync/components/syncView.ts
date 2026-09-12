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
 * - `paused`: nothing is sent until someone signs in or registers the device.
 */
export type SyncTone = 'synced' | 'working' | 'pending' | 'paused' | 'conflict' | 'failed';

export interface SyncChipView {
  readonly tone: SyncTone;
  /** The chip's own words, e.g. "2 to send". */
  readonly label: string;
  /** When the server last took a record, e.g. "last sent 3 min ago". */
  readonly lastAck: string;
  /** The whole state in one sentence, for the chip's title and its accessible name. */
  readonly detail: string;
}

function stateDetail(state: SyncState, pending: number, now: number): string {
  switch (state.kind) {
    case 'sending':
      return 'Sending to the server.';
    case 'busy':
      return 'Another tab of this register is sending.';
    case 'waiting': {
      const seconds = Math.max(Math.ceil((state.retryAt - now) / 1000), 0);
      return `The server could not be reached. Trying again in ${counted(seconds, 'second')}.`;
    }
    case 'paused':
      // `auth` covers both an expired sign-in and a server this device cannot reach at all.
      return state.reason === 'auth'
        ? 'Nothing is sent until this device is signed in again; the records are kept on it.'
        : 'This device is not registered as a terminal, so nothing can be sent.';
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

/** The chip. Conflicts come first: they are the only state that needs someone to act. */
export function syncChipView(summary: OutboxSummary, state: SyncState, now: number): SyncChipView {
  const lastAck =
    summary.lastAckAt === null
      ? 'nothing sent yet'
      : `last sent ${timeSince(summary.lastAckAt, now)}`;
  if (summary.conflicts > 0) {
    return {
      tone: 'conflict',
      label: counted(summary.conflicts, 'conflict'),
      lastAck,
      detail: `${counted(summary.conflicts, 'record')} cannot be recorded as written. Open them to retry or void them.`,
    };
  }
  return {
    tone: tone(state, summary.pending),
    label: summary.pending > 0 ? `${summary.pending} to send` : 'Synced',
    lastAck,
    detail: stateDetail(state, summary.pending, now),
  };
}
