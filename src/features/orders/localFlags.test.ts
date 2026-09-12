import { describe, expect, it } from 'vitest';
import { roomItem } from './__fixtures__/room';
import { changesText, itemFlags, itemSync, NEEDS_ATTENTION } from './localFlags';
import { NO_LOCAL } from './overlay';

describe('itemFlags', () => {
  it('flags nothing on a row exactly as the server has it', () => {
    expect(itemFlags(roomItem({ id: 'a' }))).toEqual([]);
  });

  it('says what each waiting change is, the one taking the row off first', () => {
    const flags = itemFlags(
      roomItem({
        id: 'a',
        local: {
          added: 'pending',
          sending: 'pending',
          preparing: 'pending',
          removing: { sync: 'pending', reason: 'x', cause: 'remove' },
          paying: null,
        },
      }),
    );

    expect(flags).toEqual([
      { sync: 'pending', text: 'Coming off' },
      { sync: 'pending', text: 'Not synced' },
      { sync: 'pending', text: 'Sending' },
      { sync: 'pending', text: 'Prepared' },
    ]);
  });

  it('says a row is going with its table’s cancel', () => {
    expect(
      itemFlags(
        roomItem({
          id: 'a',
          local: { ...NO_LOCAL, removing: { sync: 'pending', reason: 'x', cause: 'cancel' } },
        }),
      ),
    ).toEqual([{ sync: 'pending', text: 'Cancelling' }]);
  });

  it('says a refused change needs attention, once however many were refused', () => {
    expect(
      itemFlags(
        roomItem({ id: 'a', local: { ...NO_LOCAL, added: 'conflict', sending: 'conflict' } }),
      ),
    ).toEqual([{ sync: 'conflict', text: NEEDS_ATTENTION }]);
  });
});

describe('itemSync', () => {
  it('is null for a row as the server has it', () => {
    expect(itemSync(roomItem({ id: 'a' }))).toBeNull();
  });

  it('is pending while every change waits, and a conflict as soon as one was refused', () => {
    expect(itemSync(roomItem({ id: 'a', local: { ...NO_LOCAL, preparing: 'pending' } }))).toBe(
      'pending',
    );
    expect(
      itemSync(
        roomItem({
          id: 'a',
          local: {
            ...NO_LOCAL,
            added: 'pending',
            removing: { sync: 'conflict', reason: 'x', cause: 'remove' },
          },
        }),
      ),
    ).toBe('conflict');
  });
});

describe('changesText', () => {
  it('says nothing when the server shows everything', () => {
    expect(changesText({ pending: 0, conflicts: 0 })).toBeNull();
  });

  it('counts what is waiting to go out', () => {
    expect(changesText({ pending: 1, conflicts: 0 })).toBe(
      '1 change on this device is not synced yet. It goes out on its own.',
    );
    expect(changesText({ pending: 3, conflicts: 0 })).toBe(
      '3 changes on this device are not synced yet. They go out on their own.',
    );
  });

  it('puts a refusal before anything waiting, and points at the sync status', () => {
    expect(changesText({ pending: 2, conflicts: 1 })).toBe(
      'The server refused 1 change to this table: see the sync status.',
    );
  });
});
