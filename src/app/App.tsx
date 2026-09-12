import { createAsyncStoragePersister } from '@tanstack/query-async-storage-persister';
import type { Query } from '@tanstack/react-query';
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client';
import { useEffect, useState } from 'react';
import { RouterProvider } from 'react-router';
import { Toaster } from '@/components/ui/sonner';
import { AuthProvider } from '@/features/auth/components/AuthProvider';
import { OutboxProvider } from '@/features/sync/components/OutboxProvider';
import {
  APP_VERSION,
  catalogCacheStorage,
  CATALOG_CACHE_KEY,
  CATALOG_MAX_AGE_MS,
} from '@/features/sync/runtime';
import { BackendProvider } from '@/lib/backend-context';
import { createQueryClient, queryKeys } from '@/lib/query';
import type { Backend } from '@/ports';
import { router } from '@/routes/router';

/**
 * The only queries kept on the device: the register renders its products, categories and shop
 * settings from them while offline. Sales, sessions and the terminal are never cached — they belong
 * to the outbox and to the server, and a stale copy of them would be read as fact.
 */
const CATALOG_KEYS: readonly string[] = [
  queryKeys.products[0],
  queryKeys.categories[0],
  queryKeys.settings[0],
];

function isCatalogQuery(query: Query): boolean {
  const [head] = query.queryKey;
  return typeof head === 'string' && CATALOG_KEYS.includes(head);
}

function catalogPersistOptions() {
  return {
    persister: createAsyncStoragePersister({
      // Without IndexedDB nothing is kept; the app runs and reads the catalog from the server.
      storage: catalogCacheStorage(),
      key: CATALOG_CACHE_KEY,
    }),
    maxAge: CATALOG_MAX_AGE_MS,
    // A release that changes what a query holds must not read what the one before it wrote.
    buster: APP_VERSION,
    dehydrateOptions: {
      shouldDehydrateQuery: (query: Query) =>
        query.state.status === 'success' && isCatalogQuery(query),
      // Queries only. A mutation that started while the device was offline is paused, and a paused
      // mutation is kept by default — which would write a registration or a void, arguments and all,
      // into the same store, and hand it to a reload that has no way to finish it.
      shouldDehydrateMutation: () => false,
    },
  };
}

/** The app shell, precached so /pos boots with no network. Only a built app has one. */
function useServiceWorker(): void {
  useEffect(() => {
    if (!import.meta.env.PROD || !('serviceWorker' in navigator)) {
      return;
    }
    navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`).catch((error: unknown) => {
      console.error('The offline app shell could not be registered', error);
    });
  }, []);
}

export function App({ backend }: { backend: Backend }) {
  const [queryClient] = useState(createQueryClient);
  const [persistOptions] = useState(catalogPersistOptions);
  useServiceWorker();

  return (
    <BackendProvider backend={backend}>
      <PersistQueryClientProvider client={queryClient} persistOptions={persistOptions}>
        <AuthProvider>
          <OutboxProvider>
            <RouterProvider router={router} />
            <Toaster position="top-right" />
          </OutboxProvider>
        </AuthProvider>
      </PersistQueryClientProvider>
    </BackendProvider>
  );
}
