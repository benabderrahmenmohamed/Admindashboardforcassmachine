import {
  AuthApiError,
  AuthRetryableFetchError,
  type AuthChangeEvent,
  type AuthError,
  type Session,
  type User,
} from '@supabase/supabase-js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '@/lib/errors';
import type { AuthPort, AuthState, AuthUser } from '@/ports';
import {
  createSupabaseAuth,
  LAST_USER_STORAGE_KEY,
  readAccessToken,
  type StorageLike,
  type SupabaseAuthApi,
} from './auth';

/** Where the fake client keeps its session, as supabase-js does under sb-<project-ref>-auth-token. */
const SESSION_KEY = 'sb-test-auth-token';

function makeUser(overrides: Partial<User> = {}): User {
  return {
    id: 'user-1',
    aud: 'authenticated',
    created_at: '2026-01-01T00:00:00.000Z',
    email: 'amel@example.tn',
    app_metadata: { provider: 'email', role: 'admin' },
    user_metadata: { name: 'Amel' },
    ...overrides,
  };
}

function makeSession(user: User = makeUser()): Session {
  return {
    access_token: 'access-token',
    refresh_token: 'refresh-token',
    expires_in: 3600,
    token_type: 'bearer',
    user,
  };
}

/** A session as supabase-js stores it under SESSION_KEY. */
function storedSession(user: User = makeUser()): string {
  return JSON.stringify(makeSession(user));
}

const amel: AuthUser = { id: 'user-1', email: 'amel@example.tn', name: 'Amel', role: 'admin' };

/** A device Amel signed in on: her session, and her identity kept for offline starts. */
const signedInAsAmel = {
  [SESSION_KEY]: storedSession(),
  [LAST_USER_STORAGE_KEY]: JSON.stringify(amel),
};

function memoryStorage(initial: Record<string, string> = {}) {
  const entries = new Map(Object.entries(initial));
  const storage: StorageLike = {
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => {
      entries.set(key, value);
    },
    removeItem: (key) => {
      entries.delete(key);
    },
  };
  return { entries, storage };
}

function fakeAuth(initial: Record<string, string> = {}) {
  const listeners: ((event: AuthChangeEvent, session: Session | null) => void)[] = [];
  const emit = (event: AuthChangeEvent, session: Session | null) => {
    for (const listener of listeners) {
      listener(event, session);
    }
  };
  const { entries, storage } = memoryStorage(initial);
  /** What auth-js does when it ends the session itself: remove it, then fire SIGNED_OUT. */
  const removeSession = () => {
    entries.delete(SESSION_KEY);
    entries.delete(`${SESSION_KEY}-user`);
    emit('SIGNED_OUT', null);
  };
  const getSession = vi.fn<SupabaseAuthApi['getSession']>(() =>
    Promise.resolve({ data: { session: null }, error: null }),
  );
  const signInWithPassword = vi.fn<SupabaseAuthApi['signInWithPassword']>(() =>
    Promise.resolve({ data: { user: makeUser(), session: makeSession() }, error: null }),
  );
  const signOut = vi.fn<SupabaseAuthApi['signOut']>(() => {
    removeSession();
    return Promise.resolve({ error: null });
  });
  const unsubscribe = vi.fn();
  const onAuthStateChange = vi.fn<SupabaseAuthApi['onAuthStateChange']>((callback) => {
    listeners.push(callback);
    return { data: { subscription: { unsubscribe } } };
  });
  const auth = createSupabaseAuth({
    auth: { getSession, signInWithPassword, signOut, onAuthStateChange },
    storage: () => storage,
    sessionStorageKey: SESSION_KEY,
  });
  return {
    auth,
    entries,
    storage,
    getSession,
    signInWithPassword,
    signOut,
    unsubscribe,
    emit,
    removeSession,
  };
}

function recordStates(auth: AuthPort): AuthState[] {
  const states: AuthState[] = [];
  auth.onStateChange((state) => {
    states.push(state);
  });
  return states;
}

async function failureOf(promise: Promise<unknown>): Promise<AppError> {
  const outcome: unknown = await promise.then(
    () => null,
    (error: unknown) => error,
  );
  if (!(outcome instanceof AppError)) {
    return expect.unreachable('expected a failure with an AppError');
  }
  return outcome;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('supabase auth', () => {
  it.each<[unknown, AuthUser['role']]>([
    ['admin', 'admin'],
    ['worker', 'cashier'],
    ['cashier', 'cashier'],
    ['ADMIN', 'cashier'],
    [undefined, 'cashier'],
  ])('maps app_metadata.role %j to %s', async (role, expected) => {
    const fake = fakeAuth();
    const user = makeUser({ app_metadata: { provider: 'email', role }, user_metadata: {} });
    fake.signInWithPassword.mockResolvedValue({
      data: { user, session: makeSession(user) },
      error: null,
    });

    const signedIn = await fake.auth.signIn({ email: 'amel@example.tn', password: 'secret' });

    expect(signedIn).toEqual({ id: 'user-1', email: 'amel@example.tn', name: '', role: expected });
  });

  it('signs in with the trimmed email and remembers the user for offline starts', async () => {
    const fake = fakeAuth();

    const user = await fake.auth.signIn({ email: '  amel@example.tn ', password: 'secret' });

    expect(user).toEqual(amel);
    expect(fake.signInWithPassword).toHaveBeenCalledWith({
      email: 'amel@example.tn',
      password: 'secret',
    });
    expect(JSON.parse(fake.entries.get(LAST_USER_STORAGE_KEY) ?? 'null')).toEqual(amel);
  });

  it('turns refused credentials into UNAUTHENTICATED with the Supabase message', async () => {
    const fake = fakeAuth();
    fake.signInWithPassword.mockResolvedValue({
      data: { user: null, session: null },
      error: new AuthApiError('Invalid login credentials', 400, 'invalid_credentials'),
    });

    const error = await failureOf(fake.auth.signIn({ email: 'amel@example.tn', password: 'x' }));

    expect(error.code).toBe('UNAUTHENTICATED');
    expect(error.message).toBe('Invalid login credentials');
  });

  it('turns an unreachable auth server into NETWORK_ERROR', async () => {
    const fake = fakeAuth();
    fake.signInWithPassword.mockResolvedValue({
      data: { user: null, session: null },
      error: new AuthRetryableFetchError('Failed to fetch', 0),
    });

    const error = await failureOf(fake.auth.signIn({ email: 'amel@example.tn', password: 'x' }));

    expect(error.code).toBe('NETWORK_ERROR');
  });

  it('is authenticated with a stored session, and remembers that user', async () => {
    const fake = fakeAuth();
    fake.getSession.mockResolvedValue({ data: { session: makeSession() }, error: null });

    await expect(fake.auth.getState()).resolves.toEqual({ status: 'authenticated', user: amel });
    expect(fake.entries.has(LAST_USER_STORAGE_KEY)).toBe(true);
  });

  it('starts offline as the last user when auth cannot be reached and her session is stored', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const fake = fakeAuth(signedInAsAmel);
    // An expired token and no network: getSession cannot refresh the stored session.
    fake.getSession.mockResolvedValue({
      data: { session: null },
      error: new AuthRetryableFetchError('Failed to fetch', 0),
    });

    await expect(fake.auth.getState()).resolves.toEqual({ status: 'offline', user: amel });
    expect(fake.entries.has(LAST_USER_STORAGE_KEY)).toBe(true);
  });

  it.each<[string, Record<string, string>, AuthError | null]>([
    ['auth-js holds no session', { [LAST_USER_STORAGE_KEY]: JSON.stringify(amel) }, null],
    [
      'no user was cached',
      { [SESSION_KEY]: storedSession() },
      new AuthRetryableFetchError('Failed to fetch', 0),
    ],
    [
      'the cached user is not readable',
      { [SESSION_KEY]: storedSession(), [LAST_USER_STORAGE_KEY]: '{not json' },
      new AuthRetryableFetchError('Failed to fetch', 0),
    ],
    [
      'no session is stored for the cached user',
      { [LAST_USER_STORAGE_KEY]: JSON.stringify(amel) },
      new AuthRetryableFetchError('Failed to fetch', 0),
    ],
    [
      'the stored session belongs to another user',
      {
        [SESSION_KEY]: storedSession(makeUser({ id: 'user-2' })),
        [LAST_USER_STORAGE_KEY]: JSON.stringify(amel),
      },
      new AuthRetryableFetchError('Failed to fetch', 0),
    ],
    [
      'the stored session is not readable',
      { [SESSION_KEY]: '{not json', [LAST_USER_STORAGE_KEY]: JSON.stringify(amel) },
      new AuthRetryableFetchError('Failed to fetch', 0),
    ],
    [
      'the session was revoked',
      { [LAST_USER_STORAGE_KEY]: JSON.stringify(amel) },
      new AuthApiError('Invalid Refresh Token', 400, 'refresh_token_not_found'),
    ],
  ])('is anonymous and forgets the cached user when %s', async (_case, stored, error) => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const fake = fakeAuth(stored);
    fake.getSession.mockResolvedValue({ data: { session: null }, error });

    await expect(fake.auth.getState()).resolves.toEqual({ status: 'anonymous' });
    expect(fake.entries.has(LAST_USER_STORAGE_KEY)).toBe(false);
  });

  it('signs out on this device only, and listeners hear it once from auth-js', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const fake = fakeAuth(signedInAsAmel);
    const states = recordStates(fake.auth);

    await expect(fake.auth.signOut()).resolves.toBeUndefined();

    expect(fake.signOut).toHaveBeenCalledWith({ scope: 'local' });
    expect(fake.getSession).not.toHaveBeenCalled();
    expect([...fake.entries.keys()]).toEqual([]);
    expect(states).toEqual([{ status: 'anonymous' }]);
    expect(warn).not.toHaveBeenCalled();
  });

  it.each<[string, SupabaseAuthApi['signOut']]>([
    [
      'returns the refresh failure',
      () => Promise.resolve({ error: new AuthRetryableFetchError('Failed to fetch', 0) }),
    ],
    [
      'rejects with a network error',
      () => Promise.reject(new AuthRetryableFetchError('Failed to fetch', 0)),
    ],
  ])('ends an offline sign-out on this device when auth-js %s', async (_case, outcome) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const fake = fakeAuth({ ...signedInAsAmel, [`${SESSION_KEY}-user`]: '{}' });
    // An expired token and no network: auth-js cannot load the session, so it keeps it.
    fake.signOut.mockImplementation(outcome);
    fake.getSession.mockResolvedValue({
      data: { session: null },
      error: new AuthRetryableFetchError('Failed to fetch', 0),
    });

    await expect(fake.auth.signOut()).resolves.toBeUndefined();

    expect([...fake.entries.keys()]).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    await expect(fake.auth.getState()).resolves.toEqual({ status: 'anonymous' });
  });

  it('tells listeners the user is anonymous after an offline sign-out', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const fake = fakeAuth(signedInAsAmel);
    const states = recordStates(fake.auth);
    fake.signOut.mockResolvedValue({ error: new AuthRetryableFetchError('Failed to fetch', 0) });

    await fake.auth.signOut();

    expect(states).toEqual([{ status: 'anonymous' }]);
  });

  it('tells listeners once when auth-js ended the session but could not reach the server', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const fake = fakeAuth(signedInAsAmel);
    const states = recordStates(fake.auth);
    // A valid token and no network: auth-js removes the session, then returns the failed /logout.
    fake.signOut.mockImplementation(() => {
      fake.removeSession();
      return Promise.resolve({ error: new AuthRetryableFetchError('Failed to fetch', 0) });
    });

    await expect(fake.auth.signOut()).resolves.toBeUndefined();

    expect(states).toEqual([{ status: 'anonymous' }]);
    expect([...fake.entries.keys()]).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('fails with UNKNOWN, still signed in, when storage refuses to remove the session', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const fake = fakeAuth(signedInAsAmel);
    const states = recordStates(fake.auth);
    fake.signOut.mockResolvedValue({ error: new AuthRetryableFetchError('Failed to fetch', 0) });
    vi.spyOn(fake.storage, 'removeItem').mockImplementation(() => {
      throw new DOMException('The operation is insecure.', 'SecurityError');
    });

    const error = await failureOf(fake.auth.signOut());

    expect(error.code).toBe('UNKNOWN');
    expect(states).toEqual([]);
    expect(fake.entries.has(LAST_USER_STORAGE_KEY)).toBe(true);
  });

  it('reports session events as authenticated and SIGNED_OUT as anonymous', () => {
    const fake = fakeAuth();
    const states: AuthState[] = [];
    const stop = fake.auth.onStateChange((state) => {
      states.push(state);
    });

    fake.emit('INITIAL_SESSION', null);
    fake.emit('SIGNED_IN', makeSession());
    fake.emit('PASSWORD_RECOVERY', makeSession());
    fake.emit('TOKEN_REFRESHED', makeSession());
    expect(fake.entries.has(LAST_USER_STORAGE_KEY)).toBe(true);
    fake.emit('SIGNED_OUT', null);
    stop();

    expect(states).toEqual([
      { status: 'authenticated', user: amel },
      { status: 'authenticated', user: amel },
      { status: 'anonymous' },
    ]);
    expect(fake.entries.has(LAST_USER_STORAGE_KEY)).toBe(false);
    expect(fake.unsubscribe).toHaveBeenCalledTimes(1);
  });
});

describe('readAccessToken', () => {
  it('reads the token of the current session', async () => {
    const getSession = vi.fn<SupabaseAuthApi['getSession']>(() =>
      Promise.resolve({ data: { session: makeSession() }, error: null }),
    );

    await expect(readAccessToken({ getSession })).resolves.toBe('access-token');
  });

  it('is null without a session', async () => {
    const getSession = vi.fn<SupabaseAuthApi['getSession']>(() =>
      Promise.resolve({ data: { session: null }, error: null }),
    );

    await expect(readAccessToken({ getSession })).resolves.toBeNull();
  });

  it('throws NETWORK_ERROR when the session cannot be refreshed offline', async () => {
    const getSession = vi.fn<SupabaseAuthApi['getSession']>(() =>
      Promise.resolve({
        data: { session: null },
        error: new AuthRetryableFetchError('Failed to fetch', 0),
      }),
    );

    const error = await failureOf(readAccessToken({ getSession }));

    expect(error.code).toBe('NETWORK_ERROR');
  });
});
