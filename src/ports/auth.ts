import { z } from 'zod';

export const roleSchema = z.enum(['admin', 'cashier']);
export type Role = z.infer<typeof roleSchema>;

export const authUserSchema = z.object({
  id: z.string().min(1),
  email: z.string(),
  name: z.string(),
  role: roleSchema,
});
export type AuthUser = z.infer<typeof authUserSchema>;

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
  signIn(credentials: Credentials): Promise<AuthUser>;
  /** Ends the session on this device only; other devices stay signed in. */
  signOut(): Promise<void>;
  /** Notifies every later change (sign-in, sign-out, token refresh, connectivity). */
  onStateChange(listener: (state: AuthState) => void): () => void;
}
