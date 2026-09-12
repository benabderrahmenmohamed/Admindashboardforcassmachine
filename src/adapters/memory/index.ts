import type { Backend, DemoAccount } from '@/ports';
import { createMemoryAuth } from './auth';
import { createMemoryCatalog } from './catalog';
import { createFaultInjector, type FaultInjector } from './faults';
import { createMemorySales } from './sales';
import { defaultSeed, type MemorySeed } from './seed';
import { createMemorySessions } from './sessions';
import { createMemorySettings } from './settings';
import {
  createStore,
  type MemoryReceiptVoid,
  type MemoryStockMovement,
  type MemoryStore,
  type MemoryTerminal,
} from './store';
import { randomId, type MemoryContext } from './support';
import { createMemoryTerminals } from './terminals';

export { createFaultInjector, MEMORY_OPERATIONS } from './faults';
export type { FaultInjector, MemoryOperation } from './faults';
export { DEMO_SHOP_ID, defaultSeed, OTHER_SHOP_ID } from './seed';
export type {
  MemoryAccount,
  MemoryProfile,
  MemorySeed,
  MemorySeedCategory,
  MemorySeedProduct,
  MemoryShop,
} from './seed';
export type { MemoryReceiptVoid, MemoryStockMovement, MemoryTerminal } from './store';

export interface MemoryBackendOptions {
  /** Starting data; default: `defaultSeed`. The backend copies it and never changes it. */
  readonly seed?: MemorySeed;
  /** The faults of the first client; default: an injector with no faults. */
  readonly faults?: FaultInjector;
  /** The backend's clock (createdAt, receivedAt, voidedAt); default: `() => new Date()`. */
  readonly now?: () => Date;
  /**
   * Source of the ids the backend assigns (products, categories, terminals), which must be unused
   * lowercase UUIDs; default: `crypto.randomUUID()`, or the same v4 UUID format built from
   * `crypto.getRandomValues` where randomUUID is missing (a page served over plain http).
   */
  readonly newId?: () => string;
}

export interface MemoryClientOptions {
  /** Default: an injector with no faults. */
  readonly faults?: FaultInjector;
}

export interface MemoryBackend extends Backend {
  readonly kind: 'memory';
  readonly demoAccounts: readonly DemoAccount[];
  /**
   * Another client of the same data, signed out and with its own faults, like a second browser:
   * tests use it to have an admin and a cashier of one shop, or two shops, work side by side.
   */
  connect(options?: MemoryClientOptions): MemoryBackend;
  /** For tests: state that no port reads. Returns copies. */
  readonly inspect: {
    stockMovements(): MemoryStockMovement[];
    terminals(): MemoryTerminal[];
    receiptVoids(): MemoryReceiptVoid[];
  };
}

/** What every client of one backend shares. */
interface MemoryServer {
  readonly store: MemoryStore;
  readonly now: () => Date;
  readonly newId: () => string;
}

function connectClient(server: MemoryServer, faults: FaultInjector): MemoryBackend {
  const { store } = server;
  const context: MemoryContext = {
    ...server,
    faults,
    client: { session: { status: 'anonymous' } },
  };
  return {
    kind: 'memory',
    auth: createMemoryAuth(context),
    catalog: createMemoryCatalog(context),
    sales: createMemorySales(context),
    sessions: createMemorySessions(context),
    settings: createMemorySettings(context),
    terminals: createMemoryTerminals(context),
    demoAccounts: store.accounts.flatMap(({ demoLabel, email, password }) =>
      demoLabel === null ? [] : [{ label: demoLabel, email, password }],
    ),
    connect: (options = {}) => connectClient(server, options.faults ?? createFaultInjector()),
    inspect: {
      stockMovements: () => structuredClone(store.stockMovements),
      terminals: () => Array.from(store.terminals.values(), (terminal) => ({ ...terminal })),
      receiptVoids: () =>
        Array.from(store.receiptVoids.values(), (receiptVoid) => structuredClone(receiptVoid)),
    },
  };
}

/**
 * The reference implementation of every port, held in memory: the backend for tests and for the
 * credential-free demo (VITE_BACKEND=memory). Each call builds independent data and one client of
 * it, which is all the app needs: the demo's admin and cashier sign in and out of that client.
 */
export function createMemoryBackend(options: MemoryBackendOptions = {}): MemoryBackend {
  const server: MemoryServer = {
    store: createStore(options.seed ?? defaultSeed),
    now: options.now ?? (() => new Date()),
    newId: options.newId ?? (() => randomId()),
  };
  return connectClient(server, options.faults ?? createFaultInjector());
}
