import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useBackend } from '@/lib/backend-context';
import { toAppError } from '@/lib/errors';
import { AuthContext } from '../authContext';
import type { AuthContextValue, AuthViewState } from '../types';

export function AuthProvider({ children }: { children: ReactNode }) {
  const { auth } = useBackend();
  const queryClient = useQueryClient();
  const [state, setState] = useState<AuthViewState>({ status: 'loading' });

  useEffect(() => {
    let active = true;
    const unsubscribe = auth.onStateChange((next) => {
      if (active) {
        setState(next);
      }
    });
    auth.getState().then(
      (initial) => {
        // A change event that arrived first is newer than the startup read.
        if (active) {
          setState((current) => (current.status === 'loading' ? initial : current));
        }
      },
      (error: unknown) => {
        console.error('Could not restore the session', toAppError(error));
        if (active) {
          setState({ status: 'anonymous' });
        }
      },
    );
    return () => {
      active = false;
      unsubscribe();
    };
  }, [auth]);

  // Cached queries and mutations belong to the user they ran for. Clear them whenever that user
  // changes, however it happened: a sign-out here or in another tab, an expired session, or a
  // sign-in as someone else.
  const userId =
    state.status === 'authenticated' || state.status === 'offline' ? state.user.id : null;
  const cachedFor = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (state.status === 'loading') {
      return;
    }
    if (cachedFor.current !== undefined && cachedFor.current !== userId) {
      queryClient.clear();
    }
    cachedFor.current = userId;
  }, [queryClient, state.status, userId]);

  const value = useMemo<AuthContextValue>(
    () => ({
      state,
      signIn: async (credentials) => {
        const user = await auth.signIn(credentials);
        setState({ status: 'authenticated', user });
        return user;
      },
      signOut: async () => {
        await auth.signOut();
        setState({ status: 'anonymous' });
      },
    }),
    [auth, state],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
