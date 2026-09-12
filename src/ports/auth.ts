import { z } from 'zod';

/**
 * What a member may do. One person often holds several: the owner is an admin who also works the
 * counter, so `['admin', 'cashier']` is the ordinary case rather than an edge one.
 */
export const roleSchema = z.enum(['admin', 'cashier', 'waiter', 'kitchen']);
export type Role = z.infer<typeof roleSchema>;

/** A signed-in member of a shop. Roles and shop come from the membership, never from token metadata. */
export const authUserSchema = z.object({
  id: z.string().min(1),
  email: z.string(),
  name: z.string(),
  roles: z.array(roleSchema).min(1),
  shopId: z.string().min(1),
});
export type AuthUser = z.infer<typeof authUserSchema>;

/** True when `user` holds any of `allowed`; the route guards and every RPC check ask it this way. */
export function hasRole(user: AuthUser, allowed: readonly Role[]): boolean {
  return user.roles.some((role) => allowed.includes(role));
}

export const credentialsSchema = z.object({
  email: z.string().trim().min(1, 'Email is required'),
  password: z.string().min(1, 'Password is required'),
});
export type Credentials = z.infer<typeof credentialsSchema>;

/**
 * - `authenticated`: a live session; requests may be sent.
 * - `offline`: the backend cannot be reached but this device still holds the user's session, so the
 *   register may keep working locally. Nothing is sent until the state is `authenticated` again.
 * - `anonymous`: no session, or it was ended.
 */
export type AuthState =
  | { readonly status: 'anonymous' }
  | { readonly status: 'authenticated'; readonly user: AuthUser }
  | { readonly status: 'offline'; readonly user: AuthUser };

export interface AuthPort {
  /** The state at startup, from whatever session this device has stored. */
  getState(): Promise<AuthState>;
  /** Signs in and reads the user's shop membership; a user without one is FORBIDDEN. */
  signIn(credentials: Credentials): Promise<AuthUser>;
  /** Ends the session on this device only; other devices stay signed in. */
  signOut(): Promise<void>;
  /** Notifies every later change (sign-in, sign-out, token refresh, connectivity). */
  onStateChange(listener: (state: AuthState) => void): () => void;
}
