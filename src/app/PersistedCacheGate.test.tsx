import { useQuery } from '@tanstack/react-query';
import {
  persistQueryClientSave,
  PersistQueryClientProvider,
} from '@tanstack/react-query-persist-client';
import { act, render, screen, waitFor } from '@testing-library/react';
import { useEffect } from 'react';
import { describe, expect, it } from 'vitest';
import { AuthProvider } from '@/features/auth/components/AuthProvider';
import { useAuth } from '@/features/auth/hooks/useAuth';
import { CATALOG_CACHE_KEY, type AsyncKeyValueStorage } from '@/features/sync/runtime';
import { createBackend } from '@/lib/backend';
import { BackendProvider } from '@/lib/backend-context';
import { createQueryClient, queryKeys } from '@/lib/query';
import type { AuthUser, Backend } from '@/ports';
import { PersistedCacheGate } from './PersistedCacheGate';
import { createQueryPersistence } from './queryPersistence';

const WAITERS_ROOM = 'Table 4: two direct coffees, not sent';
const NO_ROOM = 'No room on this device';

interface Commit {
  readonly user: string | null;
  readonly room: string | undefined;
}

/**
 * A face of the app, reduced to what matters here: it draws the board from the cache, and its own
 * request never answers, as on a phone with no network. Every render that reaches the screen is
 * reported, so a test can tell whether anyone ever saw a room that was not theirs.
 */
function RoomProbe({ onCommit }: { readonly onCommit: (commit: Commit) => void }) {
  const { state } = useAuth();
  const board = useQuery({
    queryKey: queryKeys.board,
    queryFn: () => new Promise<string>(() => undefined),
  });
  const user =
    state.status === 'authenticated' || state.status === 'offline' ? state.user.id : null;
  useEffect(() => {
    onCommit({ user, room: board.data });
  });
  return <p>{board.data ?? NO_ROOM}</p>;
}

function deviceStorage() {
  const items = new Map<string, string>();
  const storage: AsyncKeyValueStorage = {
    getItem: (key) => Promise.resolve(items.get(key) ?? null),
    setItem: (key, value) => {
      items.set(key, value);
      return Promise.resolve();
    },
    removeItem: (key) => {
      items.delete(key);
      return Promise.resolve();
    },
  };
  return { items, storage };
}

async function signIn(backend: Backend, label: string): Promise<AuthUser> {
  const account = backend.demoAccounts?.find((candidate) => candidate.label === label);
  if (!account) {
    throw new Error(`The demo backend has no ${label} account.`);
  }
  return backend.auth.signIn({ email: account.email, password: account.password });
}

/** What the waiter's phone wrote before it was reloaded: the room as they left it. */
async function leaveWaitersRoom(storage: AsyncKeyValueStorage, waiter: AuthUser): Promise<void> {
  const queryClient = createQueryClient();
  const persistence = createQueryPersistence({ queryClient, storage });
  await persistence.setOwner(waiter.id);
  queryClient.setQueryData(queryKeys.board, WAITERS_ROOM);
  await persistQueryClientSave({ queryClient, ...persistence.options });
}

/** The waiter's phone, reloaded with the waiter's session still on it. */
async function reloadedWaitersPhone() {
  const { items, storage } = deviceStorage();
  // The composition root the app uses: with VITE_BACKEND=memory, the in-browser demo backend.
  const backend = await createBackend();
  const waiter = await signIn(backend, 'Waiter');
  await leaveWaitersRoom(storage, waiter);

  const queryClient = createQueryClient();
  const persistence = createQueryPersistence({ queryClient, storage });
  const commits: Commit[] = [];
  render(
    <BackendProvider backend={backend}>
      <PersistQueryClientProvider client={queryClient} persistOptions={persistence.options}>
        <AuthProvider>
          <PersistedCacheGate persistence={persistence}>
            <RoomProbe onCommit={(commit) => commits.push(commit)} />
          </PersistedCacheGate>
        </AuthProvider>
      </PersistQueryClientProvider>
    </BackendProvider>,
  );
  expect(await screen.findByText(WAITERS_ROOM)).toBeDefined();
  return { backend, items, queryClient, waiter, commits };
}

/** Every render someone other than the waiter saw with the waiter's room on it. */
function roomsSeenByOthers(commits: readonly Commit[], waiter: AuthUser): Commit[] {
  return commits.filter((commit) => commit.user !== waiter.id && commit.room === WAITERS_ROOM);
}

describe('PersistedCacheGate', () => {
  it('opens a reloaded phone on the room it had, for the same waiter, with no network', async () => {
    const phone = await reloadedWaitersPhone();

    expect(phone.queryClient.getQueryData(queryKeys.board)).toBe(WAITERS_ROOM);
    expect(phone.items.has(CATALOG_CACHE_KEY)).toBe(true);
  });

  it('takes the room off the device at sign-out, and the next account never sees it', async () => {
    const phone = await reloadedWaitersPhone();

    await act(() => phone.backend.auth.signOut());
    await waitFor(() => {
      expect(phone.items.has(CATALOG_CACHE_KEY)).toBe(false);
    });
    expect(phone.queryClient.getQueryData(queryKeys.board)).toBeUndefined();
    expect(await screen.findByText(NO_ROOM)).toBeDefined();

    const cook = await act(() => signIn(phone.backend, 'Kitchen'));
    await waitFor(() => {
      expect(phone.commits.some((commit) => commit.user === cook.id)).toBe(true);
    });

    expect(screen.getByText(NO_ROOM)).toBeDefined();
    expect(roomsSeenByOthers(phone.commits, phone.waiter)).toEqual([]);
  });

  it('never draws the room for an account that signs in over the waiter without a sign-out', async () => {
    const phone = await reloadedWaitersPhone();

    const cook = await act(() => signIn(phone.backend, 'Kitchen'));
    await waitFor(() => {
      expect(phone.commits.some((commit) => commit.user === cook.id)).toBe(true);
    });

    expect(screen.getByText(NO_ROOM)).toBeDefined();
    expect(roomsSeenByOthers(phone.commits, phone.waiter)).toEqual([]);
    expect(phone.queryClient.getQueryData(queryKeys.board)).toBeUndefined();
    expect(phone.items.get(CATALOG_CACHE_KEY) ?? '').not.toContain(WAITERS_ROOM);
  });
});
