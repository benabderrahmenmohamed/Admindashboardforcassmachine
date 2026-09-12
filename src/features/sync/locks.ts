import { AppError } from '@/lib/errors';
import type { DrainLock } from './types';

/**
 * Cross-tab exclusion with the Web Locks API. `ifAvailable` means a tab that finds the lock taken
 * skips this pass instead of queueing behind it: another tab is already draining, and every tab
 * keeps its own triggers so draining continues if that tab closes.
 */
export function createWebLocksDrainLock(
  locks: LockManager | undefined = globalThis.navigator?.locks,
): DrainLock {
  return {
    async runExclusive<T>(name: string, fn: () => Promise<T>): Promise<T | 'busy'> {
      if (!locks) {
        throw new AppError(
          'CONFIG_ERROR',
          'This browser cannot coordinate tabs. Open the register over HTTPS or on localhost.',
        );
      }
      return locks.request(name, { ifAvailable: true }, async (lock): Promise<T | 'busy'> =>
        lock ? await fn() : 'busy',
      );
    },
  };
}

/** The same contract inside one JavaScript context, for tests that run several outbox instances. */
export function createInProcessDrainLock(): DrainLock {
  const held = new Set<string>();
  return {
    async runExclusive<T>(name: string, fn: () => Promise<T>): Promise<T | 'busy'> {
      if (held.has(name)) {
        return 'busy';
      }
      held.add(name);
      try {
        return await fn();
      } finally {
        held.delete(name);
      }
    },
  };
}
