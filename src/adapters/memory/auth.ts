import { AppError } from '@/lib/errors';
import { credentialsSchema, type AuthPort, type AuthState, type AuthUser } from '@/ports';
import type { MemorySession, MemoryStore } from './store';
import { parseInput, perform, type MemoryContext } from './support';

/**
 * Sign-in against the seed accounts. The session lives only in the store, where the other ports
 * check it, so a reload signs everyone out; there is no network, so the state is never `offline`.
 */
export function createMemoryAuth(context: MemoryContext, store: MemoryStore): AuthPort {
  // One entry per subscription, so subscribing the same function twice needs two unsubscribes.
  const subscriptions = new Set<{ readonly listener: (state: AuthState) => void }>();

  function change(next: MemorySession): void {
    store.session = next;
    for (const subscription of [...subscriptions]) {
      try {
        subscription.listener(structuredClone(next));
      } catch (error) {
        // One broken listener must not stop the others or fail the sign-in that triggered it.
        console.error('An auth state listener threw', error);
      }
    }
  }

  return {
    getState: () => perform(context, 'auth.getState', () => structuredClone(store.session)),

    signIn: (credentials) =>
      perform(context, 'auth.signIn', () => {
        const { email, password } = parseInput(credentialsSchema, credentials);
        const account = store.accounts.find(
          (candidate) =>
            candidate.email.toLowerCase() === email.toLowerCase() &&
            candidate.password === password,
        );
        if (!account) {
          throw new AppError('UNAUTHENTICATED', 'Invalid login credentials');
        }
        const user: AuthUser = {
          id: account.id,
          email: account.email,
          name: account.name,
          role: account.role,
        };
        change({ status: 'authenticated', user });
        return structuredClone(user);
      }),

    signOut: () =>
      perform(context, 'auth.signOut', () => {
        change({ status: 'anonymous' });
      }),

    onStateChange(listener) {
      const subscription = { listener };
      subscriptions.add(subscription);
      return () => {
        subscriptions.delete(subscription);
      };
    },
  };
}
