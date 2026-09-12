/**
 * What this device keeps of the query cache across a reload, and for whom.
 *
 * A phone that reloads with no network has to open on the menu and the room it was working in, so
 * those queries are written to IndexedDB and read back at start. The copy belongs to the person who
 * was signed in when it was written: it is read back for them only, and it leaves the device, memory
 * and disk alike, as soon as they sign out or someone else signs in. Two people share a café tablet,
 * and one account's room must never be drawn for the next one.
 */
import { createAsyncStoragePersister } from '@tanstack/query-async-storage-persister';
import type { DehydratedState, Query, QueryClient, QueryKey } from '@tanstack/react-query';
import type {
  PersistedClient,
  Persister,
  PersistQueryClientProviderProps,
} from '@tanstack/react-query-persist-client';
import { z } from 'zod';
import {
  APP_VERSION,
  CATALOG_CACHE_KEY,
  CATALOG_MAX_AGE_MS,
  type AsyncKeyValueStorage,
} from '@/features/sync/runtime';
import { toAppError } from '@/lib/errors';
import { queryKeys } from '@/lib/query';

/**
 * The queries a device keeps: the menu and the shop (products, categories, settings) and the room
 * (the table list, the board, the kitchen's tickets, and the open order of every table this device
 * has opened, below). Keys are matched whole rather than by prefix, so a query added later under one
 * of these roots stays off the disk until someone decides it belongs there.
 *
 * Left out on purpose:
 * - Sales, the current session and the Z-report. They belong to the outbox and to the server, and a
 *   copy read back after a reload would be taken for what the ledger says now: a session shown open
 *   that the counter has since closed, a sales list without what another terminal rang up.
 * - The removed-after-sent report. It names waiters one by one, and has no place on the disk of a
 *   device the staff share.
 * - This device's terminal registration. Its receipt counter comes from the outbox storage and
 *   nowhere else; a second copy read back from here could hand out a receipt number twice.
 */
const KEPT_QUERY_KEYS: readonly QueryKey[] = [
  queryKeys.products,
  queryKeys.categories,
  queryKeys.settings,
  queryKeys.tableList,
  queryKeys.board,
  queryKeys.kitchenTickets,
];

const [OPEN_ORDER_ROOT, OPEN_ORDER_KIND] = queryKeys.openOrder('');

/** `queryKeys.openOrder(tableId)` for a real table. With no table chosen the query never runs. */
function isOpenOrderKey(key: QueryKey): boolean {
  const [root, kind, tableId] = key;
  return (
    key.length === 3 &&
    root === OPEN_ORDER_ROOT &&
    kind === OPEN_ORDER_KIND &&
    typeof tableId === 'string' &&
    tableId !== ''
  );
}

function sameKey(a: QueryKey, b: QueryKey): boolean {
  return a.length === b.length && a.every((part, index) => part === b[index]);
}

/** Whether a query with this key is written to the device once it has data. */
export function isKeptQueryKey(key: QueryKey): boolean {
  return isOpenOrderKey(key) || KEPT_QUERY_KEYS.some((kept) => sameKey(kept, key));
}

function isDehydratedState(value: unknown): value is DehydratedState {
  return (
    typeof value === 'object' &&
    value !== null &&
    'queries' in value &&
    Array.isArray(value.queries) &&
    'mutations' in value &&
    Array.isArray(value.mutations)
  );
}

/** The copy on the device: whose it is, and the client TanStack wrote. */
const storedCacheSchema = z.object({
  owner: z.string().min(1),
  client: z.object({
    timestamp: z.number(),
    buster: z.string(),
    clientState: z.custom<DehydratedState>(isDehydratedState),
  }),
});
type StoredCache = z.infer<typeof storedCacheSchema>;

/** Whose the cache is: a signed-in user's id, or null while nobody is signed in. */
export type CacheOwner = string | null;

export interface QueryPersistence {
  /** For `PersistQueryClientProvider`. */
  readonly options: PersistQueryClientProviderProps['persistOptions'];
  /** Who the cache was last handed to; undefined until the auth state is first known. */
  readonly owner: () => CacheOwner | undefined;
  readonly subscribe: (listener: () => void) => () => void;
  /**
   * Hands the cache to `next`. The first call only says whose copy may be read back. Every later
   * change drops what the previous owner left, from memory at once and then from the device, before
   * anything is written for the next one. Resolves once the device copy is gone; never rejects.
   */
  readonly setOwner: (next: CacheOwner) => Promise<void>;
}

interface CacheWriter {
  readonly persist: Persister['persistClient'];
  /** Nothing reaches the device through this writer any more, not even a write it is holding back. */
  readonly close: () => void;
}

function openWriter(storage: AsyncKeyValueStorage, owner: string): CacheWriter {
  let open = true;
  const persister = createAsyncStoragePersister({
    key: CATALOG_CACHE_KEY,
    storage: {
      getItem: (key) => storage.getItem(key),
      // The persister holds a write back for up to a second after the change that caused it. If the
      // owner signs out in that second, the write would put their cache back on the device.
      setItem: (key, value) => (open ? storage.setItem(key, value) : Promise.resolve()),
      removeItem: (key) => storage.removeItem(key),
    },
    serialize: (client) => JSON.stringify({ owner, client } satisfies StoredCache),
    retry: ({ error }) => {
      console.error('The cache on this device could not be saved', toAppError(error));
      // Not retried: the next change to the cache writes a newer copy anyway.
      return undefined;
    },
  });
  return {
    persist: (client) => persister.persistClient(client),
    close: () => {
      open = false;
    },
  };
}

export function createQueryPersistence({
  queryClient,
  storage,
}: {
  readonly queryClient: QueryClient;
  /** Null where the browser has no IndexedDB: nothing is kept, and every query goes to the server. */
  readonly storage: AsyncKeyValueStorage | null;
}): QueryPersistence {
  // An unobserved query is dropped from memory after five minutes by default, and a dropped query is
  // missing from the next copy written. A table the waiter walked away from would be gone from the
  // device long before a reload needed it.
  for (const key of [...KEPT_QUERY_KEYS, [OPEN_ORDER_ROOT, OPEN_ORDER_KIND]]) {
    queryClient.setQueryDefaults(key, { gcTime: CATALOG_MAX_AGE_MS });
  }

  const listeners = new Set<() => void>();
  let owner: CacheOwner | undefined;
  let writer: CacheWriter | null = null;
  let ownerKnown: () => void = () => undefined;
  const firstOwner = new Promise<void>((resolve) => {
    ownerKnown = resolve;
  });

  function removeStored(): Promise<void> {
    if (!storage) {
      return Promise.resolve();
    }
    return storage.removeItem(CATALOG_CACHE_KEY).catch((error: unknown) => {
      // The copy keeps its owner's id, so it is still never read back for anyone else.
      console.error('A cache could not be removed from this device', toAppError(error));
    });
  }

  async function readBack(): Promise<PersistedClient | undefined> {
    if (!storage) {
      return undefined;
    }
    const raw = await storage.getItem(CATALOG_CACHE_KEY);
    if (raw === null) {
      return undefined;
    }
    const stored = storedCacheSchema.safeParse(JSON.parse(raw));
    // The owner is looked at now rather than when the read began: a sign-out in the meantime has
    // already emptied the cache, and must not see it filled again.
    if (stored.success && owner !== null && stored.data.owner === owner) {
      return stored.data.client;
    }
    // Someone else's copy, a copy with nobody signed in to claim it, or one written before copies
    // had an owner.
    await storage.removeItem(CATALOG_CACHE_KEY);
    return undefined;
  }

  const persister: Persister = {
    persistClient: (client) => writer?.persist(client),
    restoreClient: async () => {
      // Nothing is read back before the signed-in user is known, so a copy is only ever restored
      // into the cache of the person it belongs to.
      await firstOwner;
      try {
        return await readBack();
      } catch (error) {
        const failure = toAppError(error);
        console.error('The cache on this device could not be read back', failure);
        // TanStack then drops the stored copy, and the app starts from the server.
        throw failure;
      }
    },
    removeClient: removeStored,
  };

  function setOwner(next: CacheOwner): Promise<void> {
    if (next === owner) {
      return Promise.resolve();
    }
    const previous = owner;
    writer?.close();
    writer = null;
    let removed = Promise.resolve();
    if (previous !== undefined) {
      // What is in memory belongs to the previous owner. It is cleared while no writer is open, so
      // the snapshots the clear itself sets off are dropped rather than written.
      queryClient.clear();
      removed = removeStored();
    }
    owner = next;
    if (next !== null && storage) {
      writer = openWriter(storage, next);
    }
    if (previous === undefined) {
      ownerKnown();
    }
    for (const listener of [...listeners]) {
      listener();
    }
    return removed;
  }

  return {
    options: {
      persister,
      maxAge: CATALOG_MAX_AGE_MS,
      // A release that changes what a query holds must not read what the one before it wrote.
      buster: APP_VERSION,
      dehydrateOptions: {
        shouldDehydrateQuery: (query: Query) =>
          query.state.status === 'success' && isKeptQueryKey(query.queryKey),
        // Queries only. A mutation that started while the device was offline is paused, and a paused
        // mutation is kept by default — which would write a registration or a void, arguments and
        // all, into the same store, and hand it to a reload that has no way to finish it.
        shouldDehydrateMutation: () => false,
      },
    },
    owner: () => owner,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    setOwner,
  };
}
