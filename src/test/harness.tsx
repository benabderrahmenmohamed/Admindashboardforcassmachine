import { QueryClientProvider } from '@tanstack/react-query';
import { render as renderIntoDom, type RenderResult } from '@testing-library/react';
import type { ReactNode } from 'react';
import { createMemoryRouter, RouterProvider, type RouteObject } from 'react-router';
import { AuthProvider } from '@/features/auth/components/AuthProvider';
import { addItem, emptyCart, type CartProduct } from '@/features/pos/cart';
import { newRecordId, terminalContext } from '@/features/pos/recording';
import { buildSaleRecord } from '@/features/sales/records';
import { buildCloseSessionRecord, buildOpenSessionRecord } from '@/features/sessions/records';
import { OutboxContext } from '@/features/sync/hooks/outboxContext';
import { createInProcessDrainLock } from '@/features/sync/locks';
import { createOutbox, type Outbox } from '@/features/sync/outbox';
import {
  createOutboxRuntime,
  createOutboxStorage,
  type OutboxRuntime,
  type SyncSchedule,
} from '@/features/sync/runtime';
import { createPortTransport } from '@/features/sync/transport';
import type { OutboxRecord, OutboxStorage, OutboxTransport } from '@/features/sync/types';
import { registerTerminal } from '@/features/terminal/terminalStore';
import { createBackend } from '@/lib/backend';
import { BackendProvider } from '@/lib/backend-context';
import { mm, type Millimes } from '@/lib/money';
import { createQueryClient } from '@/lib/query';
import { ProtectedRoute } from '@/routes/ProtectedRoute';
import type { AuthUser, Backend, Role, ZReport } from '@/ports';

/**
 * One app, as a screen test sees it: the in-memory backend the composition root builds for
 * `VITE_BACKEND=memory` (vitest.config.ts), this device's queue, and the app's own providers around
 * whichever screen is under test.
 *
 * The queue is assembled here rather than by `OutboxProvider` because the provider builds its
 * runtime through `startOutboxRuntime`, which takes a clock and a schedule but chooses the storage
 * and the cross-tab lock itself. Everything below it is the app's: the same `createOutbox`, the
 * same storage `createOutboxStorage` picks for this backend, the same `createPortTransport` over
 * the ports, and the same `createOutboxRuntime`. Only the lock (in-process instead of Web Locks)
 * and the triggers (driven by the test instead of timers) are fakes.
 */

/** The demo accounts the memory backend offers, by the label the login page shows. */
export type DemoLabel = 'Admin' | 'Cashier';

const DEMO_ROLE: Record<DemoLabel, Role> = { Admin: 'admin', Cashier: 'cashier' };

/** The triggers of the queue, in the hands of the test: no timer here fires on its own. */
export interface TestSchedule extends SyncSchedule {
  /** Runs every callback waiting on a timer, as the timers firing would. */
  fireTimers(): void;
  /** Tells the queue the device is back online. */
  goOnline(): void;
}

function createTestSchedule(): TestSchedule {
  const intervals = new Set<() => void>();
  const timeouts = new Set<() => void>();
  const online = new Set<() => void>();
  return {
    every(_ms, run) {
      intervals.add(run);
      return () => intervals.delete(run);
    },
    after(_ms, run) {
      timeouts.add(run);
      return () => timeouts.delete(run);
    },
    onOnline(run) {
      online.add(run);
      return () => online.delete(run);
    },
    fireTimers() {
      for (const run of [...timeouts]) {
        timeouts.delete(run);
        run();
      }
      for (const run of [...intervals]) {
        run();
      }
    },
    goOnline() {
      for (const run of [...online]) {
        run();
      }
    },
  };
}

export interface HarnessOptions {
  /** Who is signed in when the screen renders; nobody by default. */
  readonly signedInAs?: DemoLabel;
  /** Registers this device as a terminal under this code first, as an admin does in Settings. */
  readonly terminalCode?: string;
  /** What the queue sends through; the ports of the backend by default. */
  readonly transport?: (backend: Backend) => OutboxTransport;
  /**
   * Whether the queue may send at all. The app answers "is someone signed in"; a test that wants
   * records to stay in the queue answers false, which is what an expired session looks like.
   */
  readonly canSend?: boolean;
}

export interface RenderOptions {
  /** Roles allowed on the screen, as the app's router declares them. */
  readonly allow?: readonly Role[];
  readonly allowOffline?: boolean;
  /** Other routes the screen can reach, so a link has somewhere to go. */
  readonly routes?: readonly RouteObject[];
  readonly initialEntry?: string;
  readonly path?: string;
}

export interface Harness {
  readonly backend: Backend;
  readonly runtime: OutboxRuntime;
  readonly outbox: Outbox;
  readonly storage: OutboxStorage;
  readonly schedule: TestSchedule;
  /** The signed-in user, for records that name who wrote them. */
  readonly user: AuthUser | null;
  /** The screen under test, behind the guard the app puts in front of it. */
  renderScreen(ui: ReactNode, options?: RenderOptions): RenderResult;
  /** A route tree of the test's own, inside the app's providers. */
  renderRoutes(routes: readonly RouteObject[], initialEntry?: string): RenderResult;
  /** Opens a session on this device, as the cashier does; returns the record. */
  openSession(openingFloatMillimes?: Millimes): Promise<OutboxRecord>;
  /** Closes the session this device opened; returns the record. */
  closeSession(sessionId: string, countedMillimes?: Millimes): Promise<OutboxRecord>;
  /** Opens `sessionId` straight on the server, without putting anything in this device's queue. */
  openSessionOnServer(sessionId: string): Promise<void>;
  /** Sells `qty` of `product` in `sessionId`, as the register does; returns the record. */
  sell(sessionId: string, product: CartProduct, qty?: number): Promise<OutboxRecord>;
  stop(): void;
}

async function signIn(backend: Backend, label: DemoLabel): Promise<AuthUser> {
  const account = backend.demoAccounts?.find((candidate) => candidate.label === label);
  if (!account) {
    throw new Error(`This backend offers no ${label} account to sign in with.`);
  }
  const user = await backend.auth.signIn({ email: account.email, password: account.password });
  if (user.role !== DEMO_ROLE[label]) {
    throw new Error(`The ${label} account is a ${user.role}, not a ${DEMO_ROLE[label]}.`);
  }
  return user;
}

export async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
  // The app's composition root: with VITE_BACKEND=memory it builds the same backend the demo runs.
  const backend = await createBackend();
  const storage = await createOutboxStorage(backend.kind);

  if (options.terminalCode !== undefined) {
    // Only an admin may register a device, whoever ends up signed in afterwards.
    await signIn(backend, 'Admin');
    const registration = await backend.terminals.register(options.terminalCode);
    await registerTerminal(storage, registration, Date.now());
  }

  let user: AuthUser | null = null;
  if (options.signedInAs !== undefined) {
    user = await signIn(backend, options.signedInAs);
  } else {
    await backend.auth.signOut();
  }

  const canSend = options.canSend ?? user !== null;
  const clock = { now: () => Date.now() };
  const outbox = createOutbox({
    storage,
    transport: options.transport ? options.transport(backend) : createPortTransport(backend),
    clock,
    random: () => 0,
    lock: createInProcessDrainLock(),
    canSend: () => canSend,
  });
  const schedule = createTestSchedule();
  const runtime = createOutboxRuntime({ outbox, storage, schedule, clock });
  runtime.start();

  const queryClient = createQueryClient();

  function providers(children: ReactNode): ReactNode {
    return (
      <BackendProvider backend={backend}>
        <QueryClientProvider client={queryClient}>
          <AuthProvider>
            <OutboxContext.Provider value={runtime}>{children}</OutboxContext.Provider>
          </AuthProvider>
        </QueryClientProvider>
      </BackendProvider>
    );
  }

  function renderRoutes(routes: readonly RouteObject[], initialEntry = '/'): RenderResult {
    const router = createMemoryRouter([...routes], { initialEntries: [initialEntry] });
    return renderIntoDom(providers(<RouterProvider router={router} />));
  }

  function requireUser(): AuthUser {
    if (!user) {
      throw new Error('Records name the person who wrote them: sign the harness in first.');
    }
    return user;
  }

  return {
    backend,
    runtime,
    outbox,
    storage,
    schedule,
    user,

    renderScreen(ui, renderOptions = {}) {
      const {
        allow = ['admin', 'cashier'],
        allowOffline = false,
        routes = [],
        path = '/',
        initialEntry = path,
      } = renderOptions;
      return renderRoutes(
        [
          {
            path,
            element: (
              <ProtectedRoute allow={allow} allowOffline={allowOffline}>
                {ui}
              </ProtectedRoute>
            ),
          },
          ...routes,
        ],
        initialEntry,
      );
    },

    renderRoutes,

    openSession(openingFloatMillimes = mm(20_000)) {
      const actor = requireUser();
      return outbox.appendSessionOpen(({ meta }) =>
        buildOpenSessionRecord({
          id: newRecordId(),
          terminal: terminalContext(meta),
          actorUserId: actor.id,
          openedAt: new Date().toISOString(),
          openingFloatMillimes,
        }),
      );
    },

    closeSession(sessionId, countedMillimes = mm(20_000)) {
      const actor = requireUser();
      const clientZReport: ZReport | null = null;
      return outbox.appendSessionClose(({ meta }) =>
        buildCloseSessionRecord({
          id: newRecordId(),
          sessionId,
          terminal: terminalContext(meta),
          actorUserId: actor.id,
          closedAt: new Date().toISOString(),
          closingCountedMillimes: countedMillimes,
          clientZReport,
        }),
      );
    },

    async openSessionOnServer(sessionId) {
      const actor = requireUser();
      const meta = await storage.readMeta();
      if (!meta) {
        throw new Error('A session belongs to a terminal: register the device first.');
      }
      await backend.sessions.open(
        await buildOpenSessionRecord({
          id: sessionId,
          terminal: terminalContext(meta),
          actorUserId: actor.id,
          openedAt: new Date().toISOString(),
          openingFloatMillimes: mm(20_000),
        }),
      );
    },

    sell(sessionId, product, qty = 1) {
      return outbox.appendSale('sale', ({ seq, meta }) =>
        buildSaleRecord(
          {
            id: newRecordId(),
            seq,
            sessionId,
            createdAt: new Date().toISOString(),
            terminal: terminalContext(meta),
          },
          addItem(emptyCart, product, qty),
          { method: 'cash' },
        ),
      );
    },

    stop() {
      runtime.stop();
    },
  };
}
