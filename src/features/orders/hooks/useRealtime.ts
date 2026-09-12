import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { useCurrentUser } from '@/features/auth/hooks/useAuth';
import { useBackend } from '@/lib/backend-context';
import { affectedQueryKeys } from '../realtimeKeys';

/**
 * Keeps this screen in step with the other devices of the shop.
 *
 * Every screen that shows a table grid or a ticket list calls it. The event says only what kind of
 * thing changed, so the answer is always the same: mark the queries that cover it stale and let
 * TanStack Query re-read the ones actually on screen. A backend with nothing behind it never calls
 * the listener, and the screen still works from its own reads — which is why no screen waits for it.
 */
export function useRealtimeRefresh(): void {
  // Kept whole rather than destructured: `subscribe` is a port method.
  const backend = useBackend();
  const queryClient = useQueryClient();
  const user = useCurrentUser();
  const shopId = user.shopId;

  useEffect(() => {
    return backend.realtime.subscribe(shopId, (topic) => {
      for (const queryKey of affectedQueryKeys(topic)) {
        void queryClient.invalidateQueries({ queryKey });
      }
    });
  }, [backend, queryClient, shopId]);
}
