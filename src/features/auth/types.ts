import type { AuthState, AuthUser, Credentials } from '@/ports';

export type AuthViewState = { readonly status: 'loading' } | AuthState;

export interface AuthContextValue {
  readonly state: AuthViewState;
  readonly signIn: (credentials: Credentials) => Promise<AuthUser>;
  readonly signOut: () => Promise<void>;
}
