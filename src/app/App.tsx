import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client';
import { useState } from 'react';
import { RouterProvider } from 'react-router';
import { Toaster } from '@/components/ui/sonner';
import { AuthProvider } from '@/features/auth/components/AuthProvider';
import { OutboxProvider } from '@/features/sync/components/OutboxProvider';
import { catalogCacheStorage } from '@/features/sync/runtime';
import { BackendProvider } from '@/lib/backend-context';
import { createQueryClient } from '@/lib/query';
import type { Backend } from '@/ports';
import { router } from '@/routes/router';
import { PersistedCacheGate } from './PersistedCacheGate';
import { createQueryPersistence } from './queryPersistence';

/**
 * The offline app shell is registered by src/app/registerServiceWorker.ts, which index.html loads
 * on its own: nothing here may import it, or a test that renders the app would need the Vite build.
 */
export function App({ backend }: { backend: Backend }) {
  const [queryClient] = useState(createQueryClient);
  // Without IndexedDB nothing is kept; the app runs and reads everything from the server.
  const [persistence] = useState(() =>
    createQueryPersistence({ queryClient, storage: catalogCacheStorage() }),
  );

  return (
    <BackendProvider backend={backend}>
      <PersistQueryClientProvider client={queryClient} persistOptions={persistence.options}>
        <AuthProvider>
          <OutboxProvider>
            {/* Inside the outbox, so a change of user never stops the queue: only the screens wait. */}
            <PersistedCacheGate persistence={persistence}>
              <RouterProvider router={router} />
            </PersistedCacheGate>
            <Toaster position="top-right" />
          </OutboxProvider>
        </AuthProvider>
      </PersistQueryClientProvider>
    </BackendProvider>
  );
}
