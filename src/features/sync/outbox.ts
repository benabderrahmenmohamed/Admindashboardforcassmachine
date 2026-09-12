import { AppError, errorClass, toAppError } from '@/lib/errors';
import type { CloseSessionRecord, OpenSessionRecord, SaleRecord } from '@/ports';
import type {
  DrainOutcome,
  OutboxDeps,
  OutboxError,
  OutboxMeta,
  OutboxRecord,
  OutboxResult,
  OutboxSummary,
} from './types';

export const BASE_DELAY_MS = 500;
export const MAX_DELAY_MS = 60_000;
export const JITTER_MS = 250;
const APPEND_ATTEMPTS = 5;

/** min(500 ms × 2^attempts + jitter, 60 s). Retriable failures are retried without limit. */
export function backoffDelay(attempts: number, random: () => number): number {
  const exponential = BASE_DELAY_MS * 2 ** Math.min(Math.max(attempts, 0), 20);
  return Math.min(exponential + Math.floor(random() * JITTER_MS), MAX_DELAY_MS);
}

function toOutboxError(error: AppError): OutboxError {
  return { code: error.code, message: error.message, details: error.details };
}

type Listener = () => void;

/**
 * The offline outbox. Pure: storage, transport, clock, randomness and the cross-tab lock are all
 * injected, so it runs the same against IndexedDB in the browser and against fakes in tests.
 */
export function createOutbox(deps: OutboxDeps) {
  const listeners = new Set<Listener>();
  let running: Promise<DrainOutcome> | null = null;

  function notify(): void {
    for (const listener of listeners) {
      listener();
    }
  }

  async function requireMeta(): Promise<OutboxMeta> {
    const meta = await deps.storage.readMeta();
    if (!meta) {
      throw new AppError('CONFIG_ERROR', 'This device is not registered as a terminal.');
    }
    return meta;
  }

  /**
   * Allocates the next ordinal (and, for sales and refunds, the next receipt number), builds the
   * record with them, and stores record and counters in one transaction. If another context
   * allocated in between, the allocation is retried with fresh numbers, so no number is used twice
   * and none is skipped.
   */
  async function append<P extends SaleRecord | OpenSessionRecord | CloseSessionRecord>(
    kind: OutboxRecord['kind'],
    build: (allocation: { readonly seq: number | null; readonly meta: OutboxMeta }) => Promise<P>,
  ): Promise<OutboxRecord> {
    for (let attempt = 0; attempt < APPEND_ATTEMPTS; attempt += 1) {
      const meta = await requireMeta();
      const numbered = kind === 'sale' || kind === 'refund';
      const seq = numbered ? meta.lastSeq + 1 : null;
      const payload = await build({ seq, meta });
      const now = deps.clock.now();
      const base = {
        id: payload.id,
        ordinal: meta.nextOrdinal,
        terminalCode: meta.code,
        payloadHash: payload.payloadHash,
        createdAt: now,
        attempts: 0,
        nextAttemptAt: now,
        status: 'pending' as const,
        lastError: null,
        result: null,
        ackedAt: null,
      };
      let record: OutboxRecord;
      if (kind === 'sale' || kind === 'refund') {
        const sale = payload as SaleRecord;
        if (sale.seq !== seq || sale.kind !== kind) {
          throw new AppError(
            'VALIDATION_ERROR',
            'The record was not built with the allocated number.',
          );
        }
        record = { ...base, kind, seq: sale.seq, sessionId: sale.sessionId, payload: sale };
      } else if (kind === 'session_open') {
        const open = payload as OpenSessionRecord;
        record = { ...base, kind, seq: null, sessionId: open.id, payload: open };
      } else {
        const close = payload as CloseSessionRecord;
        record = { ...base, kind, seq: null, sessionId: close.sessionId, payload: close };
      }
      const next: OutboxMeta = {
        ...meta,
        lastSeq: seq ?? meta.lastSeq,
        nextOrdinal: meta.nextOrdinal + 1,
      };
      if (
        await deps.storage.appendIfUnchanged(
          { lastSeq: meta.lastSeq, nextOrdinal: meta.nextOrdinal },
          record,
          next,
        )
      ) {
        notify();
        return record;
      }
    }
    throw new AppError('UNKNOWN', 'Could not reserve the next receipt number. Try again.');
  }

  async function pass(): Promise<DrainOutcome> {
    const meta = await deps.storage.readMeta();
    if (!meta) {
      return { state: 'paused', reason: 'unregistered' };
    }
    if (!deps.canSend()) {
      return { state: 'paused', reason: 'auth' };
    }
    // Holding the drain lock, any record still marked sending was left by a pass that died.
    if ((await deps.storage.resetSending()) > 0) {
      notify();
    }
    for (;;) {
      const head = await deps.storage.firstUnfinished();
      if (!head) {
        return { state: 'idle' };
      }
      if (head.status === 'conflict') {
        return { state: 'blocked', recordId: head.id };
      }
      if (head.nextAttemptAt > deps.clock.now()) {
        return { state: 'waiting', retryAt: head.nextAttemptAt };
      }
      if (!deps.canSend()) {
        return { state: 'paused', reason: 'auth' };
      }

      await deps.storage.update(head.id, { status: 'sending' });
      let result: OutboxResult;
      try {
        result = await deps.transport.send(head);
      } catch (error) {
        const appError = toAppError(error);
        const lastError = toOutboxError(appError);
        switch (errorClass(appError.code)) {
          case 'retriable': {
            const attempts = head.attempts + 1;
            const retryAt = deps.clock.now() + backoffDelay(attempts, deps.random);
            await deps.storage.update(head.id, {
              status: 'pending',
              attempts,
              nextAttemptAt: retryAt,
              lastError,
            });
            notify();
            return { state: 'waiting', retryAt };
          }
          case 'auth':
            await deps.storage.update(head.id, { status: 'pending', lastError });
            notify();
            return { state: 'paused', reason: 'auth' };
          case 'conflict':
            await deps.storage.update(head.id, { status: 'conflict', lastError });
            notify();
            return { state: 'blocked', recordId: head.id };
        }
      }
      await deps.storage.update(head.id, {
        status: result.status === 'voided' ? 'voided' : 'acked',
        result,
        lastError: null,
        ackedAt: deps.clock.now(),
      });
      notify();
    }
  }

  return {
    appendSale(
      kind: 'sale' | 'refund',
      build: (allocation: { seq: number; meta: OutboxMeta }) => Promise<SaleRecord>,
    ) {
      return append(kind, ({ seq, meta }) => build({ seq: seq as number, meta }));
    },

    appendSessionOpen(build: (allocation: { meta: OutboxMeta }) => Promise<OpenSessionRecord>) {
      return append('session_open', ({ meta }) => build({ meta }));
    },

    appendSessionClose(build: (allocation: { meta: OutboxMeta }) => Promise<CloseSessionRecord>) {
      return append('session_close', ({ meta }) => build({ meta }));
    },

    /** One pass at a time in this tab, and at most one tab draining a terminal at a time. */
    drain(): Promise<DrainOutcome> {
      if (!running) {
        running = (async () => {
          try {
            const meta = await deps.storage.readMeta();
            if (!meta) {
              return { state: 'paused', reason: 'unregistered' } as const;
            }
            const outcome = await deps.lock.runExclusive(`outbox:${meta.code}`, pass);
            return outcome === 'busy' ? ({ state: 'busy' } as const) : outcome;
          } finally {
            running = null;
          }
        })();
      }
      return running;
    },

    /**
     * Brings every waiting retry forward, for when the reason they were waiting is gone: the
     * connection is back. Attempt counts stay as they are, so a record that fails again waits as
     * long as it had earned.
     */
    async wakeNow(): Promise<void> {
      const now = deps.clock.now();
      const waiting = (await deps.storage.list()).filter(
        (record) => record.status === 'pending' && record.nextAttemptAt > now,
      );
      for (const record of waiting) {
        await deps.storage.update(record.id, { nextAttemptAt: now });
      }
      if (waiting.length > 0) {
        notify();
      }
    },

    /** A person reviewed a conflict and wants it sent again. */
    async retry(id: string): Promise<void> {
      const record = await deps.storage.get(id);
      if (!record || record.status !== 'conflict') {
        throw new AppError('VALIDATION_ERROR', 'Only a record in conflict can be retried.');
      }
      await deps.storage.update(id, {
        status: 'pending',
        attempts: 0,
        nextAttemptAt: deps.clock.now(),
      });
      notify();
    },

    /** A person voided a conflicting record on the server; store what the server said. */
    async resolveVoid(id: string, result: OutboxResult): Promise<void> {
      const record = await deps.storage.get(id);
      if (!record || record.status !== 'conflict') {
        throw new AppError('VALIDATION_ERROR', 'Only a record in conflict can be voided.');
      }
      await deps.storage.update(id, {
        status: result.status === 'recorded' || result.status === 'replayed' ? 'acked' : 'voided',
        result,
        ackedAt: deps.clock.now(),
      });
      notify();
    },

    async summary(): Promise<OutboxSummary> {
      const records = await deps.storage.list();
      let pending = 0;
      let conflicts = 0;
      let lastAckAt: number | null = null;
      for (const record of records) {
        if (record.status === 'pending' || record.status === 'sending') pending += 1;
        if (record.status === 'conflict') conflicts += 1;
        if (record.ackedAt !== null && (lastAckAt === null || record.ackedAt > lastAckAt))
          lastAckAt = record.ackedAt;
      }
      return { pending, conflicts, lastAckAt };
    },

    list(): Promise<OutboxRecord[]> {
      return deps.storage.list();
    },

    subscribe(listener: Listener): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export type Outbox = ReturnType<typeof createOutbox>;
