import { IDBFactory as FakeIdbFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import { AppError } from '@/lib/errors';
import { meta, storedSale, uuid } from './__tests__/fixtures';
import { describeOutboxStorage } from './__tests__/storageSuite';
import {
  createIdbOutboxStorage,
  deleteOutboxDatabase,
  openOutboxDatabase,
  OUTBOX_DB_NAME,
} from './idbStorage';

// The shared storage contract on IndexedDB, plus what only a database does: a schema, rows that
// outlive the page, and one database seen through several connections. Each test gets its own
// IDBFactory, so no test can see another one's database.

const registration = meta();

describeOutboxStorage('the IndexedDB outbox storage', async () => {
  const db = await openOutboxDatabase(new FakeIdbFactory());
  return {
    storage: createIdbOutboxStorage(db),
    close: () => {
      db.close();
      return Promise.resolve();
    },
  };
});

/** The first record, and the counters it leaves behind. */
async function appendFirst(storage: ReturnType<typeof createIdbOutboxStorage>) {
  const record = await storedSale(registration, 1, 1);
  await storage.writeMeta(registration);
  await storage.appendIfUnchanged(
    { lastSeq: 0, nextOrdinal: 1 },
    record,
    meta({ lastSeq: 1, nextOrdinal: 2 }),
  );
  return record;
}

describe('openOutboxDatabase', () => {
  it('opens the outbox under its own name', async () => {
    const factory = new FakeIdbFactory();

    const db = await openOutboxDatabase(factory);
    db.close();

    expect(db.name).toBe(OUTBOX_DB_NAME);
    await expect(factory.databases()).resolves.toEqual([{ name: OUTBOX_DB_NAME, version: 1 }]);
  });

  it('creates a store for the records and one for the registration', async () => {
    const db = await openOutboxDatabase(new FakeIdbFactory());

    expect(Array.from(db.objectStoreNames)).toEqual(['meta', 'records']);
    const records = db.transaction('records', 'readonly').objectStore('records');
    expect(records.keyPath).toBe('id');
    expect(Array.from(records.indexNames)).toEqual(['ordinal', 'status']);
    expect(records.index('ordinal').unique).toBe(true);
    expect(records.index('status').unique).toBe(false);
    db.close();
  });

  it('keeps everything it stored when the page is closed and opened again', async () => {
    const factory = new FakeIdbFactory();
    const db = await openOutboxDatabase(factory);
    const record = await appendFirst(createIdbOutboxStorage(db));
    db.close();

    const reopened = await openOutboxDatabase(factory);
    const storage = createIdbOutboxStorage(reopened);

    await expect(storage.list()).resolves.toEqual([record]);
    await expect(storage.readMeta()).resolves.toMatchObject({ lastSeq: 1, nextOrdinal: 2 });
    reopened.close();
  });

  it('shows one connection what another connection wrote, as a second tab sees it', async () => {
    const factory = new FakeIdbFactory();
    const [first, second] = [await openOutboxDatabase(factory), await openOutboxDatabase(factory)];
    const record = await appendFirst(createIdbOutboxStorage(first));

    const other = createIdbOutboxStorage(second);

    await expect(other.firstUnfinished()).resolves.toEqual(record);
    await other.update(record.id, { status: 'acked', ackedAt: record.createdAt });
    await expect(createIdbOutboxStorage(first).firstUnfinished()).resolves.toBeUndefined();
    first.close();
    second.close();
  });

  it('refuses two records with the same ordinal, whatever their ids', async () => {
    const db = await openOutboxDatabase(new FakeIdbFactory());
    const storage = createIdbOutboxStorage(db);
    const record = await appendFirst(storage);
    await storage.writeMeta(registration);

    await expect(
      storage.appendIfUnchanged(
        { lastSeq: 0, nextOrdinal: 1 },
        { ...record, id: uuid(4_242) },
        meta({ lastSeq: 1, nextOrdinal: 2 }),
      ),
    ).rejects.toBeInstanceOf(AppError);

    await expect(storage.list()).resolves.toEqual([record]);
    await expect(storage.readMeta()).resolves.toEqual(registration);
    db.close();
  });
});

describe('deleteOutboxDatabase', () => {
  // The delete waits for every open connection to close, and the caller that resets the demo holds
  // none: the memory backend resets the outbox at boot, before it builds one. A caller that still
  // holds a connection has to close it first, and is told so rather than left waiting.
  it('leaves nothing behind, so the next boot starts on an empty outbox', async () => {
    const factory = new FakeIdbFactory();
    const db = await openOutboxDatabase(factory);
    await appendFirst(createIdbOutboxStorage(db));
    db.close();

    await deleteOutboxDatabase(factory);

    await expect(factory.databases()).resolves.toEqual([]);
    const fresh = await openOutboxDatabase(factory);
    const storage = createIdbOutboxStorage(fresh);
    await expect(storage.readMeta()).resolves.toBeNull();
    await expect(storage.list()).resolves.toEqual([]);
    fresh.close();
  });

  it('does nothing when there is no outbox to delete', async () => {
    await expect(deleteOutboxDatabase(new FakeIdbFactory())).resolves.toBeUndefined();
  });

  it('reports a connection still holding the outbox instead of waiting for ever', async () => {
    const factory = new FakeIdbFactory();
    const db = await openOutboxDatabase(factory);
    await appendFirst(createIdbOutboxStorage(db));

    // The connection is left open, as another tab of the app leaves it: IndexedDB answers 'blocked'
    // and never 'success', so a delete that ignored it would settle on nothing at all.
    await expect(deleteOutboxDatabase(factory)).rejects.toBeInstanceOf(AppError);

    db.close();
  });
});
