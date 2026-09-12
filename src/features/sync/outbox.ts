import { AppError, errorClass, toAppError } from '@/lib/errors';
import type { CloseSessionRecord, OpenSessionRecord, SaleRecord } from '@/ports';
import { EMPTY_META } from './meta';
import { prunable } from './retention';
import {
  isOrderRecord,
  type DrainOutcome,
  type LedgerKind,
  type LedgerOutboxRecord,
  type OrderKind,
  type OrderOutboxRecord,
  type OrderPayload,
  type OutboxDeps,
  type OutboxError,
  type OutboxMeta,
  type OutboxRecord,
  type OutboxResult,
  type OutboxSummary,
  type TerminalMeta,
} from './types';

export const BASE_DELAY_MS = 500;
export const MAX_DELAY_MS = 60_000;
export const JITTER_MS = 250;
const APPEND_ATTEMPTS = 5;

/**
 * The drain lock's name. One queue per device — a waiter's phone has no terminal to name it by —
 * and IndexedDB is per origin, so every tab of this app on this device shares the one queue.
 */
export const DRAIN_LOCK_NAME = 'outbox';

/** min(500 ms × 2^attempts + jitter, 60 s). Retriable failures are retried without limit. */
export function backoffDelay(attempts: number, random: () => number): number {
  const exponential = BASE_DELAY_MS * 2 ** Math.min(Math.max(attempts, 0), 20);
  return Math.min(exponential + Math.floor(random() * JITTER_MS), MAX_DELAY_MS);
}

function toOutboxError(error: AppError): OutboxError {
  return { code: error.code, message: error.message, details: error.details };
}

type Listener = () => void;

/** What a ledger record is built with: its receipt number, if it takes one, and the registration. */
interface LedgerAllocation {
  readonly seq: number | null;
  readonly meta: TerminalMeta;
}

/**
 * The offline outbox. Pure: storage, transport, clock, randomness and the cross-tab lock are all
 * injected, so it runs the same against IndexedDB in the browser and against fakes in tests.
 *
 * Every record of the device — a sale at the caisse, an item a waiter put on a table — goes into one
 * queue and leaves it in the order it was written, so an item added offline and removed a minute
 * later reaches the server added first.
 */
export function createOutbox(deps: OutboxDeps) {
  const listeners = new Set<Listener>();
  let running: Promise<DrainOutcome> | null = null;

  function notify(): void {
    for (const listener of listeners) {
      listener();
    }
  }

  /**
   * Allocates the next ordinal, lets `build` make the record with it, and stores record and counters
   * in one transaction. If another tab allocated in between, the allocation is retried with fresh
   * numbers, so no number is used twice and none is skipped.
   */
  async function allocate<R extends OutboxRecord>(
    build: (meta: OutboxMeta) => Promise<{ readonly record: R; readonly next: OutboxMeta }>,
  ): Promise<R> {
    for (let attempt = 0; attempt < APPEND_ATTEMPTS; attempt += 1) {
      const stored = await deps.storage.readMeta();
      const { record, next } = await build(stored ?? EMPTY_META);
      if (await deps.storage.appendIfUnchanged(stored, record, next)) {
        notify();
        return record;
      }
    }
    throw new AppError('UNKNOWN', 'Could not reserve a place in the queue. Try again.');
  }

  function base(id: string, payloadHash: string, ordinal: number) {
    const now = deps.clock.now();
    return {
      id,
      ordinal,
      payloadHash,
      createdAt: now,
      attempts: 0,
      nextAttemptAt: now,
      status: 'pending' as const,
      lastError: null,
      result: null,
      ackedAt: null,
      discard: null,
    };
  }

  /** A record written on a register: it needs the registration, and a sale or refund its number. */
  function appendLedger<P extends SaleRecord | OpenSessionRecord | CloseSessionRecord>(
    kind: LedgerKind,
    build: (allocation: LedgerAllocation) => Promise<P>,
  ): Promise<LedgerOutboxRecord> {
    return allocate(async (meta) => {
      const terminal = meta.terminal;
      if (!terminal) {
        throw new AppError('CONFIG_ERROR', 'This device is not registered as a terminal.');
      }
      const numbered = kind === 'sale' || kind === 'refund';
      const seq = numbered ? terminal.lastSeq + 1 : null;
      const payload = await build({ seq, meta: terminal });
      const shared = base(payload.id, payload.payloadHash, meta.nextOrdinal);
      let record: LedgerOutboxRecord;
      if (kind === 'sale' || kind === 'refund') {
        const sale = payload as SaleRecord;
        if (sale.seq !== seq || sale.kind !== kind) {
          throw new AppError(
            'VALIDATION_ERROR',
            'The record was not built with the allocated number.',
          );
        }
        record = {
          ...shared,
          kind,
          seq: sale.seq,
          terminalCode: terminal.code,
          sessionId: sale.sessionId,
          payload: sale,
        };
      } else if (kind === 'session_open') {
        const open = payload as OpenSessionRecord;
        record = {
          ...shared,
          kind,
          seq: null,
          terminalCode: terminal.code,
          sessionId: open.id,
          payload: open,
        };
      } else {
        const close = payload as CloseSessionRecord;
        record = {
          ...shared,
          kind,
          seq: null,
          terminalCode: terminal.code,
          sessionId: close.sessionId,
          payload: close,
        };
      }
      const next: OutboxMeta = {
        nextOrdinal: meta.nextOrdinal + 1,
        terminal: { ...terminal, lastSeq: seq ?? terminal.lastSeq },
      };
      return { record, next };
    });
  }

  async function pass(): Promise<DrainOutcome> {
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

  /** The record `id` if it is in conflict; a person can only act on a record that stopped the queue. */
  async function conflicted(id: string, action: string): Promise<OutboxRecord> {
    const record = await deps.storage.get(id);
    if (!record || record.status !== 'conflict') {
      throw new AppError('VALIDATION_ERROR', `Only a record in conflict can be ${action}.`);
    }
    return record;
  }

  return {
    appendSale(
      kind: 'sale' | 'refund',
      build: (allocation: { seq: number; meta: TerminalMeta }) => Promise<SaleRecord>,
    ) {
      return appendLedger(kind, ({ seq, meta }) => build({ seq: seq as number, meta }));
    },

    appendSessionOpen(build: (allocation: { meta: TerminalMeta }) => Promise<OpenSessionRecord>) {
      return appendLedger('session_open', ({ meta }) => build({ meta }));
    },

    appendSessionClose(build: (allocation: { meta: TerminalMeta }) => Promise<CloseSessionRecord>) {
      return appendLedger('session_close', ({ meta }) => build({ meta }));
    },

    /**
     * An order record, written on any device: it takes an ordinal and nothing else, because what is
     * on a table has no receipt number and a waiter's phone has no terminal. The record's own id is
     * the id it is known by — for an add, the id the item will have on the table.
     */
    appendOrder<K extends OrderKind>(
      kind: K,
      build: () => Promise<OrderPayload<K>>,
    ): Promise<OrderOutboxRecord> {
      return allocate(async (meta) => {
        const payload = await build();
        const record = {
          ...base(payload.id, payload.payloadHash, meta.nextOrdinal),
          kind,
          seq: null,
          terminalCode: null,
          sessionId: null,
          payload,
        } as OrderOutboxRecord;
        return { record, next: { ...meta, nextOrdinal: meta.nextOrdinal + 1 } };
      });
    },

    /** One pass at a time in this tab, and at most one tab draining the device's queue at a time. */
    drain(): Promise<DrainOutcome> {
      if (!running) {
        running = (async () => {
          try {
            const outcome = await deps.lock.runExclusive(DRAIN_LOCK_NAME, pass);
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
      await conflicted(id, 'retried');
      await deps.storage.update(id, {
        status: 'pending',
        attempts: 0,
        nextAttemptAt: deps.clock.now(),
      });
      notify();
    },

    /** A person voided a conflicting record on the server; store what the server said. */
    async resolveVoid(id: string, result: OutboxResult): Promise<void> {
      await conflicted(id, 'voided');
      await deps.storage.update(id, {
        status: result.status === 'recorded' || result.status === 'replayed' ? 'acked' : 'voided',
        result,
        ackedAt: deps.clock.now(),
      });
      notify();
    },

    /**
     * A person gives up on an order record in conflict, saying why, and the queue moves on. The
     * record stays on the device, in the dead-letter list the Conflicts screen shows. A sale, a
     * refund or a session record can never be discarded: money that was taken is never dropped.
     */
    async discard(
      id: string,
      input: {
        readonly reason: string;
        readonly discardedBy: string | null;
        readonly discardedByName: string | null;
      },
    ): Promise<void> {
      const record = await conflicted(id, 'discarded');
      if (!isOrderRecord(record)) {
        throw new AppError(
          'VALIDATION_ERROR',
          'A sale, a refund or a session record cannot be discarded. Retry it, or have an admin void it.',
        );
      }
      const reason = input.reason.trim();
      if (reason === '') {
        throw new AppError('VALIDATION_ERROR', 'Say why this record is being discarded.');
      }
      await deps.storage.update(id, {
        status: 'discarded',
        discard: {
          reason,
          discardedBy: input.discardedBy,
          discardedByName: input.discardedByName,
          discardedAt: deps.clock.now(),
        },
      });
      notify();
    },

    /**
     * Deletes the records this device no longer needs (`prunable`): what the server has had for a
     * week, less what a screen still reads. Returns how many went.
     */
    async prune(): Promise<number> {
      const now = deps.clock.now();
      const count = await deps.storage.prune((records) => prunable(records, now));
      if (count > 0) {
        notify();
      }
      return count;
    },

    async summary(): Promise<OutboxSummary> {
      const records = await deps.storage.list();
      let pending = 0;
      let conflicts = 0;
      let discarded = 0;
      let lastAckAt: number | null = null;
      for (const record of records) {
        if (record.status === 'pending' || record.status === 'sending') pending += 1;
        if (record.status === 'conflict') conflicts += 1;
        if (record.status === 'discarded') discarded += 1;
        if (record.ackedAt !== null && (lastAckAt === null || record.ackedAt > lastAckAt))
          lastAckAt = record.ackedAt;
      }
      return { pending, conflicts, discarded, lastAckAt };
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
