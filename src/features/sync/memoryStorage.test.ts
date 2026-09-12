import { describe, expect, it } from 'vitest';
import { AppError } from '@/lib/errors';
import { meta, registration, storedSale } from './__tests__/fixtures';
import { describeOutboxStorage } from './__tests__/storageSuite';
import { createMemoryOutboxStorage } from './memoryStorage';

// The shared storage contract on the in-memory storage, plus what is specific to it.

describeOutboxStorage('the memory outbox storage', () =>
  Promise.resolve({ storage: createMemoryOutboxStorage() }),
);

describe('createMemoryOutboxStorage', () => {
  it('gives every caller a storage of its own', async () => {
    const first = createMemoryOutboxStorage();
    const second = createMemoryOutboxStorage();
    await first.writeMeta(meta());
    await first.appendIfUnchanged(
      meta(),
      await storedSale(registration(), 1, 1),
      meta({ nextOrdinal: 2, terminal: registration({ lastSeq: 1 }) }),
    );

    await expect(second.readMeta()).resolves.toBeNull();
    await expect(second.list()).resolves.toEqual([]);
    await expect(first.list()).resolves.toHaveLength(1);
  });

  // The two storages are interchangeable, so a failure has to arrive the same way from both: as a
  // rejection, never as a throw before the promise exists. (This was the one foundation bug this
  // suite found: the methods were not async. Integration made them so.)
  it('reports a missing record as a rejected promise, as the type of update says', async () => {
    const storage = createMemoryOutboxStorage();

    const settled = storage.update('nothing-like-this', { status: 'acked' });

    await expect(settled).rejects.toBeInstanceOf(AppError);
  });

  it('reports a duplicate id as a rejected promise too', async () => {
    const storage = createMemoryOutboxStorage();
    const record = await storedSale(registration(), 1, 1);
    const afterFirst = meta({ nextOrdinal: 2, terminal: registration({ lastSeq: 1 }) });
    await storage.writeMeta(meta());
    await storage.appendIfUnchanged(meta(), record, afterFirst);

    const settled = storage.appendIfUnchanged(
      afterFirst,
      { ...record, ordinal: 2 },
      meta({ nextOrdinal: 3, terminal: registration({ lastSeq: 2 }) }),
    );

    await expect(settled).rejects.toBeInstanceOf(AppError);
  });
});
