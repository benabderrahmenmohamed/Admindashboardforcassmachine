import { AppError } from '@/lib/errors';
import { credentialsSchema, type AuthPort, type AuthState, type AuthUser } from '@/ports';
import { parseInput, perform, type MemoryContext, type MemorySession } from './support';

/**
 * Sign-in against the seed accounts. Roles and shop come from the account's profile, as my_profile()
 * gives them; an account without one is FORBIDDEN. The session lives only in this client, where
 * the other ports check it, so a reload signs everyone out; there is no network, so the state is
 * never `offline`.
 */
export function createMemoryAuth(context: MemoryContext): AuthPort {
  const { store, client } = context;
  // One entry per subscription, so subscribing the same function twice needs two unsubscribes.
  const subscriptions = new Set<{ readonly listener: (state: AuthState) => void }>();

  function change(next: MemorySession): void {
    client.session = next;
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
    getState: () => perform(context, 'auth.getState', () => structuredClone(client.session)),

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
        const profile = store.profiles.get(account.id);
        if (!profile) {
          // The password was right, so it replaced any session here, and this account may not keep one.
          if (client.session.status !== 'anonymous') {
            change({ status: 'anonymous' });
          }
          throw new AppError('FORBIDDEN', 'This account is not a member of any shop.');
        }
        const user: AuthUser = {
          id: account.id,
          email: account.email,
          name: profile.displayName,
          roles: [...profile.roles],
          shopId: profile.shopId,
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
