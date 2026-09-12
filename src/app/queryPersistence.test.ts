import {
  dehydrate,
  MutationObserver,
  onlineManager,
  QueryClient,
  type QueryKey,
} from '@tanstack/react-query';
import {
  persistQueryClientRestore,
  persistQueryClientSave,
  persistQueryClientSubscribe,
} from '@tanstack/react-query-persist-client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  APP_VERSION,
  CATALOG_CACHE_KEY,
  CATALOG_MAX_AGE_MS,
  type AsyncKeyValueStorage,
} from '@/features/sync/runtime';
import { AppError } from '@/lib/errors';
import { queryKeys } from '@/lib/query';
import { createQueryPersistence, type QueryPersistence } from './queryPersistence';

const BOARD = [{ tableId: 'table-1', name: 'Table 1', state: 'unsent' }];
const TABLES = [{ id: 'table-1', name: 'Table 1' }];
const ORDER = { id: 'order-1', tableId: 'table-1', items: [{ name: 'Café direct', qty: 2 }] };
const MENU = [{ id: 'p-direct', name: 'Café direct' }];
const TICKETS = [{ tableId: 'table-1', items: [{ name: 'Café direct', qty: 2 }] }];

/** Waiting this long lets every write the persister held back go through. */
const PAST_THE_THROTTLE_MS = 5_000;

/** IndexedDB as the persister sees it: a value read or written when the call is made. */
function deviceStorage() {
  const items = new Map<string, string>();
  const storage: AsyncKeyValueStorage = {
    getItem: (key) => Promise.resolve(items.get(key) ?? null),
    setItem: (key, value) => {
      items.set(key, value);
      return Promise.resolve();
    },
    removeItem: (key) => {
      items.delete(key);
      return Promise.resolve();
    },
  };
  return { items, storage };
}

const copySchema = z.object({
  owner: z.string(),
  client: z.object({
    clientState: z.object({ queries: z.array(z.object({ queryKey: z.array(z.unknown()) })) }),
  }),
});

/** The copy on the device, as whose it is and which queries it holds; null when there is none. */
function storedCopy(items: Map<string, string>): { owner: string; keys: QueryKey[] } | null {
  const raw = items.get(CATALOG_CACHE_KEY);
  if (raw === undefined) {
    return null;
  }
  const copy = copySchema.parse(JSON.parse(raw));
  return {
    owner: copy.owner,
    keys: copy.client.clientState.queries.map((query) => query.queryKey),
  };
}

function keptKeys(client: QueryClient, persistence: QueryPersistence): QueryKey[] {
  return dehydrate(client, persistence.options.dehydrateOptions).queries.map(
    (query) => query.queryKey,
  );
}

/** What a device that `owner` used leaves on `storage`: the board and one table's open order. */
async function leaveCopy(storage: AsyncKeyValueStorage, owner: string): Promise<void> {
  const client = new QueryClient();
  const persistence = createQueryPersistence({ queryClient: client, storage });
  await persistence.setOwner(owner);
  client.setQueryData(queryKeys.board, BOARD);
  client.setQueryData(queryKeys.openOrder('table-1'), ORDER);
  await persistQueryClientSave({ queryClient: client, ...persistence.options });
}

/** The same device after a reload: a new cache over the same disk, reading back as it starts. */
function reload(storage: AsyncKeyValueStorage) {
  const client = new QueryClient();
  const persistence = createQueryPersistence({ queryClient: client, storage });
  const restored = persistQueryClientRestore({ queryClient: client, ...persistence.options });
  return { client, persistence, restored };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('what a device keeps', () => {
  it('keeps the menu, the shop settings and the room, down to every table it opened', () => {
    const client = new QueryClient();
    const persistence = createQueryPersistence({ queryClient: client, storage: null });
    const kept: QueryKey[] = [
      queryKeys.products,
      queryKeys.categories,
      queryKeys.settings,
      queryKeys.tableList,
      queryKeys.board,
      queryKeys.openOrder('table-1'),
      queryKeys.openOrder('table-2'),
      queryKeys.kitchenTickets,
    ];
    for (const key of kept) {
      client.setQueryData(key, { of: key });
    }

    expect(keptKeys(client, persistence)).toEqual(kept);
  });

  it('leaves out sales, sessions, the Z-report, the removed-after-sent report and the terminal', () => {
    const client = new QueryClient();
    const persistence = createQueryPersistence({ queryClient: client, storage: null });
    const leftOut: QueryKey[] = [
      queryKeys.salesList({}),
      queryKeys.salesList({ sessionId: 'session-1' }),
      queryKeys.sale('sale-1'),
      queryKeys.currentSession('terminal-1'),
      queryKeys.zReport('session-1'),
      queryKeys.removedAfterSent({
        from: '2026-09-01T00:00:00.000Z',
        to: '2026-09-12T23:59:59.999Z',
      }),
      // useDeviceTerminal's registration and receipt counter, which only the outbox storage holds.
      ['terminal', 'registration'],
      // A query that does not exist yet under a kept root stays off the disk until it is named.
      ['tables', 'history'],
    ];
    for (const key of leftOut) {
      client.setQueryData(key, { of: key });
    }

    expect(keptKeys(client, persistence)).toEqual([]);
  });

  it('keeps a query only once it holds data', async () => {
    const client = new QueryClient();
    const persistence = createQueryPersistence({ queryClient: client, storage: null });

    client.getQueryCache().build(client, { queryKey: queryKeys.board });
    await client.prefetchQuery({
      queryKey: queryKeys.tableList,
      queryFn: () =>
        Promise.reject(new AppError('NETWORK_ERROR', 'The server could not be reached.')),
      retry: false,
    });
    // useOpenOrder with no table chosen.
    client.setQueryData(queryKeys.openOrder(''), null);

    expect(client.getQueryState(queryKeys.tableList)?.status).toBe('error');
    expect(keptKeys(client, persistence)).toEqual([]);
  });

  it('never keeps a mutation, not even one paused while the device is offline', async () => {
    const client = new QueryClient();
    const persistence = createQueryPersistence({ queryClient: client, storage: null });
    onlineManager.setOnline(false);
    try {
      const observer = new MutationObserver(client, { mutationFn: () => Promise.resolve('sent') });
      void observer.mutate();
      await vi.waitFor(() => {
        expect(client.getMutationCache().getAll()[0]?.state.isPaused).toBe(true);
      });

      expect(dehydrate(client, persistence.options.dehydrateOptions).mutations).toEqual([]);
      // TanStack's default would have written it.
      expect(dehydrate(client).mutations).toHaveLength(1);
    } finally {
      onlineManager.setOnline(true);
    }
  });

  it('holds a kept query in memory as long as its copy may be read back, not five minutes', () => {
    const client = new QueryClient();
    createQueryPersistence({ queryClient: client, storage: null });

    const gcTime = (key: QueryKey) => client.defaultQueryOptions({ queryKey: key }).gcTime;
    expect(gcTime(queryKeys.openOrder('table-7'))).toBe(CATALOG_MAX_AGE_MS);
    expect(gcTime(queryKeys.board)).toBe(CATALOG_MAX_AGE_MS);
    expect(gcTime(queryKeys.products)).toBe(CATALOG_MAX_AGE_MS);
    expect(gcTime(queryKeys.salesList({}))).toBeUndefined();
  });
});

describe('reading the copy back', () => {
  it('gives a reloaded device the room back, for the person who left it', async () => {
    const { items, storage } = deviceStorage();
    await leaveCopy(storage, 'waiter-1');
    expect(storedCopy(items)).toEqual({
      owner: 'waiter-1',
      keys: [queryKeys.board, queryKeys.openOrder('table-1')],
    });

    const device = reload(storage);
    await device.persistence.setOwner('waiter-1');
    await device.restored;

    expect(device.client.getQueryData(queryKeys.board)).toEqual(BOARD);
    expect(device.client.getQueryData(queryKeys.openOrder('table-1'))).toEqual(ORDER);
  });

  it('reads nothing back until it knows who is signed in', async () => {
    const { storage } = deviceStorage();
    await leaveCopy(storage, 'waiter-1');

    const device = reload(storage);
    let finished = false;
    void device.restored.then(() => {
      finished = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(finished).toBe(false);
    expect(device.client.getQueryCache().getAll()).toEqual([]);

    await device.persistence.setOwner('waiter-1');
    await device.restored;
    expect(device.client.getQueryData(queryKeys.board)).toEqual(BOARD);
  });

  it("never reads one account's copy back for another, and removes it", async () => {
    const { items, storage } = deviceStorage();
    await leaveCopy(storage, 'waiter-1');

    const device = reload(storage);
    await device.persistence.setOwner('cook-1');
    await device.restored;

    expect(device.client.getQueryCache().getAll()).toEqual([]);
    expect(items.has(CATALOG_CACHE_KEY)).toBe(false);
  });

  it('removes the copy when the device starts with nobody signed in', async () => {
    const { items, storage } = deviceStorage();
    await leaveCopy(storage, 'waiter-1');

    const device = reload(storage);
    await device.persistence.setOwner(null);
    await device.restored;

    expect(device.client.getQueryCache().getAll()).toEqual([]);
    expect(items.has(CATALOG_CACHE_KEY)).toBe(false);
  });

  it('removes a copy written before copies had an owner', async () => {
    const { items, storage } = deviceStorage();
    const previous = new QueryClient();
    previous.setQueryData(queryKeys.board, BOARD);
    items.set(
      CATALOG_CACHE_KEY,
      JSON.stringify({
        timestamp: Date.now(),
        buster: APP_VERSION,
        clientState: dehydrate(previous),
      }),
    );

    const device = reload(storage);
    await device.persistence.setOwner('waiter-1');
    await device.restored;

    expect(device.client.getQueryCache().getAll()).toEqual([]);
    expect(items.has(CATALOG_CACHE_KEY)).toBe(false);
  });

  it('does not fill the cache back in when the user signs out while the copy is being read', async () => {
    const { items, storage } = deviceStorage();
    await leaveCopy(storage, 'waiter-1');
    let release = (): void => undefined;
    let reading = false;
    // IndexedDB answers a read with what was there when it was asked, however late the answer comes.
    const slow: AsyncKeyValueStorage = {
      ...storage,
      getItem: (key) => {
        const value = items.get(key) ?? null;
        reading = true;
        return new Promise((resolve) => {
          release = () => resolve(value);
        });
      },
    };

    const device = reload(slow);
    void device.persistence.setOwner('waiter-1');
    await vi.waitFor(() => {
      expect(reading).toBe(true);
    });
    await device.persistence.setOwner(null);
    release();
    await device.restored;

    expect(device.client.getQueryCache().getAll()).toEqual([]);
    expect(items.has(CATALOG_CACHE_KEY)).toBe(false);
  });
});

describe('signing out', () => {
  it('empties the cache and the device, and a write held back from before never lands', async () => {
    vi.useFakeTimers();
    const { items, storage } = deviceStorage();
    const client = new QueryClient();
    const persistence = createQueryPersistence({ queryClient: client, storage });
    await persistence.setOwner('waiter-1');
    const stop = persistQueryClientSubscribe({ queryClient: client, ...persistence.options });

    client.setQueryData(queryKeys.board, BOARD);
    await vi.advanceTimersByTimeAsync(PAST_THE_THROTTLE_MS);
    expect(storedCopy(items)).toEqual({ owner: 'waiter-1', keys: [queryKeys.board] });

    // The persister writes this change in two goes, the second a second later; the waiter signs
    // out before either reaches the disk.
    client.setQueryData(queryKeys.tableList, TABLES);
    await persistence.setOwner(null);

    expect(client.getQueryCache().getAll()).toEqual([]);
    expect(items.has(CATALOG_CACHE_KEY)).toBe(false);

    await vi.advanceTimersByTimeAsync(PAST_THE_THROTTLE_MS);
    expect(items.has(CATALOG_CACHE_KEY)).toBe(false);

    // With nobody signed in, nothing is written at all.
    client.setQueryData(queryKeys.products, MENU);
    await vi.advanceTimersByTimeAsync(PAST_THE_THROTTLE_MS);
    expect(items.has(CATALOG_CACHE_KEY)).toBe(false);
    stop();
  });

  it("hands the device to the next account without any of the first one's cache", async () => {
    vi.useFakeTimers();
    const { items, storage } = deviceStorage();
    const client = new QueryClient();
    const persistence = createQueryPersistence({ queryClient: client, storage });
    await persistence.setOwner('waiter-1');
    const stop = persistQueryClientSubscribe({ queryClient: client, ...persistence.options });
    client.setQueryData(queryKeys.board, BOARD);
    await vi.advanceTimersByTimeAsync(PAST_THE_THROTTLE_MS);

    client.setQueryData(queryKeys.openOrder('table-1'), ORDER);
    await persistence.setOwner('cook-1');

    expect(client.getQueryCache().getAll()).toEqual([]);
    expect(items.has(CATALOG_CACHE_KEY)).toBe(false);

    client.setQueryData(queryKeys.kitchenTickets, TICKETS);
    await vi.advanceTimersByTimeAsync(PAST_THE_THROTTLE_MS);
    expect(storedCopy(items)).toEqual({ owner: 'cook-1', keys: [queryKeys.kitchenTickets] });
    stop();
  });

  it('tells its listeners each time the cache changes hands', async () => {
    const client = new QueryClient();
    const persistence = createQueryPersistence({ queryClient: client, storage: null });
    const owners: (string | null | undefined)[] = [];
    persistence.subscribe(() => owners.push(persistence.owner()));

    expect(persistence.owner()).toBeUndefined();
    await persistence.setOwner('waiter-1');
    await persistence.setOwner('waiter-1');
    await persistence.setOwner(null);

    expect(owners).toEqual(['waiter-1', null]);
  });
});
