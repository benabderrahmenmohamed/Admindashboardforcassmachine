import type { Backend, DemoAccount } from '@/ports';
import { createMemoryAuth } from './auth';
import { createMemoryCatalog } from './catalog';
import { createFaultInjector, type FaultInjector } from './faults';
import { createMemorySales } from './sales';
import { defaultSeed, type MemorySeed } from './seed';
import { createMemorySettings } from './settings';
import { createStore, type MemorySale } from './store';
import { randomId, type MemoryContext } from './support';

export { createFaultInjector, MEMORY_OPERATIONS } from './faults';
export type { FaultInjector, MemoryOperation } from './faults';
export { defaultSeed } from './seed';
export type { MemoryAccount, MemorySeed } from './seed';
export type { MemorySale } from './store';

export interface MemoryBackendOptions {
  /** Starting data; default: `defaultSeed`. The backend copies it and never changes it. */
  readonly seed?: MemorySeed;
  /** Default: an injector with no faults. */
  readonly faults?: FaultInjector;
  /** Source of createdAt and updatedAt; default: `() => new Date()`. */
  readonly now?: () => Date;
  /**
   * Source of new record ids; default: `crypto.randomUUID()`, or the same v4 UUID format built from
   * `crypto.getRandomValues` where randomUUID is missing (a page served over plain http).
   */
  readonly newId?: () => string;
}

export interface MemoryBackend extends Backend {
  readonly kind: 'memory';
  readonly demoAccounts: readonly DemoAccount[];
  /** For tests: state that no port reads yet. Returns copies. */
  readonly inspect: {
    recordedSales(): MemorySale[];
  };
}

/**
 * The reference implementation of every port, held in memory: the backend for tests and for the
 * credential-free demo (VITE_BACKEND=memory). Each call builds an independent store.
 */
export function createMemoryBackend(options: MemoryBackendOptions = {}): MemoryBackend {
  const context: MemoryContext = {
    faults: options.faults ?? createFaultInjector(),
    now: options.now ?? (() => new Date()),
    newId: options.newId ?? (() => randomId()),
  };
  const store = createStore(options.seed ?? defaultSeed);

  return {
    kind: 'memory',
    auth: createMemoryAuth(context, store),
    catalog: createMemoryCatalog(context, store),
    sales: createMemorySales(context, store),
    settings: createMemorySettings(context, store),
    demoAccounts: store.accounts.map(({ label, email, password }) => ({ label, email, password })),
    inspect: {
      recordedSales: () => Array.from(store.sales.values(), (sale) => structuredClone(sale)),
    },
  };
}
