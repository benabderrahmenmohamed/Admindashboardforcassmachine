import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isAppError, type AppError, type ErrorCode } from '@/lib/errors';
import type { OutboxRecord, OutboxStorage } from '../types';
import { meta, storedOpen, storedSale } from './fixtures';

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
    const registration = meta();
    let harness: StorageHarness;
    let storage: OutboxStorage;

    beforeEach(async () => {
      harness = await open();
      storage = harness.storage;
    });

    afterEach(async () => {
      await harness.close?.();
    });

    /** Appends `record` under the counters the storage holds now, as the outbox does. */
    async function append(record: OutboxRecord): Promise<boolean> {
      const current = await storage.readMeta();
      if (!current) {
        return expect.unreachable('the storage holds no registration');
      }
      return storage.appendIfUnchanged(
        { lastSeq: current.lastSeq, nextOrdinal: current.nextOrdinal },
        record,
        { ...current, lastSeq: record.seq ?? current.lastSeq, nextOrdinal: record.ordinal + 1 },
      );
    }

    async function ordinalsOf(): Promise<number[]> {
      return (await storage.list()).map((record) => record.ordinal);
    }

    it('holds no registration, and no records, before anything is written', async () => {
      await expect(storage.readMeta()).resolves.toBeNull();
      await expect(storage.list()).resolves.toEqual([]);
      await expect(storage.firstUnfinished()).resolves.toBeUndefined();
      await expect(storage.resetSending()).resolves.toBe(0);
    });

    it('gives the registration back as a copy, so a caller cannot change it in place', async () => {
      await storage.writeMeta(registration);

      const read = await storage.readMeta();
      expect(read).toEqual(registration);
      if (read) {
        Object.assign(read, { lastSeq: 99 });
      }

      await expect(storage.readMeta()).resolves.toEqual(registration);
    });

    it('replaces the registration when another one is written', async () => {
      await storage.writeMeta(registration);
      await storage.writeMeta(meta({ code: 'T2', epoch: 2, lastSeq: 7, nextOrdinal: 8 }));

      await expect(storage.readMeta()).resolves.toMatchObject({
        code: 'T2',
        epoch: 2,
        lastSeq: 7,
        nextOrdinal: 8,
      });
    });

    it('stores a record and the counters that go with it in one step', async () => {
      await storage.writeMeta(registration);
      const record = await storedSale(registration, 1, 1);

      await expect(append(record)).resolves.toBe(true);

      await expect(storage.get(record.id)).resolves.toEqual(record);
      await expect(storage.list()).resolves.toEqual([record]);
      await expect(storage.firstUnfinished()).resolves.toEqual(record);
      await expect(storage.readMeta()).resolves.toMatchObject({ lastSeq: 1, nextOrdinal: 2 });
    });

    it('appends nothing when the counters moved on since they were read', async () => {
      await storage.writeMeta(registration);
      const record = await storedSale(registration, 1, 1);
      const expectations = [
        { lastSeq: registration.lastSeq + 1, nextOrdinal: registration.nextOrdinal },
        { lastSeq: registration.lastSeq, nextOrdinal: registration.nextOrdinal + 1 },
      ];

      for (const expectation of expectations) {
        await expect(
          storage.appendIfUnchanged(expectation, record, meta({ lastSeq: 1, nextOrdinal: 2 })),
          JSON.stringify(expectation),
        ).resolves.toBe(false);
      }

      await expect(storage.list()).resolves.toEqual([]);
      await expect(storage.readMeta()).resolves.toEqual(registration);
    });

    it('appends nothing while the device is not registered', async () => {
      const record = await storedSale(registration, 1, 1);

      await expect(
        storage.appendIfUnchanged({ lastSeq: 0, nextOrdinal: 1 }, record, registration),
      ).resolves.toBe(false);

      await expect(storage.list()).resolves.toEqual([]);
      await expect(storage.readMeta()).resolves.toBeNull();
    });

    it('refuses a second record under an id it already holds, and keeps the counters', async () => {
      await storage.writeMeta(registration);
      const record = await storedSale(registration, 1, 1);
      await append(record);

      await failureOf(() => append({ ...record, ordinal: 2, seq: 2 }), 'UNKNOWN');

      await expect(storage.list()).resolves.toEqual([record]);
      await expect(storage.readMeta()).resolves.toMatchObject({ lastSeq: 1, nextOrdinal: 2 });
    });

    it('holds no record under an id it was never given', async () => {
      await storage.writeMeta(registration);
      await append(await storedSale(registration, 1, 1));

      await expect(storage.get('nothing-like-this')).resolves.toBeUndefined();
    });

    it('lists records in ordinal order, whatever order they arrived in', async () => {
      await storage.writeMeta(meta({ lastSeq: 2, nextOrdinal: 3 }));
      await append(await storedSale(registration, 3, 3));
      await storage.writeMeta(registration);
      await append(await storedOpen(registration, 1));
      await append(await storedSale(registration, 2, 1));

      await expect(ordinalsOf()).resolves.toEqual([1, 2, 3]);
    });

    it('finds the lowest-ordinal record that is not finished, whatever its kind', async () => {
      await storage.writeMeta(registration);
      await append(await storedOpen(registration, 1, { status: 'acked' }));
      await append(await storedSale(registration, 2, 1, { status: 'voided' }));
      const conflicted = await storedSale(registration, 3, 2, { status: 'conflict' });
      await append(conflicted);
      const sending = await storedSale(registration, 4, 3, { status: 'sending' });
      await append(sending);
      const pending = await storedSale(registration, 5, 4);
      await append(pending);

      await expect(storage.firstUnfinished()).resolves.toEqual(conflicted);

      await storage.update(conflicted.id, { status: 'acked' });
      await expect(storage.firstUnfinished()).resolves.toEqual(sending);

      await storage.update(sending.id, { status: 'voided' });
      await expect(storage.firstUnfinished()).resolves.toEqual(pending);

      await storage.update(pending.id, { status: 'acked' });
      await expect(storage.firstUnfinished()).resolves.toBeUndefined();
    });

    it('changes only the fields a patch names, and gives back the stored record', async () => {
      await storage.writeMeta(registration);
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

    it('reports an update of a record it does not hold as NOT_FOUND', async () => {
      await storage.writeMeta(registration);
      await append(await storedSale(registration, 1, 1));

      await failureOf(() => storage.update('nothing-like-this', { status: 'acked' }), 'NOT_FOUND');

      await expect(ordinalsOf()).resolves.toEqual([1]);
    });

    it('moves every sending record back to pending and says how many it moved', async () => {
      await storage.writeMeta(registration);
      await append(await storedOpen(registration, 1, { status: 'sending' }));
      await append(await storedSale(registration, 2, 1, { status: 'acked' }));
      await append(await storedSale(registration, 3, 2, { status: 'sending' }));
      await append(await storedSale(registration, 4, 3, { status: 'conflict' }));

      await expect(storage.resetSending()).resolves.toBe(2);

      const statuses = (await storage.list()).map((record) => record.status);
      expect(statuses).toEqual(['pending', 'acked', 'pending', 'conflict']);
      await expect(storage.resetSending()).resolves.toBe(0);
    });

    it('keeps what it knows about a record it recovers, apart from its status', async () => {
      await storage.writeMeta(registration);
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

    it('hands out copies of its records, so a caller cannot change what is stored', async () => {
      await storage.writeMeta(registration);
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
