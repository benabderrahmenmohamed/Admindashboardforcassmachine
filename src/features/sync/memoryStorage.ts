import { AppError } from '@/lib/errors';
import type { OutboxMeta, OutboxRecord, OutboxStorage } from './types';

function isUnfinished(record: OutboxRecord): boolean {
  return record.status === 'pending' || record.status === 'sending' || record.status === 'conflict';
}

/** Outbox storage held in memory: for tests, and for the demo backend, which resets on reload anyway. */
export function createMemoryOutboxStorage(): OutboxStorage {
  let meta: OutboxMeta | null = null;
  const records = new Map<string, OutboxRecord>();
  const inOrder = () => [...records.values()].sort((a, b) => a.ordinal - b.ordinal);

  return {
    readMeta() {
      return Promise.resolve(meta ? { ...meta } : null);
    },

    writeMeta(next) {
      meta = { ...next };
      return Promise.resolve();
    },

    // Failures are rejected rather than thrown, as the IndexedDB storage rejects them: a caller
    // holding an OutboxStorage gets the failure the same way whichever storage is behind it.
    appendIfUnchanged(expected, record, next) {
      if (!meta || meta.lastSeq !== expected.lastSeq || meta.nextOrdinal !== expected.nextOrdinal) {
        return Promise.resolve(false);
      }
      if (records.has(record.id)) {
        return Promise.reject(
          new AppError('UNKNOWN', 'An outbox record with this id already exists.'),
        );
      }
      records.set(record.id, structuredClone(record));
      meta = { ...next };
      return Promise.resolve(true);
    },

    get(id) {
      const record = records.get(id);
      return Promise.resolve(record ? structuredClone(record) : undefined);
    },

    list() {
      return Promise.resolve(inOrder().map((record) => structuredClone(record)));
    },

    firstUnfinished() {
      const record = inOrder().find(isUnfinished);
      return Promise.resolve(record ? structuredClone(record) : undefined);
    },

    update(id, patch) {
      const current = records.get(id);
      if (!current) {
        return Promise.reject(new AppError('NOT_FOUND', 'The outbox record does not exist.'));
      }
      const next = { ...current, ...patch };
      records.set(id, next);
      return Promise.resolve(structuredClone(next));
    },

    resetSending() {
      let count = 0;
      for (const [id, record] of records) {
        if (record.status === 'sending') {
          records.set(id, { ...record, status: 'pending' });
          count += 1;
        }
      }
      return Promise.resolve(count);
    },
  };
}
