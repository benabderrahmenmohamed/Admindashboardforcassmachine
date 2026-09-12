import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppError, isAppError, type ErrorCode } from '@/lib/errors';
import type { OutboxMeta, OutboxRecord, OutboxStorage } from '../types';
import {
  meta,
  registration as registrationOf,
  storedOpen,
  storedOrder,
  storedSale,
} from './fixtures';

// The contract both outbox storages keep, run against each of them. What only one of them can do —
// a database that survives a reload, a unique index — is tested beside that implementation instead.

export interface StorageHarness {
  readonly storage: OutboxStorage;
  /** Releases whatever the storage holds, such as a database connection. */
  close?(): Promise<void>;
}

/**
 * Fails the test unless `action` reports an AppError of `code`. It takes the call rather than the
 * promise, so a storage that ever threw before returning one would be caught here too; both of them
 * reject, which is what each storage's own file pins.
 */
async function failureOf(action: () => Promise<unknown>, code: ErrorCode): Promise<AppError> {
  try {
    await action();
  } catch (error) {
    if (!isAppError(error)) {
      return expect.unreachable(`Expected an AppError ${code}, got ${String(error)}`);
    }
    expect(error.code, error.message).toBe(code);
    return error;
  }
  return expect.unreachable(`Expected ${code}, but the call succeeded`);
}

export function describeOutboxStorage(label: string, open: () => Promise<StorageHarness>): void {
  describe(label, () => {
    const registration = registrationOf();
    const registered = meta();
    let harness: StorageHarness;
    let storage: OutboxStorage;

    beforeEach(async () => {
      harness = await open();
      storage = harness.storage;
    });

    afterEach(async () => {
      await harness.close?.();
    });

    /** Appends `record` under the meta the storage holds now, as the outbox does. */
    async function append(record: OutboxRecord): Promise<boolean> {
      const current = await storage.readMeta();
      const from: OutboxMeta = current ?? { nextOrdinal: 1, terminal: null };
      const next: OutboxMeta = {
        nextOrdinal: record.ordinal + 1,
        terminal:
          from.terminal && record.seq !== null
            ? { ...from.terminal, lastSeq: record.seq }
            : from.terminal,
      };
      return storage.appendIfUnchanged(current, record, next);
    }

    async function ordinalsOf(): Promise<number[]> {
      return (await storage.list()).map((record) => record.ordinal);
    }

    it('holds no queue, and no records, before anything is written', async () => {
      await expect(storage.readMeta()).resolves.toBeNull();
      await expect(storage.list()).resolves.toEqual([]);
      await expect(storage.firstUnfinished()).resolves.toBeUndefined();
      await expect(storage.resetSending()).resolves.toBe(0);
    });

    it('gives the queue back as a copy, so a caller cannot change it in place', async () => {
      await storage.writeMeta(registered);

      const read = await storage.readMeta();
      expect(read).toEqual(registered);
      if (read?.terminal) {
        Object.assign(read.terminal, { lastSeq: 99 });
        Object.assign(read, { nextOrdinal: 99 });
      }

      await expect(storage.readMeta()).resolves.toEqual(registered);
    });

    it('replaces the registration when another one is written', async () => {
      await storage.writeMeta(registered);
      await storage.writeMeta(
        meta({ nextOrdinal: 8, terminal: registrationOf({ code: 'T2', epoch: 2, lastSeq: 7 }) }),
      );

      await expect(storage.readMeta()).resolves.toEqual(
        meta({ nextOrdinal: 8, terminal: registrationOf({ code: 'T2', epoch: 2, lastSeq: 7 }) }),
      );
    });

    it('stores a record and the counters that go with it in one step', async () => {
      await storage.writeMeta(registered);
      const record = await storedSale(registration, 1, 1);

      await expect(append(record)).resolves.toBe(true);

      await expect(storage.get(record.id)).resolves.toEqual(record);
      await expect(storage.list()).resolves.toEqual([record]);
      await expect(storage.firstUnfinished()).resolves.toEqual(record);
      await expect(storage.readMeta()).resolves.toEqual(
        meta({ nextOrdinal: 2, terminal: registrationOf({ lastSeq: 1 }) }),
      );
    });

    // A waiter's phone has never been registered and never will be: its first order record is also
    // the first thing it ever stores.
    it('starts the queue of a device with no terminal on its first record', async () => {
      const record = await storedOrder('order_item_add', 1);

      await expect(
        storage.appendIfUnchanged(null, record, { nextOrdinal: 2, terminal: null }),
      ).resolves.toBe(true);

      await expect(storage.readMeta()).resolves.toEqual({ nextOrdinal: 2, terminal: null });
      await expect(storage.list()).resolves.toEqual([record]);
    });

    it('appends nothing when the queue moved on since it was read', async () => {
      await storage.writeMeta(registered);
      const record = await storedSale(registration, 1, 1);
      const stale: (OutboxMeta | null)[] = [
        // Another tab appended: the ordinal moved.
        meta({ nextOrdinal: 2 }),
        // Another tab sold: the receipt counter moved.
        meta({ terminal: registrationOf({ lastSeq: 1 }) }),
        // Another tab registered the device again: same counters, another registration.
        meta({ terminal: registrationOf({ epoch: 2 }) }),
        meta({ terminal: registrationOf({ terminalId: 'another-terminal' }) }),
        meta({ terminal: null }),
        // Nothing stored, as a device that has never written would believe.
        null,
      ];

      for (const expected of stale) {
        await expect(
          storage.appendIfUnchanged(expected, record, meta({ nextOrdinal: 2 })),
          JSON.stringify(expected),
        ).resolves.toBe(false);
      }

      await expect(storage.list()).resolves.toEqual([]);
      await expect(storage.readMeta()).resolves.toEqual(registered);
    });

    it('appends nothing on a device that has written nothing, if the caller read a queue', async () => {
      const record = await storedSale(registration, 1, 1);

      await expect(storage.appendIfUnchanged(registered, record, registered)).resolves.toBe(false);

      await expect(storage.list()).resolves.toEqual([]);
      await expect(storage.readMeta()).resolves.toBeNull();
    });

    it('refuses a second record under an id it already holds, and keeps the counters', async () => {
      await storage.writeMeta(registered);
      const record = await storedSale(registration, 1, 1);
      await append(record);

      await failureOf(() => append({ ...record, ordinal: 2, seq: 2 }), 'UNKNOWN');

      await expect(storage.list()).resolves.toEqual([record]);
      await expect(storage.readMeta()).resolves.toMatchObject({
        nextOrdinal: 2,
        terminal: { lastSeq: 1 },
      });
    });

    it('holds no record under an id it was never given', async () => {
      await storage.writeMeta(registered);
      await append(await storedSale(registration, 1, 1));

      await expect(storage.get('nothing-like-this')).resolves.toBeUndefined();
    });

    it('lists records in ordinal order, whatever order they arrived in', async () => {
      await storage.writeMeta(meta({ nextOrdinal: 3, terminal: registrationOf({ lastSeq: 2 }) }));
      await append(await storedSale(registration, 3, 3));
      await storage.writeMeta(registered);
      await append(await storedOpen(registration, 1));
      await append(await storedOrder('order_item_add', 2));

      await expect(ordinalsOf()).resolves.toEqual([1, 2, 3]);
    });

    it('finds the lowest-ordinal record that is not finished, whatever its kind', async () => {
      await storage.writeMeta(registered);
      await append(await storedOpen(registration, 1, { status: 'acked' }));
      await append(await storedSale(registration, 2, 1, { status: 'voided' }));
      // A discarded order record is finished: a person gave up on it, and the queue moved on.
      await append(
        await storedOrder('order_send', 3, {
          status: 'discarded',
          discard: {
            reason: 'Table already paid',
            discardedBy: null,
            discardedByName: null,
            discardedAt: 0,
          },
        }),
      );
      const conflicted = await storedSale(registration, 4, 2, { status: 'conflict' });
      await append(conflicted);
      const sending = await storedOrder('order_item_add', 5, { status: 'sending' });
      await append(sending);
      const pending = await storedSale(registration, 6, 3);
      await append(pending);

      await expect(storage.firstUnfinished()).resolves.toEqual(conflicted);

      await storage.update(conflicted.id, { status: 'acked' });
      await expect(storage.firstUnfinished()).resolves.toEqual(sending);

      await storage.update(sending.id, { status: 'acked' });
      await expect(storage.firstUnfinished()).resolves.toEqual(pending);

      await storage.update(pending.id, { status: 'acked' });
      await expect(storage.firstUnfinished()).resolves.toBeUndefined();
    });

    it('changes only the fields a patch names, and gives back the stored record', async () => {
      await storage.writeMeta(registered);
      const record = await storedSale(registration, 1, 1);
      await append(record);
      const patch = {
        status: 'pending',
        attempts: 3,
        nextAttemptAt: record.nextAttemptAt + 4_000,
        lastError: { code: 'NETWORK_ERROR', message: 'No answer' },
      } as const;

      const updated = await storage.update(record.id, patch);

      expect(updated).toEqual({ ...record, ...patch });
      await expect(storage.get(record.id)).resolves.toEqual(updated);
    });

    it('keeps the reason a record was discarded, and who discarded it', async () => {
      const record = await storedOrder('order_item_remove', 1, { status: 'conflict' });
      await append(record);
      const discard = {
        reason: 'The table was paid meanwhile',
        discardedBy: 'user-1',
        discardedByName: 'Sonia',
        discardedAt: 42,
      };

      await storage.update(record.id, { status: 'discarded', discard });

      await expect(storage.get(record.id)).resolves.toEqual({
        ...record,
        status: 'discarded',
        discard,
      });
    });

    it('reports an update of a record it does not hold as NOT_FOUND', async () => {
      await storage.writeMeta(registered);
      await append(await storedSale(registration, 1, 1));

      await failureOf(() => storage.update('nothing-like-this', { status: 'acked' }), 'NOT_FOUND');

      await expect(ordinalsOf()).resolves.toEqual([1]);
    });

    it('moves every sending record back to pending and says how many it moved', async () => {
      await storage.writeMeta(registered);
      await append(await storedOpen(registration, 1, { status: 'sending' }));
      await append(await storedSale(registration, 2, 1, { status: 'acked' }));
      await append(await storedOrder('order_item_add', 3, { status: 'sending' }));
      await append(await storedSale(registration, 4, 2, { status: 'conflict' }));

      await expect(storage.resetSending()).resolves.toBe(2);

      const statuses = (await storage.list()).map((record) => record.status);
      expect(statuses).toEqual(['pending', 'acked', 'pending', 'conflict']);
      await expect(storage.resetSending()).resolves.toBe(0);
    });

    it('keeps what it knows about a record it recovers, apart from its status', async () => {
      await storage.writeMeta(registered);
      const record = await storedSale(registration, 1, 1, {
        status: 'sending',
        attempts: 2,
        nextAttemptAt: 0,
        lastError: { code: 'SERVER_ERROR', message: 'Boom' },
      });
      await append(record);

      await expect(storage.resetSending()).resolves.toBe(1);

      await expect(storage.get(record.id)).resolves.toEqual({ ...record, status: 'pending' });
    });

    it('deletes the records a prune picks that the server has taken, and no others', async () => {
      await storage.writeMeta(registered);
      const taken = await storedSale(registration, 1, 1, { status: 'acked', ackedAt: 0 });
      const onlyHere = [
        await storedOrder('order_item_add', 2),
        await storedOrder('order_send', 3, { status: 'sending' }),
        await storedSale(registration, 4, 2, { status: 'conflict' }),
        await storedSale(registration, 5, 3, { status: 'voided', ackedAt: 0 }),
        await storedOrder('order_cancel', 6, {
          status: 'discarded',
          discard: {
            reason: 'The guests left',
            discardedBy: null,
            discardedByName: null,
            discardedAt: 0,
          },
        }),
      ];
      for (const record of [taken, ...onlyHere]) {
        await append(record);
      }

      // Everything, and an id it does not hold: only the acked record goes.
      await expect(
        storage.prune((records) => [...records.map((record) => record.id), 'nothing-like-this']),
      ).resolves.toBe(1);

      await expect(storage.get(taken.id)).resolves.toBeUndefined();
      await expect(storage.list()).resolves.toEqual(onlyHere);
    });

    it('hands a prune every record in ordinal order, and keeps the counters', async () => {
      await storage.writeMeta(registered);
      // Their ids sort the other way round, so an order by key would show.
      await append(await storedOrder('order_send', 1, { status: 'acked', ackedAt: 0 }));
      await append(await storedSale(registration, 2, 1, { status: 'acked', ackedAt: 0 }));
      const counters = await storage.readMeta();
      let seen: number[] = [];

      await expect(
        storage.prune((records) => {
          seen = records.map((record) => record.ordinal);
          return records.map((record) => record.id);
        }),
      ).resolves.toBe(2);

      expect(seen).toEqual([1, 2]);
      await expect(storage.list()).resolves.toEqual([]);
      // The next record takes the next ordinal and receipt number, never one a deleted record had.
      await expect(storage.readMeta()).resolves.toEqual(counters);
    });

    it('deletes nothing when a prune picks nothing, or fails while picking', async () => {
      await storage.writeMeta(registered);
      const record = await storedSale(registration, 1, 1, { status: 'acked', ackedAt: 0 });
      await append(record);

      await expect(storage.prune(() => [])).resolves.toBe(0);
      await failureOf(
        () =>
          storage.prune(() => {
            throw new AppError('UNKNOWN', 'The policy could not run');
          }),
        'UNKNOWN',
      );

      await expect(storage.list()).resolves.toEqual([record]);
    });

    it('hands out copies of its records, so a caller cannot change what is stored', async () => {
      await storage.writeMeta(registered);
      const record = await storedSale(registration, 1, 1);
      await append(record);

      const [listed] = await storage.list();
      Object.assign(listed, { status: 'acked' });
      Object.assign(listed.payload, { totalMillimes: 1 });
      const found = await storage.get(record.id);
      if (found) {
        Object.assign(found, { attempts: 99 });
      }

      await expect(storage.get(record.id)).resolves.toEqual(record);
      await expect(storage.firstUnfinished()).resolves.toEqual(record);
    });
  });
}
