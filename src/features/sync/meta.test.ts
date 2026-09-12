import { describe, expect, it } from 'vitest';
import { meta, registration, storedSale } from './__tests__/fixtures';
import { EMPTY_META, isUnfinished, metaUnchanged, readStoredMeta, readStoredRecord } from './meta';
import type { OutboxStatus } from './types';

// The queue's meta row is read back from a store earlier builds wrote to, so reading it is a parser
// and is tested as one: every shape a build of this app has written, and what it does with the rest.

describe('readStoredMeta', () => {
  it('reads the row this build writes, a register or not', () => {
    expect(readStoredMeta({ key: 'terminal', ...meta() })).toEqual(meta());
    expect(readStoredMeta({ key: 'terminal', nextOrdinal: 4, terminal: null })).toEqual({
      nextOrdinal: 4,
      terminal: null,
    });
  });

  // Before the café model the row was the registration itself, with the ordinal beside its fields.
  // A device that updates must read it as the same register with the same counters.
  it('reads the row a build before the café model wrote as the same register and counters', () => {
    const flat = { key: 'terminal', ...registration({ lastSeq: 41 }), nextOrdinal: 57 };

    expect(readStoredMeta(flat)).toEqual({
      nextOrdinal: 57,
      terminal: registration({ lastSeq: 41 }),
    });
  });

  it('reads nothing stored as nothing stored', () => {
    expect(readStoredMeta(undefined)).toBeNull();
    expect(readStoredMeta(null)).toBeNull();
  });

  it.each<[string, unknown]>([
    ['a string', 'terminal'],
    ['a row with no ordinal', { terminal: null }],
    ['a row whose ordinal is not a whole number', { nextOrdinal: 1.5, terminal: null }],
    ['a row whose terminal is not an object', { nextOrdinal: 2, terminal: 'T1' }],
  ])('reads %s as nothing this app wrote', (_case, row) => {
    expect(readStoredMeta(row)).toBeNull();
  });

  // A registration that lost a field cannot be trusted with a receipt number, but the ordinal is
  // still the device's: keeping it means the next record cannot take an ordinal already used.
  it('keeps the ordinal of a row whose registration is unreadable, and drops the registration', () => {
    const { epoch, ...withoutEpoch } = registration();
    void epoch;

    expect(readStoredMeta({ nextOrdinal: 9, ...withoutEpoch })).toEqual({
      nextOrdinal: 9,
      terminal: null,
    });
    expect(readStoredMeta({ nextOrdinal: 9, terminal: { ...withoutEpoch, epoch: '2' } })).toEqual({
      nextOrdinal: 9,
      terminal: null,
    });
  });
});

describe('metaUnchanged', () => {
  it('holds for the same queue, and for nothing stored on both sides', () => {
    expect(metaUnchanged(meta(), meta())).toBe(true);
    expect(metaUnchanged(null, null)).toBe(true);
    expect(metaUnchanged(EMPTY_META, { nextOrdinal: 1, terminal: null })).toBe(true);
  });

  it.each([
    ['another tab appended', meta({ nextOrdinal: 2 })],
    ['another tab sold', meta({ terminal: registration({ lastSeq: 1 }) })],
    ['the device was registered again', meta({ terminal: registration({ epoch: 2 }) })],
    ['another terminal took the code', meta({ terminal: registration({ terminalId: 'other' }) })],
    ['the device stopped being a register', meta({ terminal: null })],
  ])('fails when %s', (_case, stored) => {
    expect(metaUnchanged(stored, meta())).toBe(false);
    expect(metaUnchanged(meta(), stored)).toBe(false);
  });

  it('fails when one side has a queue and the other has nothing', () => {
    expect(metaUnchanged(meta(), null)).toBe(false);
    expect(metaUnchanged(null, meta())).toBe(false);
  });

  // When it was registered is not a counter: two tabs reading the same row agree on it anyway, and
  // comparing it would turn a harmless clock difference into a refused append.
  it('does not compare when the registration happened', () => {
    expect(metaUnchanged(meta({ terminal: registration({ registeredAt: 1 }) }), meta())).toBe(true);
  });
});

describe('readStoredRecord', () => {
  it('reads a record written before discarding existed as one nobody discarded', async () => {
    const { discard, ...older } = await storedSale(registration(), 1, 1);
    void discard;

    expect(readStoredRecord(older)).toEqual({ ...older, discard: null });
  });

  it('keeps the discard of a record that has one', async () => {
    const record = await storedSale(registration(), 1, 1, {
      status: 'conflict',
      discard: { reason: 'Stale', discardedBy: 'user-1', discardedByName: null, discardedAt: 5 },
    });

    expect(readStoredRecord(record)).toEqual(record);
  });
});

describe('isUnfinished', () => {
  it.each<[OutboxStatus, boolean]>([
    ['pending', true],
    ['sending', true],
    ['conflict', true],
    ['acked', false],
    ['voided', false],
    ['discarded', false],
  ])('takes a %s record as unfinished: %s', async (status, unfinished) => {
    expect(isUnfinished(await storedSale(registration(), 1, 1, { status }))).toBe(unfinished);
  });
});
