import { describe, expect, it } from 'vitest';
import type { OutboxSummary } from '../types';
import { syncChipView, timeSince } from './syncView';

const NOW = 1_700_000_000_000;
const MINUTE = 60_000;

const SYNCED: OutboxSummary = { pending: 0, conflicts: 0, discarded: 0, lastAckAt: NOW - MINUTE };

describe('timeSince', () => {
  it('reads the way a cashier would say it', () => {
    expect(timeSince(NOW - 5_000, NOW)).toBe('just now');
    expect(timeSince(NOW - 3 * MINUTE, NOW)).toBe('3 min ago');
    expect(timeSince(NOW - 60 * MINUTE, NOW)).toBe('1 hour ago');
    expect(timeSince(NOW - 5 * 60 * MINUTE, NOW)).toBe('5 hours ago');
    expect(timeSince(NOW - 49 * 60 * MINUTE, NOW)).toBe('2 days ago');
  });

  it('never counts backwards when the clock moved', () => {
    expect(timeSince(NOW + 10_000, NOW)).toBe('just now');
  });
});

describe('syncChipView', () => {
  it('says everything is through when nothing is waiting', () => {
    const view = syncChipView(SYNCED, { kind: 'idle' }, NOW);

    expect(view).toMatchObject({
      tone: 'synced',
      label: 'Synced',
      lastAck: 'last sent 1 min ago',
      discarded: null,
    });
    expect(view.detail).toContain('reached the server');
  });

  it('counts what is still on the device', () => {
    const view = syncChipView(
      { pending: 2, conflicts: 0, discarded: 0, lastAckAt: null },
      { kind: 'idle' },
      NOW,
    );

    expect(view).toMatchObject({
      tone: 'pending',
      label: '2 to send',
      lastAck: 'nothing sent yet',
    });
  });

  it('puts conflicts before everything else', () => {
    const view = syncChipView(
      { pending: 3, conflicts: 1, discarded: 0, lastAckAt: NOW - MINUTE },
      { kind: 'blocked', recordId: 'sale-1' },
      NOW,
    );

    expect(view).toMatchObject({ tone: 'conflict', label: '1 conflict' });
    expect(view.detail).toContain('retry, discard or void it');
  });

  it('says a pass is running, here or in another tab', () => {
    const pending: OutboxSummary = { pending: 1, conflicts: 0, discarded: 0, lastAckAt: null };

    expect(syncChipView(pending, { kind: 'sending' }, NOW).tone).toBe('working');
    expect(syncChipView(pending, { kind: 'busy' }, NOW).detail).toContain('Another tab');
  });

  it('counts down to the next try after the server could not be reached', () => {
    const view = syncChipView(
      { pending: 1, conflicts: 0, discarded: 0, lastAckAt: null },
      { kind: 'waiting', retryAt: NOW + 4_000 },
      NOW,
    );

    expect(view.tone).toBe('pending');
    expect(view.detail).toContain('in 4 seconds');
  });

  it('explains why a paused queue is not moving', () => {
    const pending: OutboxSummary = { pending: 1, conflicts: 0, discarded: 0, lastAckAt: null };

    expect(syncChipView(pending, { kind: 'paused', reason: 'auth' }, NOW)).toMatchObject({
      tone: 'paused',
      label: '1 to send',
    });
    // Only a sign-in pauses a queue: a waiter's phone is never registered, and still sends.
    expect(syncChipView(pending, { kind: 'paused', reason: 'auth' }, NOW).detail).toContain(
      'signed in again',
    );
  });

  it('passes on why the device cannot run its queue at all', () => {
    const view = syncChipView(
      SYNCED,
      {
        kind: 'failed',
        error: { code: 'CONFIG_ERROR', message: 'Serve the register over https.' },
      },
      NOW,
    );

    expect(view.tone).toBe('failed');
    expect(view.detail).toContain('Serve the register over https.');
  });
});

describe('the dead-letter count on the chip', () => {
  const KEPT = 'kept on this device for the admin, on the Conflicts screen.';

  it('shows discarded records on a queue that is otherwise through', () => {
    const view = syncChipView({ ...SYNCED, discarded: 2 }, { kind: 'idle' }, NOW);

    // Discarded records are history, not a state: the chip still says the queue is through.
    expect(view).toMatchObject({
      tone: 'synced',
      label: 'Synced',
      discarded: { count: 2, label: '2 discarded' },
    });
    expect(view.detail).toBe(
      `Everything written here has reached the server. 2 discarded records are ${KEPT}`,
    );
  });

  it('never speaks louder than a live conflict', () => {
    const view = syncChipView(
      { pending: 2, conflicts: 1, discarded: 1, lastAckAt: null },
      { kind: 'blocked', recordId: 'order-1' },
      NOW,
    );

    expect(view).toMatchObject({
      tone: 'conflict',
      label: '1 conflict',
      discarded: { count: 1, label: '1 discarded' },
    });
    // The conflict is said first; the list only closes the sentence.
    expect(view.detail.startsWith('1 record cannot be recorded as written.')).toBe(true);
    expect(view.detail.endsWith(`A discarded record is ${KEPT}`)).toBe(true);
  });

  it('counts nothing while the list is empty, whatever the queue is doing', () => {
    const summary: OutboxSummary = { pending: 1, conflicts: 0, discarded: 0, lastAckAt: null };
    const view = syncChipView(summary, { kind: 'sending' }, NOW);

    expect(view.discarded).toBeNull();
    expect(view.detail).not.toContain('discarded');
  });
});
