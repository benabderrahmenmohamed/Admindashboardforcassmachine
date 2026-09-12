import {
  isAuthRetryableFetchError,
  type AuthChangeEvent,
  type AuthError,
  type Session,
  type User,
} from '@supabase/supabase-js';
import { z } from 'zod';
import { supabaseEnv } from '@/lib/env';
import { AppError, errorClass, toAppError } from '@/lib/errors';
import {
  authUserSchema,
  credentialsSchema,
  type AuthPort,
  type AuthState,
  type AuthUser,
} from '@/ports';
import { supabaseAuthStorageKey } from './client';
import { toAuthAppError } from './errors';
import { parseInput } from './validate';

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
   * The signed-in user as a member of their shop (readMyProfile). Role, shop and name come only from
   * here, never from token metadata.
   */
  readonly readProfile: () => Promise<AuthUser>;
  /**
   * Where supabase-js keeps the session, and where the last signed-in member is kept for offline
   * starts. Defaults to localStorage, as for the app's client.
   */
  readonly storage?: () => StorageLike;
  /**
   * The key supabase-js keeps the session under. Defaults to the key of the app's client, derived
   * from VITE_SUPABASE_URL the first time it is needed.
   */
  readonly sessionStorageKey?: string;
}

/** localStorage key of the last authenticated member, which lets the register start offline. */
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
function createStoredSession(storage: () => StorageLike, key: () => string) {
  return {
    /** Whose session this device stores, read without the network; null when none is readable. */
    userId(): string | null {
      return readStored(storage, key(), storedSessionSchema, 'the stored session')?.user.id ?? null;
    },
    /**
     * Removes what auth-js's own sign-out removes (password sign-in stores no PKCE verifier) and
     * tells whether a session was still stored. Throws when storage refuses.
     */
    remove(): boolean {
      const sessionKey = key();
      const store = storage();
      const found = store.getItem(sessionKey) !== null;
      store.removeItem(sessionKey);
      store.removeItem(`${sessionKey}-user`);
      return found;
    },
  };
}

export function createSupabaseAuth(deps: SupabaseAuthDeps): AuthPort {
  const storage = deps.storage ?? (() => localStorage);
  const cache = createUserCache(storage);
  let sessionStorageKey = deps.sessionStorageKey;
  const storedSession = createStoredSession(storage, () => {
    // Resolved on first use, so a backend built around an injected client needs no environment.
    sessionStorageKey ??= supabaseAuthStorageKey(supabaseEnv().url);
    return sessionStorageKey;
  });
  const listeners = new Set<(state: AuthState) => void>();

  function notify(state: AuthState): void {
    for (const listener of [...listeners]) {
      listener(state);
    }
  }

  /** The shop membership of the session's user, `userId`: FORBIDDEN when there is none. */
  async function readMember(userId: string): Promise<AuthUser> {
    const member = await deps.readProfile();
    if (member.id !== userId) {
      throw new AppError(
        'UNAUTHENTICATED',
        'The session changed while it was read. Sign in again.',
        {
          details: { userId, profileUserId: member.id },
        },
      );
    }
    return member;
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

  /** Ends the session on this device only, whether or not the server can be told. */
  async function endSession(): Promise<void> {
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
      if (!session) {
        return stateWithoutSession(result.error);
      }
      try {
        const user = await readMember(session.user.id);
        cache.remember(user);
        return { status: 'authenticated', user };
      } catch (error) {
        const failure = toAppError(error);
        const cached = cache.read();
        if (errorClass(failure.code) === 'retriable' && cached?.id === session.user.id) {
          console.warn(
            'The shop membership cannot be read; continuing offline as the last signed-in user',
            failure,
          );
          return { status: 'offline', user: cached };
        }
        console.warn('No shop membership could be read for the stored session', failure);
        cache.forget();
        return { status: 'anonymous' };
      }
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
      let member: AuthUser;
      try {
        member = await readMember(user.id);
      } catch (error) {
        const failure = toAppError(error);
        // A refused sign-in leaves nobody signed in: without a readable shop membership there is
        // no role, so the session auth-js just stored is ended again.
        try {
          await endSession();
        } catch (signOutError) {
          console.warn('Could not end the session of a refused sign-in', signOutError);
        }
        throw failure;
      }
      cache.remember(member);
      return member;
    },

    signOut: endSession,

    onStateChange(listener) {
      // One entry per call, so a function subscribed twice stays subscribed until both stop.
      const entry = (state: AuthState) => {
        listener(state);
      };
      listeners.add(entry);
      // Counts the events this subscription has reported, so a membership read that finishes after
      // a newer event (a sign-out, say) reports nothing.
      let latestEvent = 0;
      const { data } = deps.auth.onAuthStateChange((event, session) => {
        if (event === 'SIGNED_OUT') {
          latestEvent += 1;
          cache.forget();
          entry({ status: 'anonymous' });
          return;
        }
        if (!session || !SESSION_EVENTS.has(event)) {
          return;
        }
        latestEvent += 1;
        const thisEvent = latestEvent;
        const cached = cache.read();
        if (cached?.id === session.user.id) {
          entry({ status: 'authenticated', user: cached });
          return;
        }
        // Role and shop come from the membership, read once this callback has returned: auth-js
        // runs it while holding the session lock, which the request would wait for.
        setTimeout(() => {
          readMember(session.user.id).then(
            (user) => {
              if (thisEvent === latestEvent && listeners.has(entry)) {
                cache.remember(user);
                entry({ status: 'authenticated', user });
              }
            },
            (error: unknown) => {
              console.warn(
                `Ignoring ${event}: no shop membership could be read`,
                toAppError(error),
              );
            },
          );
        }, 0);
      });
      return () => {
        listeners.delete(entry);
        data.subscription.unsubscribe();
      };
    },
  };
}
