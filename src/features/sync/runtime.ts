/**
 * The outbox as the app runs it: the storage each backend gets, the triggers that drain it, and the
 * snapshot the screens read. Nothing here imports React and every source of time, randomness and
 * scheduling is injected, so it runs in the node test environment; the provider, the hooks and the
 * components wrap it.
 */
import { clear, createStore, del, get, set } from 'idb-keyval';
import { toAppError } from '@/lib/errors';
import type { Backend } from '@/ports';
import { createIdbOutboxStorage, deleteOutboxDatabase, openOutboxDatabase } from './idbStorage';
import { createWebLocksDrainLock } from './locks';
import { createMemoryOutboxStorage } from './memoryStorage';
import { createOutbox, type Outbox } from './outbox';
import { createPortTransport } from './transport';
import type {
  Clock,
  DrainOutcome,
  OutboxError,
  OutboxRecord,
  OutboxStorage,
  OutboxSummary,
} from './types';

/** How often a tab drains on its own, on top of the event triggers. */
export const DRAIN_INTERVAL_MS = 30_000;

/**
 * The version of the app the browser is running. It busts the persisted catalog cache, so move it
 * with the version in package.json whenever a release must not read what the one before cached.
 */
export const APP_VERSION = '0.0.1';

/** How long a persisted catalog is read back: a week of shop days. */
export const CATALOG_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** Where the persisted catalog lives: an idb-keyval database, store and key. */
export const CATALOG_CACHE_DB = 'pos-catalog';
export const CATALOG_CACHE_STORE = 'queries';
export const CATALOG_CACHE_KEY = 'catalog';

/** Phase 3 kept the registration and the unsent record here; Phase 4 moved both into the outbox. */
export const LEGACY_STORAGE_KEYS: readonly string[] = ['pos.terminal', 'pos.pendingRecord'];

/** The little of an asynchronous key-value store the catalog persister needs. */
export interface AsyncKeyValueStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

/**
 * What the queue is doing, for the sync chip and the Conflicts screen:
 * - `sending`: a pass of this tab is running; `busy`: another tab holds the drain lock.
 * - `waiting`: the head failed with a retriable error and goes again at `retryAt`.
 * - `blocked`: the head is in conflict and a person has to act; later records stay pending.
 * - `paused`: nothing is sent because there is no live session, or no terminal registration.
 * - `failed`: the pass itself could not run (no storage, no Web Locks): not a record's failure.
 */
export type SyncState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'sending' }
  | { readonly kind: 'busy' }
  | { readonly kind: 'waiting'; readonly retryAt: number }
  | { readonly kind: 'blocked'; readonly recordId: string }
  | { readonly kind: 'paused'; readonly reason: 'auth' | 'unregistered' }
  | { readonly kind: 'failed'; readonly error: OutboxError };

/** The queue as the screens see it: one object per change, so React can compare snapshots. */
export interface OutboxSnapshot {
  readonly records: readonly OutboxRecord[];
  readonly summary: OutboxSummary;
  readonly state: SyncState;
}

/** The triggers, injected so tests drive them instead of waiting for real time. */
export interface SyncSchedule {
  /** Runs `run` every `ms` until the returned function is called. */
  every(ms: number, run: () => void): () => void;
  /** Runs `run` once after `ms`, unless the returned function is called first. */
  after(ms: number, run: () => void): () => void;
  /** Calls `run` whenever the device comes back online. */
  onOnline(run: () => void): () => void;
}

export interface OutboxRuntimeDeps {
  readonly outbox: Outbox;
  /** The same storage the outbox writes through; the registration lives in it, beside the records. */
  readonly storage: OutboxStorage;
  readonly schedule: SyncSchedule;
  readonly clock: Clock;
}

/** What the screens see before the queue has been read. */
export const EMPTY_SNAPSHOT: OutboxSnapshot = {
  records: [],
  summary: { pending: 0, conflicts: 0, lastAckAt: null },
  state: { kind: 'idle' },
};

/** The browser's own timers and `online` event. */
export function browserSchedule(): SyncSchedule {
  return {
    every(ms, run) {
      const timer = setInterval(run, ms);
      return () => clearInterval(timer);
    },
    after(ms, run) {
      const timer = setTimeout(run, ms);
      return () => clearTimeout(timer);
    },
    onOnline(run) {
      globalThis.addEventListener?.('online', run);
      return () => globalThis.removeEventListener?.('online', run);
    },
  };
}

/**
 * Where this device keeps its queue: IndexedDB for a backend with a server behind it, memory for
 * the demo, whose data starts empty on every reload anyway.
 */
export async function createOutboxStorage(kind: Backend['kind']): Promise<OutboxStorage> {
  if (kind === 'memory') {
    return createMemoryOutboxStorage();
  }
  return createIdbOutboxStorage(await openOutboxDatabase());
}

/** The outbox of this device: records go out through the ports, one tab of a terminal at a time. */
export function createBackendOutbox(options: {
  readonly backend: Pick<Backend, 'sales' | 'sessions'>;
  readonly storage: OutboxStorage;
  readonly clock: Clock;
  readonly canSend: () => boolean;
}): Outbox {
  return createOutbox({
    storage: options.storage,
    transport: createPortTransport(options.backend),
    clock: options.clock,
    random: () => Math.random(),
    lock: createWebLocksDrainLock(),
    canSend: options.canSend,
  });
}

function stateKey(state: SyncState): string {
  switch (state.kind) {
    case 'waiting':
      return `waiting:${state.retryAt}`;
    case 'blocked':
      return `blocked:${state.recordId}`;
    case 'paused':
      return `paused:${state.reason}`;
    case 'failed':
      return `failed:${state.error.code}:${state.error.message}`;
    default:
      return state.kind;
  }
}

/** Every field a screen reads off a record; a payload never changes once it is written. */
function sameRecord(a: OutboxRecord, b: OutboxRecord): boolean {
  return (
    a.id === b.id &&
    a.status === b.status &&
    a.attempts === b.attempts &&
    a.nextAttemptAt === b.nextAttemptAt &&
    a.ackedAt === b.ackedAt &&
    (a.lastError?.code ?? null) === (b.lastError?.code ?? null) &&
    (a.result?.status ?? null) === (b.result?.status ?? null)
  );
}

function sameSnapshot(a: OutboxSnapshot, b: OutboxSnapshot): boolean {
  return (
    stateKey(a.state) === stateKey(b.state) &&
    a.summary.pending === b.summary.pending &&
    a.summary.conflicts === b.summary.conflicts &&
    a.summary.lastAckAt === b.summary.lastAckAt &&
    a.records.length === b.records.length &&
    a.records.every((record, index) => sameRecord(record, b.records[index]))
  );
}

/**
 * The queue of this device with its triggers: app start, the `online` event, every 30 s, every
 * change made through the outbox — an append, a retry, a void — and a timer for the earliest retry.
 * A pass runs under the Web Lock of the terminal, so several tabs of one register send each record
 * once. Screens read `snapshot()`; nothing they do ever waits for a pass.
 */
export function createOutboxRuntime(deps: OutboxRuntimeDeps) {
  const listeners = new Set<() => void>();
  let snapshot: OutboxSnapshot = EMPTY_SNAPSHOT;
  let state: SyncState = EMPTY_SNAPSHOT.state;
  let sending: Promise<void> | null = null;
  let sendAgain = false;
  let reading: Promise<void> | null = null;
  let readAgain = false;
  let cancelRetry: (() => void) | null = null;
  let stops: (() => void)[] = [];

  function publish(next: OutboxSnapshot): void {
    if (sameSnapshot(snapshot, next)) {
      return;
    }
    snapshot = next;
    for (const listener of listeners) {
      listener();
    }
  }

  function setState(next: SyncState): void {
    state = next;
    publish({ ...snapshot, state: next });
  }

  function failed(error: unknown, what: string): void {
    const appError = toAppError(error);
    console.error(what, appError);
    setState({
      kind: 'failed',
      error: { code: appError.code, message: appError.message, details: appError.details },
    });
  }

  async function readQueue(): Promise<void> {
    const [records, summary] = await Promise.all([deps.outbox.list(), deps.outbox.summary()]);
    publish({ records, summary, state });
  }

  /** Reads the queue back. Calls that overlap collapse into one more read after the running one. */
  function refresh(): Promise<void> {
    if (reading) {
      readAgain = true;
      return reading;
    }
    reading = (async () => {
      try {
        do {
          readAgain = false;
          await readQueue();
        } while (readAgain);
      } catch (error) {
        failed(error, 'The queue on this device could not be read');
      } finally {
        reading = null;
        readAgain = false;
      }
    })();
    return reading;
  }

  function applyOutcome(outcome: DrainOutcome): void {
    cancelRetry?.();
    cancelRetry = null;
    switch (outcome.state) {
      case 'idle':
        setState({ kind: 'idle' });
        return;
      case 'busy':
        // Another tab is draining this terminal; what it sends shows up on the next pass here.
        setState({ kind: 'busy' });
        return;
      case 'blocked':
        setState({ kind: 'blocked', recordId: outcome.recordId });
        return;
      case 'paused':
        setState({ kind: 'paused', reason: outcome.reason });
        return;
      case 'waiting':
        setState({ kind: 'waiting', retryAt: outcome.retryAt });
        cancelRetry = deps.schedule.after(Math.max(outcome.retryAt - deps.clock.now(), 0), () => {
          cancelRetry = null;
          void sync();
        });
        return;
    }
  }

  /**
   * A drain pass and the timer for whatever it ends up waiting on. One pass at a time per tab: a
   * trigger that arrives during a pass runs another one after it, because a record appended while
   * the pass was ending would otherwise wait for the next trigger.
   */
  function sync(): Promise<void> {
    if (sending) {
      sendAgain = true;
      return sending;
    }
    sending = (async () => {
      try {
        do {
          sendAgain = false;
          setState({ kind: 'sending' });
          applyOutcome(await deps.outbox.drain());
          await refresh();
        } while (sendAgain);
      } catch (error) {
        failed(error, 'The queue on this device could not be sent');
      } finally {
        sending = null;
        sendAgain = false;
      }
    })();
    return sending;
  }

  return {
    /** The queue itself: a screen appends to it and reads a record back at once. */
    outbox: deps.outbox,

    /** Where the records and this device's registration are kept. */
    storage: deps.storage,

    /**
     * Asks for a pass without waiting for it: nothing on a screen waits for the server. Like every
     * function here it is a plain value, so a screen can take it apart from the handle.
     */
    drain: (): void => {
      void sync();
    },

    snapshot: (): OutboxSnapshot => snapshot,

    subscribe: (listener: () => void): (() => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    /** Starts the triggers and drains once. Calling it again while started changes nothing. */
    start: (): void => {
      if (stops.length > 0) {
        return;
      }
      stops = [
        // Every change the outbox makes or is told about: an append, a retry, a resolved void.
        deps.outbox.subscribe(() => {
          void refresh();
          void sync();
        }),
        deps.schedule.every(DRAIN_INTERVAL_MS, () => void sync()),
        deps.schedule.onOnline(() => {
          // A record that failed while the connection was down may be waiting out a backoff of up
          // to a minute. The connection is back, so bring those waits forward and send at once.
          void (async () => {
            try {
              await deps.outbox.wakeNow();
            } catch (error) {
              failed(error, 'The queue on this device could not be woken');
            }
            await sync();
          })();
        }),
      ];
      void refresh();
      void sync();
    },

    stop: (): void => {
      cancelRetry?.();
      cancelRetry = null;
      for (const cancel of stops) {
        cancel();
      }
      stops = [];
    },

    /** A pass to wait for: on sign-in, on a token refresh, and in tests. */
    sync,

    /** Reads the queue back from storage, for a change another context made. */
    refresh,
  };
}

export type OutboxRuntime = ReturnType<typeof createOutboxRuntime>;

/** Opens this device's queue for the running backend and starts draining it. */
export async function startOutboxRuntime(options: {
  readonly backend: Backend;
  readonly canSend: () => boolean;
  readonly schedule?: SyncSchedule;
  readonly clock?: Clock;
}): Promise<OutboxRuntime> {
  const clock = options.clock ?? { now: () => Date.now() };
  const storage = await createOutboxStorage(options.backend.kind);
  const outbox = createBackendOutbox({
    backend: options.backend,
    storage,
    clock,
    canSend: options.canSend,
  });
  const runtime = createOutboxRuntime({
    outbox,
    storage,
    schedule: options.schedule ?? browserSchedule(),
    clock,
  });
  runtime.start();
  return runtime;
}

/**
 * The catalog cache as idb-keyval reads and writes it. Null where there is no IndexedDB: the app
 * still runs, it just reads the catalog from the server every time, so it needs one.
 */
export function catalogCacheStorage(): AsyncKeyValueStorage | null {
  if (!globalThis.indexedDB) {
    return null;
  }
  // createStore opens the database, so it is called here rather than when this module loads.
  const store = createStore(CATALOG_CACHE_DB, CATALOG_CACHE_STORE);
  return {
    getItem: async (key) => (await get<string>(key, store)) ?? null,
    setItem: (key, value) => set(key, value, store),
    removeItem: (key) => del(key, store),
  };
}

function localStorageOrNull(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch (error) {
    console.error('Local storage is unavailable', error);
    return null;
  }
}

/**
 * Everything this device kept locally, dropped: the queue, the cached catalog and the two keys
 * Phase 3 wrote. The demo backend starts empty on every reload, so the device state has to go with
 * it — otherwise records of a shop that no longer exists are replayed into a new one.
 */
export async function clearOfflineState(): Promise<void> {
  const storage = localStorageOrNull();
  for (const key of LEGACY_STORAGE_KEYS) {
    storage?.removeItem(key);
  }
  if (!globalThis.indexedDB) {
    // No IndexedDB here (a private window, or a test): there is nothing stored to drop.
    return;
  }
  await deleteOutboxDatabase();
  // Cleared rather than deleted: a tab of the demo next door holds this database open.
  await clear(createStore(CATALOG_CACHE_DB, CATALOG_CACHE_STORE));
}
