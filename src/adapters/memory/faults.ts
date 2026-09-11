import { AppError } from '@/lib/errors';

/** Every port method of the memory backend, named `<port>.<method>`. */
export const MEMORY_OPERATIONS = [
  'auth.getState',
  'auth.signIn',
  'auth.signOut',
  'catalog.listProducts',
  'catalog.createProduct',
  'catalog.updateProduct',
  'catalog.deleteProduct',
  'catalog.listCategories',
  'catalog.createCategory',
  'catalog.deleteCategory',
  'settings.getSettings',
  'settings.updateSettings',
  'sales.recordSale',
] as const;

export type MemoryOperation = (typeof MEMORY_OPERATIONS)[number];

/**
 * Makes chosen port calls fail, so tests can exercise error, retry and offline paths without a
 * network. A failing call throws before it touches the store, so it changes nothing.
 */
export interface FaultInjector {
  /**
   * The next `times` calls (default 1) of `operation`, or of any operation for '*', throw `error`.
   * Faults queue up in the order they were added.
   */
  failNext(operation: MemoryOperation | '*', error: AppError, times?: number): void;
  /** Drops every pending fault. */
  clear(): void;
  /** Called first by every port method: throws the oldest pending fault that matches. */
  check(operation: MemoryOperation): void;
}

interface PendingFault {
  readonly operation: MemoryOperation | '*';
  readonly error: AppError;
  remaining: number;
}

export function createFaultInjector(): FaultInjector {
  const pending: PendingFault[] = [];
  return {
    failNext(operation, error, times = 1) {
      if (!Number.isSafeInteger(times) || times < 1) {
        throw new AppError(
          'VALIDATION_ERROR',
          `A fault needs a whole number of times >= 1: ${times}`,
        );
      }
      pending.push({ operation, error, remaining: times });
    },
    clear() {
      pending.length = 0;
    },
    check(operation) {
      const index = pending.findIndex(
        (fault) => fault.operation === operation || fault.operation === '*',
      );
      if (index === -1) {
        return;
      }
      const fault = pending[index];
      fault.remaining -= 1;
      if (fault.remaining === 0) {
        pending.splice(index, 1);
      }
      throw fault.error;
    },
  };
}
