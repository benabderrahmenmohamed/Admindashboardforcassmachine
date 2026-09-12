import { useEffect, useSyncExternalStore, type ReactNode } from 'react';
import { FullPageLoading } from '@/components/feedback';
import { useAuth } from '@/features/auth/hooks/useAuth';
import type { AuthViewState } from '@/features/auth/types';
import type { CacheOwner, QueryPersistence } from './queryPersistence';

function ownerOf(state: AuthViewState): CacheOwner | undefined {
  switch (state.status) {
    case 'loading':
      return undefined;
    case 'anonymous':
      return null;
    default:
      return state.user.id;
  }
}

/**
 * Hands the query cache, and its copy on the device, to whoever is signed in, and draws nothing of
 * the app while it changes hands.
 *
 * AuthProvider clears the cache too, but only in an effect, after the screens of the new user have
 * rendered once: in that render they read the cache of the previous one. So when the signed-in user
 * differs from the one the cache was handed to, this renders a loader in place of `children`, hands
 * the cache over in its effect, and only then lets the screens render against a cache that is theirs.
 */
export function PersistedCacheGate({
  persistence,
  children,
}: {
  readonly persistence: QueryPersistence;
  readonly children: ReactNode;
}) {
  const { state } = useAuth();
  const signedIn = ownerOf(state);
  const holder = useSyncExternalStore(persistence.subscribe, persistence.owner);

  useEffect(() => {
    if (signedIn !== undefined) {
      void persistence.setOwner(signedIn);
    }
  }, [persistence, signedIn]);

  if (signedIn !== holder) {
    return <FullPageLoading />;
  }
  return <>{children}</>;
}
