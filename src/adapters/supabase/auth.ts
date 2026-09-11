import {
  isAuthApiError,
  isAuthRetryableFetchError,
  type AuthChangeEvent,
  type AuthError,
  type Session,
  type User,
} from '@supabase/supabase-js';
import { z } from 'zod';
import { supabaseEnv } from '@/lib/env';
import { AppError, toAppError } from '@/lib/errors';
import {
  authUserSchema,
  credentialsSchema,
  type AuthPort,
  type AuthState,
  type AuthUser,
} from '@/ports';
import { supabaseAuthStorageKey } from './client';
import { defaultErrorMessage, errorCodeForStatus } from './http';
import { parseInput, parseOutput } from './validate';

type SessionResult = { data: { session: Session | null }; error: AuthError | null };

type SignInResult = {
  data: { user: User | null; session: Session | null };
  error: AuthError | null;
};

/** The part of `supabase.auth` this adapter uses, so tests can pass a fake. */
export interface SupabaseAuthApi {
  getSession(): Promise<SessionResult>;
  signInWithPassword(credentials: { email: string; password: string }): Promise<SignInResult>;
  signOut(options: { scope: 'local' }): Promise<{ error: AuthError | null }>;
  onAuthStateChange(callback: (event: AuthChangeEvent, session: Session | null) => void): {
    data: { subscription: { unsubscribe(): void } };
  };
}

export type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export interface SupabaseAuthDeps {
  readonly auth: SupabaseAuthApi;
  /**
   * Where supabase-js keeps the session, and where the last signed-in identity is kept for offline
   * starts. Defaults to localStorage, as for the app's client.
   */
  readonly storage?: () => StorageLike;
  /** The key supabase-js keeps the session under. Defaults to the key of the app's client. */
  readonly sessionStorageKey?: string;
}

/** localStorage key of the last authenticated identity, which lets the register start offline. */
export const LAST_USER_STORAGE_KEY = 'pos.auth.lastUser';

/** What this adapter reads of the session supabase-js stores: whose session it is. */
const storedSessionSchema = z.object({ user: z.object({ id: z.string().min(1) }) });

/** Events that carry the current session; SIGNED_OUT is handled on its own. */
const SESSION_EVENTS: ReadonlySet<AuthChangeEvent> = new Set<AuthChangeEvent>([
  'SIGNED_IN',
  'TOKEN_REFRESHED',
  'USER_UPDATED',
  'INITIAL_SESSION',
]);

/**
 * Roles live in app_metadata, which only the service role can write: 'admin' is an admin, and
 * anything else ('worker' from the legacy signup route, or nothing) is a cashier.
 */
export function toAuthUser(user: User): AuthUser {
  const role: unknown = user.app_metadata?.role;
  const name: unknown = user.user_metadata?.name;
  return parseOutput(
    authUserSchema,
    {
      id: user.id,
      email: user.email ?? '',
      name: typeof name === 'string' ? name : '',
      role: role === 'admin' ? 'admin' : 'cashier',
    },
    'a user',
  );
}

/** Turns what supabase.auth returned or threw into an AppError, from its type and status only. */
export function toAuthAppError(error: unknown): AppError {
  if (error instanceof AppError) {
    return error;
  }
  if (isAuthRetryableFetchError(error)) {
    return new AppError('NETWORK_ERROR', defaultErrorMessage('NETWORK_ERROR'), {
      details: { status: error.status },
      cause: error,
    });
  }
  if (isAuthApiError(error)) {
    // Auth answers 400 when it refuses credentials (invalid_credentials, email_not_confirmed).
    const code =
      error.status === 400 && error.code !== 'validation_failed'
        ? 'UNAUTHENTICATED'
        : errorCodeForStatus(error.status);
    return new AppError(code, error.message || defaultErrorMessage(code), {
      details: { status: error.status, authCode: error.code },
      cause: error,
    });
  }
  return toAppError(error);
}

/**
 * The access token to send right now, refreshed by supabase-js when it has expired, or null when
 * nobody is signed in. Throws NETWORK_ERROR when a session exists but cannot be refreshed offline.
 */
export async function readAccessToken(
  auth: Pick<SupabaseAuthApi, 'getSession'>,
): Promise<string | null> {
  let result: SessionResult;
  try {
    result = await auth.getSession();
  } catch (error) {
    throw toAuthAppError(error);
  }
  if (result.data.session) {
    return result.data.session.access_token;
  }
  if (result.error) {
    if (isAuthRetryableFetchError(result.error)) {
      throw toAuthAppError(result.error);
    }
    console.warn('The session could not be restored; sending nothing as the user', result.error);
  }
  return null;
}

/**
 * The JSON value stored under `key`, or null when there is none. A value that cannot be read or
 * does not match `schema` is reported and read as absent, since nothing could use it either way.
 */
function readStored<Schema extends z.ZodType>(
  storage: () => StorageLike,
  key: string,
  schema: Schema,
  what: string,
): z.output<Schema> | null {
  let raw: string | null;
  try {
    raw = storage().getItem(key);
  } catch (error) {
    console.warn(`Could not read ${what}`, error);
    return null;
  }
  if (!raw) {
    return null;
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    console.warn(`Ignoring ${what}: it is not JSON`, error);
    return null;
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    console.warn(`Ignoring ${what}: it has an unexpected shape`, parsed.error);
    return null;
  }
  return parsed.data;
}

function createUserCache(storage: () => StorageLike) {
  return {
    remember(user: AuthUser): void {
      try {
        storage().setItem(LAST_USER_STORAGE_KEY, JSON.stringify(user));
      } catch (error) {
        console.warn('Could not keep the signed-in user for offline starts', error);
      }
    },
    read(): AuthUser | null {
      return readStored(storage, LAST_USER_STORAGE_KEY, authUserSchema, 'the last signed-in user');
    },
    forget(): void {
      try {
        storage().removeItem(LAST_USER_STORAGE_KEY);
      } catch (error) {
        console.warn('Could not remove the last signed-in user', error);
      }
    },
  };
}

/**
 * The session supabase-js keeps in storage, for what auth-js cannot do offline: it hands out an
 * expired session only once it has refreshed it, and when that refresh fails it keeps the session,
 * through signOut too.
 */
function createStoredSession(storage: () => StorageLike, key: string) {
  return {
    /** Whose session this device stores, read without the network; null when none is readable. */
    userId(): string | null {
      return readStored(storage, key, storedSessionSchema, 'the stored session')?.user.id ?? null;
    },
    /**
     * Removes what auth-js's own sign-out removes (password sign-in stores no PKCE verifier) and
     * tells whether a session was still stored. Throws when storage refuses.
     */
    remove(): boolean {
      const store = storage();
      const found = store.getItem(key) !== null;
      store.removeItem(key);
      store.removeItem(`${key}-user`);
      return found;
    },
  };
}

export function createSupabaseAuth(deps: SupabaseAuthDeps): AuthPort {
  const storage = deps.storage ?? (() => localStorage);
  const cache = createUserCache(storage);
  const storedSession = createStoredSession(
    storage,
    deps.sessionStorageKey ?? supabaseAuthStorageKey(supabaseEnv().url),
  );
  const listeners = new Set<(state: AuthState) => void>();

  function notify(state: AuthState): void {
    for (const listener of [...listeners]) {
      listener(state);
    }
  }

  /** The last signed-in user, provided the session this device stores is theirs. */
  function offlineUser(): AuthUser | null {
    const user = cache.read();
    if (!user) {
      return null;
    }
    if (storedSession.userId() !== user.id) {
      console.warn('No stored session belongs to the last signed-in user');
      return null;
    }
    return user;
  }

  /**
   * Offline while auth cannot be reached and this device still holds the last user's session.
   * Otherwise anonymous, and the cached user is forgotten: it only stands in for a stored session.
   */
  function stateWithoutSession(error: unknown): AuthState {
    if (isAuthRetryableFetchError(error)) {
      const user = offlineUser();
      if (user) {
        console.warn(
          'Auth cannot be reached; continuing offline as the last signed-in user',
          error,
        );
        return { status: 'offline', user };
      }
    }
    if (error !== null) {
      console.warn('No session could be restored', error);
    }
    cache.forget();
    return { status: 'anonymous' };
  }

  return {
    async getState() {
      let result: SessionResult;
      try {
        result = await deps.auth.getSession();
      } catch (error) {
        return stateWithoutSession(error);
      }
      const { session } = result.data;
      if (session) {
        const user = toAuthUser(session.user);
        cache.remember(user);
        return { status: 'authenticated', user };
      }
      return stateWithoutSession(result.error);
    },

    async signIn(credentials) {
      const { email, password } = parseInput(credentialsSchema, credentials);
      let result: SignInResult;
      try {
        result = await deps.auth.signInWithPassword({ email, password });
      } catch (error) {
        throw toAuthAppError(error);
      }
      if (result.error) {
        throw toAuthAppError(result.error);
      }
      const { user, session } = result.data;
      if (!user || !session) {
        throw new AppError('UNAUTHENTICATED', 'Sign-in did not start a session.');
      }
      const authUser = toAuthUser(user);
      cache.remember(authUser);
      return authUser;
    },

    async signOut() {
      // auth-js goes first: it revokes the refresh token when the server can be reached, and a
      // refresh it has in flight settles before the storage is cleared below.
      let failure: unknown;
      try {
        failure = (await deps.auth.signOut({ scope: 'local' })).error;
      } catch (error) {
        // Recorded and reported below: revoking is best effort, and must not keep this device in.
        failure = error;
      }
      // With an expired token and no network, auth-js returns the refresh failure and keeps the
      // session, so it is removed here.
      let kept: boolean;
      try {
        kept = storedSession.remove();
      } catch (error) {
        throw new AppError('UNKNOWN', 'Could not end the session on this device.', {
          cause: error,
        });
      }
      cache.forget();
      if (failure !== null) {
        console.warn('Signed out on this device, but the server could not be told', failure);
      }
      if (kept) {
        // auth-js fires SIGNED_OUT only when it removes the session itself.
        notify({ status: 'anonymous' });
      }
    },

    onStateChange(listener) {
      // One entry per call, so a function subscribed twice stays subscribed until both stop.
      const entry = (state: AuthState) => {
        listener(state);
      };
      listeners.add(entry);
      const { data } = deps.auth.onAuthStateChange((event, session) => {
        if (event === 'SIGNED_OUT') {
          cache.forget();
          entry({ status: 'anonymous' });
          return;
        }
        if (!session || !SESSION_EVENTS.has(event)) {
          return;
        }
        let user: AuthUser;
        try {
          user = toAuthUser(session.user);
        } catch (error) {
          console.error(`Ignoring ${event}: the user could not be read`, error);
          return;
        }
        cache.remember(user);
        entry({ status: 'authenticated', user });
      });
      return () => {
        listeners.delete(entry);
        data.subscription.unsubscribe();
      };
    },
  };
}
