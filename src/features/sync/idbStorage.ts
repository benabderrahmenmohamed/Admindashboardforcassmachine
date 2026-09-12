import { AppError } from '@/lib/errors';
import {
  isUnfinished,
  metaUnchanged,
  readStoredMeta,
  readStoredRecord,
  type StoredOutboxRecord,
} from './meta';
import type { OutboxMeta, OutboxRecord, OutboxStorage } from './types';

export const OUTBOX_DB_NAME = 'pos-outbox';
const DB_VERSION = 1;
const RECORDS = 'records';
const META = 'meta';
/** The key the row has always had; the row itself now holds the device's queue, not just a till. */
const META_KEY = 'terminal';

/**
 * The parts of an IndexedDB request this module uses. `IDBRequest<T>` is invariant in `T` (its
 * handlers are typed with `this`), so one helper cannot take every store's request through that
 * type; this shape can, and each call names what its store holds.
 */
interface PendingRequest {
  result: unknown;
  error: DOMException | null;
  onsuccess: ((event: Event) => void) | null;
  onerror: ((event: Event) => void) | null;
}

function request<T>(req: PendingRequest): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result as T);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
  });
}

function completion(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });
}

export function openOutboxDatabase(
  factory: IDBFactory = indexedDB,
  name = OUTBOX_DB_NAME,
): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = factory.open(name, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(RECORDS)) {
        const store = db.createObjectStore(RECORDS, { keyPath: 'id' });
        store.createIndex('ordinal', 'ordinal', { unique: true });
        store.createIndex('status', 'status');
      }
      if (!db.objectStoreNames.contains(META)) {
        db.createObjectStore(META, { keyPath: 'key' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () =>
      reject(
        new AppError('UNKNOWN', 'This browser could not open the local outbox.', {
          cause: req.error,
        }),
      );
    req.onblocked = () =>
      reject(
        new AppError(
          'UNKNOWN',
          'The local outbox is held by another tab. Close other tabs and reload.',
        ),
      );
  });
}

export function deleteOutboxDatabase(
  factory: IDBFactory = indexedDB,
  name = OUTBOX_DB_NAME,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = factory.deleteDatabase(name);
    req.onsuccess = () => resolve();
    req.onerror = () =>
      reject(
        new AppError('UNKNOWN', 'This browser could not reset the local outbox.', {
          cause: req.error,
        }),
      );
    // A connection somewhere else still holds the outbox, so the delete waits for it: without this
    // the promise would never settle at all, and the boot that reset the demo would hang on it.
    req.onblocked = () =>
      reject(
        new AppError(
          'UNKNOWN',
          'The local outbox is held by another tab. Close other tabs and reload.',
        ),
      );
  });
}

function storedMeta(meta: OutboxMeta): OutboxMeta & { readonly key: typeof META_KEY } {
  return { ...meta, key: META_KEY };
}

/**
 * Outbox storage on IndexedDB. Allocation and the record write happen in one readwrite transaction
 * over both stores, so a crash leaves either both or neither.
 */
export function createIdbOutboxStorage(db: IDBDatabase): OutboxStorage {
  async function guard<T>(action: string, work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }
      throw new AppError('UNKNOWN', `The local outbox failed while ${action}.`, { cause: error });
    }
  }

  return {
    readMeta: () =>
      guard('reading the queue of this device', async () => {
        const tx = db.transaction(META, 'readonly');
        return readStoredMeta(await request<unknown>(tx.objectStore(META).get(META_KEY)));
      }),

    writeMeta: (meta) =>
      guard('saving the queue of this device', async () => {
        const tx = db.transaction(META, 'readwrite');
        const done = completion(tx);
        tx.objectStore(META).put(storedMeta(meta));
        await done;
      }),

    appendIfUnchanged: (expected, record, next) =>
      guard('saving a record', async () => {
        const tx = db.transaction([META, RECORDS], 'readwrite');
        const done = completion(tx);
        const current = readStoredMeta(await request<unknown>(tx.objectStore(META).get(META_KEY)));
        if (!metaUnchanged(current, expected)) {
          tx.abort();
          // Our own abort: the promise rejects with an AbortError that carries no information.
          await done.catch(() => undefined);
          return false;
        }
        tx.objectStore(RECORDS).add(record);
        tx.objectStore(META).put(storedMeta(next));
        await done;
        return true;
      }),

    get: (id) =>
      guard('reading a record', async () => {
        const tx = db.transaction(RECORDS, 'readonly');
        const row = await request<StoredOutboxRecord | undefined>(tx.objectStore(RECORDS).get(id));
        return row ? readStoredRecord(row) : undefined;
      }),

    list: () =>
      guard('reading the queue', async () => {
        const tx = db.transaction(RECORDS, 'readonly');
        const rows = await request<StoredOutboxRecord[]>(
          tx.objectStore(RECORDS).index('ordinal').getAll(),
        );
        return rows.map(readStoredRecord);
      }),

    firstUnfinished: () =>
      guard('reading the queue', () => {
        const tx = db.transaction(RECORDS, 'readonly');
        const cursorRequest = tx.objectStore(RECORDS).index('ordinal').openCursor();
        return new Promise<OutboxRecord | undefined>((resolve, reject) => {
          cursorRequest.onsuccess = () => {
            const cursor = cursorRequest.result;
            if (!cursor) {
              resolve(undefined);
              return;
            }
            const value = readStoredRecord(cursor.value as StoredOutboxRecord);
            if (isUnfinished(value)) {
              resolve(value);
              return;
            }
            cursor.continue();
          };
          cursorRequest.onerror = () =>
            reject(cursorRequest.error ?? new Error('IndexedDB cursor failed'));
        });
      }),

    update: (id, patch) =>
      guard('updating a record', async () => {
        const tx = db.transaction(RECORDS, 'readwrite');
        const done = completion(tx);
        const store = tx.objectStore(RECORDS);
        const row = await request<StoredOutboxRecord | undefined>(store.get(id));
        const current = row ? readStoredRecord(row) : undefined;
        if (!current) {
          tx.abort();
          // Our own abort, reported as NOT_FOUND below.
          await done.catch(() => undefined);
          throw new AppError('NOT_FOUND', 'The outbox record does not exist.');
        }
        const next = { ...current, ...patch };
        store.put(next);
        await done;
        return next;
      }),

    resetSending: () =>
      guard('recovering interrupted sends', async () => {
        const tx = db.transaction(RECORDS, 'readwrite');
        const done = completion(tx);
        const store = tx.objectStore(RECORDS);
        const sending = (
          await request<StoredOutboxRecord[]>(store.index('status').getAll('sending'))
        ).map(readStoredRecord);
        for (const record of sending) {
          store.put({ ...record, status: 'pending' });
        }
        await done;
        return sending.length;
      }),
  };
}
