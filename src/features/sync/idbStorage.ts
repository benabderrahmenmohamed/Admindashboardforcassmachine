import { AppError } from '@/lib/errors';
import type { OutboxMeta, OutboxRecord, OutboxStorage } from './types';

export const OUTBOX_DB_NAME = 'pos-outbox';
const DB_VERSION = 1;
const RECORDS = 'records';
const META = 'meta';
const META_KEY = 'terminal';

type StoredMeta = OutboxMeta & { readonly key: typeof META_KEY };

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

function withoutKey({ key, ...meta }: StoredMeta): OutboxMeta {
  void key;
  return meta;
}

function isUnfinished(record: OutboxRecord): boolean {
  return record.status === 'pending' || record.status === 'sending' || record.status === 'conflict';
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
      guard('reading the terminal registration', async () => {
        const tx = db.transaction(META, 'readonly');
        const row = await request<StoredMeta | undefined>(tx.objectStore(META).get(META_KEY));
        return row ? withoutKey(row) : null;
      }),

    writeMeta: (meta) =>
      guard('saving the terminal registration', async () => {
        const tx = db.transaction(META, 'readwrite');
        const done = completion(tx);
        tx.objectStore(META).put({ ...meta, key: META_KEY });
        await done;
      }),

    appendIfUnchanged: (expected, record, next) =>
      guard('saving a record', async () => {
        const tx = db.transaction([META, RECORDS], 'readwrite');
        const done = completion(tx);
        const current = await request<StoredMeta | undefined>(tx.objectStore(META).get(META_KEY));
        if (
          !current ||
          current.lastSeq !== expected.lastSeq ||
          current.nextOrdinal !== expected.nextOrdinal
        ) {
          tx.abort();
          // Our own abort: the promise rejects with an AbortError that carries no information.
          await done.catch(() => undefined);
          return false;
        }
        tx.objectStore(RECORDS).add(record);
        tx.objectStore(META).put({ ...next, key: META_KEY });
        await done;
        return true;
      }),

    get: (id) =>
      guard('reading a record', async () => {
        const tx = db.transaction(RECORDS, 'readonly');
        return await request<OutboxRecord | undefined>(tx.objectStore(RECORDS).get(id));
      }),

    list: () =>
      guard('reading the queue', async () => {
        const tx = db.transaction(RECORDS, 'readonly');
        return await request<OutboxRecord[]>(tx.objectStore(RECORDS).index('ordinal').getAll());
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
            const value = cursor.value as OutboxRecord;
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
        const current = await request<OutboxRecord | undefined>(store.get(id));
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
        const sending = await request<OutboxRecord[]>(store.index('status').getAll('sending'));
        for (const record of sending) {
          store.put({ ...record, status: 'pending' });
        }
        await done;
        return sending.length;
      }),
  };
}
