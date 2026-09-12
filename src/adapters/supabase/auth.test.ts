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
import { createSupabaseAuth, LAST_USER_STORAGE_KEY, type SupabaseAuthApi } from './auth';
import { failureOf, memoryStorage } from './fakeSupabase';

/** Where the fake client keeps its session, as supabase-js does under sb-<project-ref>-auth-token. */
const SESSION_KEY = 'sb-test-auth-token';

function makeUser(overrides: Partial<User> = {}): User {
  return {
    id: 'user-1',
    aud: 'authenticated',
    created_at: '2026-01-01T00:00:00.000Z',
    email: 'amel@example.tn',
    app_metadata: { provider: 'email' },
    user_metadata: {},
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

/** Amel's membership, as my_profile() reports it. */
const amel: AuthUser = {
  id: 'user-1',
  email: 'amel@example.tn',
  name: 'Amel',
  role: 'admin',
  shopId: 'shop-1',
};

/** A device Amel signed in on: her session, and her membership kept for offline starts. */
const signedInAsAmel = {
  [SESSION_KEY]: storedSession(),
  [LAST_USER_STORAGE_KEY]: JSON.stringify(amel),
};

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
  const readProfile = vi.fn<() => Promise<AuthUser>>(() => Promise.resolve(amel));
  const auth = createSupabaseAuth({
    auth: { getSession, signInWithPassword, signOut, onAuthStateChange },
    readProfile,
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
    readProfile,
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

/** Lets timers scheduled now, and the promises they start, run. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('supabase auth', () => {
  it('takes role, shop and name from the membership, never from token metadata', async () => {
    const fake = fakeAuth();
    const user = makeUser({
      app_metadata: { provider: 'email', role: 'cashier' },
      user_metadata: { name: 'Mallory', role: 'cashier' },
    });
    fake.signInWithPassword.mockResolvedValue({
      data: { user, session: makeSession(user) },
      error: null,
    });

    await expect(
      fake.auth.signIn({ email: 'amel@example.tn', password: 'secret' }),
    ).resolves.toEqual(amel);
    expect(fake.readProfile).toHaveBeenCalledTimes(1);
  });

  it('signs in with the trimmed email and remembers the member for offline starts', async () => {
    const fake = fakeAuth();

    const user = await fake.auth.signIn({ email: '  amel@example.tn ', password: 'secret' });

    expect(user).toEqual(amel);
    expect(fake.signInWithPassword).toHaveBeenCalledWith({
      email: 'amel@example.tn',
      password: 'secret',
    });
    expect(JSON.parse(fake.entries.get(LAST_USER_STORAGE_KEY) ?? 'null')).toEqual(amel);
  });

  it.each<[string, AppError | AuthUser]>([
    ['has no shop membership', new AppError('FORBIDDEN', 'Not a member of any shop.')],
    ['has a membership that cannot be read', new AppError('NETWORK_ERROR', 'Offline')],
    ['gets the membership of someone else', { ...amel, id: 'user-2' }],
  ])('ends the new session on this device when the user %s', async (_case, outcome) => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const fake = fakeAuth();
    fake.signInWithPassword.mockImplementation(() => {
      fake.entries.set(SESSION_KEY, storedSession());
      return Promise.resolve({ data: { user: makeUser(), session: makeSession() }, error: null });
    });
    fake.readProfile.mockImplementation(() =>
      outcome instanceof AppError ? Promise.reject(outcome) : Promise.resolve(outcome),
    );

    const error = await failureOf(fake.auth.signIn({ email: 'amel@example.tn', password: 'x' }));

    expect(error.code).toBe(outcome instanceof AppError ? outcome.code : 'UNAUTHENTICATED');
    expect(fake.signOut).toHaveBeenCalledWith({ scope: 'local' });
    expect([...fake.entries.keys()]).toEqual([]);
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
    expect(fake.readProfile).not.toHaveBeenCalled();
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

  it('is authenticated with a stored session and its membership, and remembers the member', async () => {
    const fake = fakeAuth();
    fake.getSession.mockResolvedValue({ data: { session: makeSession() }, error: null });

    await expect(fake.auth.getState()).resolves.toEqual({ status: 'authenticated', user: amel });
    expect(fake.entries.has(LAST_USER_STORAGE_KEY)).toBe(true);
  });

  it('starts offline as the last member when her session is valid but the database cannot be reached', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const fake = fakeAuth(signedInAsAmel);
    fake.getSession.mockResolvedValue({ data: { session: makeSession() }, error: null });
    fake.readProfile.mockRejectedValue(new AppError('NETWORK_ERROR', 'Offline'));

    await expect(fake.auth.getState()).resolves.toEqual({ status: 'offline', user: amel });
  });

  it.each<[string, Record<string, string>, AppError]>([
    ['the user has no membership', signedInAsAmel, new AppError('FORBIDDEN', 'Not a member')],
    [
      'the database cannot be reached and another user was cached',
      { [LAST_USER_STORAGE_KEY]: JSON.stringify({ ...amel, id: 'user-2' }) },
      new AppError('NETWORK_ERROR', 'Offline'),
    ],
  ])('is anonymous with a valid session when %s', async (_case, stored, failure) => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const fake = fakeAuth(stored);
    fake.getSession.mockResolvedValue({ data: { session: makeSession() }, error: null });
    fake.readProfile.mockRejectedValue(failure);

    await expect(fake.auth.getState()).resolves.toEqual({ status: 'anonymous' });
    expect(fake.entries.has(LAST_USER_STORAGE_KEY)).toBe(false);
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
    expect(fake.readProfile).not.toHaveBeenCalled();
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
      'the cached user has no shop',
      {
        [SESSION_KEY]: storedSession(),
        [LAST_USER_STORAGE_KEY]: JSON.stringify({ ...amel, shopId: undefined }),
      },
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

  it('reports session events of the remembered member as authenticated and SIGNED_OUT as anonymous', () => {
    const fake = fakeAuth({ [LAST_USER_STORAGE_KEY]: JSON.stringify(amel) });
    const states: AuthState[] = [];
    const stop = fake.auth.onStateChange((state) => {
      states.push(state);
    });

    fake.emit('INITIAL_SESSION', null);
    fake.emit('SIGNED_IN', makeSession());
    fake.emit('PASSWORD_RECOVERY', makeSession());
    fake.emit('TOKEN_REFRESHED', makeSession());
    fake.emit('SIGNED_OUT', null);
    stop();

    expect(states).toEqual([
      { status: 'authenticated', user: amel },
      { status: 'authenticated', user: amel },
      { status: 'anonymous' },
    ]);
    expect(fake.readProfile).not.toHaveBeenCalled();
    expect(fake.entries.has(LAST_USER_STORAGE_KEY)).toBe(false);
    expect(fake.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('reads the membership of a session it has not seen, after the auth-js callback returns', async () => {
    const fake = fakeAuth();
    const states = recordStates(fake.auth);

    fake.emit('SIGNED_IN', makeSession());

    expect(fake.readProfile).not.toHaveBeenCalled();
    await vi.waitFor(() => {
      expect(states).toEqual([{ status: 'authenticated', user: amel }]);
    });
    expect(JSON.parse(fake.entries.get(LAST_USER_STORAGE_KEY) ?? 'null')).toEqual(amel);
  });

  it('drops a membership read overtaken by a sign-out', async () => {
    const fake = fakeAuth();
    const states = recordStates(fake.auth);

    fake.emit('SIGNED_IN', makeSession());
    fake.emit('SIGNED_OUT', null);
    await settle();

    expect(fake.readProfile).toHaveBeenCalledTimes(1);
    expect(states).toEqual([{ status: 'anonymous' }]);
    expect(fake.entries.has(LAST_USER_STORAGE_KEY)).toBe(false);
  });

  it('reports nothing, and warns, when the membership of a new session cannot be read', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const fake = fakeAuth();
    fake.readProfile.mockRejectedValue(new AppError('FORBIDDEN', 'Not a member'));
    const states = recordStates(fake.auth);

    fake.emit('SIGNED_IN', makeSession());
    await settle();

    expect(states).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
