import type { Backend, DemoAccount } from '@/ports';
import { createMemoryAuth } from './auth';
import { createMemoryCatalog } from './catalog';
import { createFaultInjector, type FaultInjector } from './faults';
import { createMemoryOrders } from './orders';
import { createMemoryRealtime, type MemoryRealtime } from './realtime';
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
  type OpenOrderItemRow,
  type OpenOrderRow,
  type OrderRecordRow,
} from './store';
import { defaultConnectivity, randomId, type MemoryContext } from './support';
import { createMemoryTerminals } from './terminals';

export { createFaultInjector, MEMORY_OPERATIONS } from './faults';
export type { FaultEffect, FaultInjector, MemoryOperation } from './faults';
export { defaultConnectivity } from './support';
export { DEMO_SHOP_ID, defaultSeed, OTHER_SHOP_ID } from './seed';
export type {
  MemoryAccount,
  MemoryProfile,
  MemorySeed,
  MemorySeedCategory,
  MemorySeedProduct,
  MemorySeedTable,
  MemoryShop,
} from './seed';
export type {
  MemoryReceiptVoid,
  MemoryStockMovement,
  MemoryTerminal,
  OpenOrderItemRow,
  OpenOrderRow,
  OrderRecordRow,
} from './store';

export interface MemoryBackendOptions {
  /** Starting data; default: `defaultSeed`. The backend copies it and never changes it. */
  readonly seed?: MemorySeed;
  /** The faults of the first client; default: an injector with no faults. */
  readonly faults?: FaultInjector;
  /** The backend's clock (createdAt, receivedAt, voidedAt); default: `() => new Date()`. */
  readonly now?: () => Date;
  /**
   * Whether the device can reach the backend, read on every call; default: `defaultConnectivity`
   * (`navigator.onLine` in a browser, true elsewhere). While it answers false, every port call
   * throws NETWORK_ERROR before any check of the backend's, so the demo goes offline exactly as far
   * as a register on a real network does. Every client shares it: one device, one network.
   */
  readonly connectivity?: () => boolean;
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
    /** Every order ever opened on a table, closed and cancelled ones included. */
    orders(): OpenOrderRow[];
    /** Every line ever put on a table, removed ones included. */
    orderItems(): OpenOrderItemRow[];
    /** The order writes the backend has accepted, which is what answers a replay. */
    orderRecords(): OrderRecordRow[];
  };
}

/** What every client of one backend shares. */
interface MemoryServer {
  readonly store: MemoryStore;
  readonly now: () => Date;
  readonly newId: () => string;
  readonly connectivity: () => boolean;
  /** One emitter for the whole backend: a write on one client reaches the listeners of all. */
  readonly realtime: MemoryRealtime;
}

function connectClient(server: MemoryServer, faults: FaultInjector): MemoryBackend {
  const { store, realtime } = server;
  const context: MemoryContext = {
    ...server,
    emit: realtime.emit,
    faults,
    client: { session: { status: 'anonymous' } },
  };
  return {
    kind: 'memory',
    auth: createMemoryAuth(context),
    catalog: createMemoryCatalog(context),
    orders: createMemoryOrders(context),
    realtime: realtime.port,
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
      orders: () => Array.from(store.openOrders.values(), (order) => ({ ...order })),
      orderItems: () => Array.from(store.openOrderItems.values(), (item) => ({ ...item })),
      orderRecords: () => Array.from(store.orderRecords.values(), (written) => ({ ...written })),
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
    connectivity: options.connectivity ?? (() => defaultConnectivity()),
    realtime: createMemoryRealtime(),
  };
  return connectClient(server, options.faults ?? createFaultInjector());
}
