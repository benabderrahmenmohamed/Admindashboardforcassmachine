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
  'catalog.setAvailability',
  'catalog.adjustStock',
  'catalog.listCategories',
  'catalog.createCategory',
  'catalog.deleteCategory',
  'orders.listTables',
  'orders.createTable',
  'orders.updateTable',
  'orders.board',
  'orders.openOrder',
  'orders.kitchenTickets',
  'orders.removedAfterSent',
  'orders.addItem',
  'orders.removeItem',
  'orders.send',
  'orders.prepareItem',
  'orders.cancelOrder',
  'settings.getSettings',
  'settings.updateSettings',
  'terminals.register',
  'sessions.open',
  'sessions.close',
  'sessions.current',
  'sessions.zReport',
  'sales.recordSale',
  'sales.listSales',
  'sales.getSale',
  'sales.voidReceipt',
] as const;

export type MemoryOperation = (typeof MEMORY_OPERATIONS)[number];

/** What the fault that matched a call does to it: let it run, or drop the response it answers with. */
export type FaultEffect = 'run' | 'drop';

/**
 * The failure a call sees when its response is dropped. It says nothing about what the backend did,
 * because the device cannot know: the write may have landed, as after a real lost response.
 */
export function droppedResponse(): AppError {
  return new AppError(
    'NETWORK_ERROR',
    'The request was sent but no answer arrived. It may already be recorded.',
  );
}

/**
 * Makes chosen port calls fail, so tests can exercise error, retry and offline paths without a
 * network. A failing call throws before it touches the store, so it changes nothing; a dropped
 * response is the other half of the pair, the one a replay has to answer for.
 */
export interface FaultInjector {
  /**
   * The next `times` calls (default 1) of `operation`, or of any operation for '*', throw `error`
   * before they touch the store. Faults queue up in the order they were added, both kinds together.
   */
  failNext(operation: MemoryOperation | '*', error: AppError, times?: number): void;
  /**
   * The next `times` calls (default 1) of `operation`, or of any operation for '*', run and commit
   * and then throw NETWORK_ERROR, as a response lost on its way back: the record is stored, the
   * device never hears it, and the replay it sends next has to return the stored outcome. A call
   * the backend refuses throws its own failure instead — it wrote nothing, so there is no replay.
   */
  dropNext(operation: MemoryOperation | '*', times?: number): void;
  /** Drops every pending fault. */
  clear(): void;
  /**
   * Called by every port method once it is past the device's connectivity: throws the oldest
   * pending fault that matches, or returns 'drop' when that fault drops the response instead.
   */
  check(operation: MemoryOperation): FaultEffect;
}

interface PendingFault {
  readonly operation: MemoryOperation | '*';
  /** Thrown before the body, or null when the fault drops the response of a call that runs. */
  readonly error: AppError | null;
  remaining: number;
}

export function createFaultInjector(): FaultInjector {
  const pending: PendingFault[] = [];

  function queue(operation: MemoryOperation | '*', error: AppError | null, times: number): void {
    if (!Number.isSafeInteger(times) || times < 1) {
      throw new AppError(
        'VALIDATION_ERROR',
        `A fault needs a whole number of times >= 1: ${times}`,
      );
    }
    pending.push({ operation, error, remaining: times });
  }

  return {
    failNext(operation, error, times = 1) {
      queue(operation, error, times);
    },
    dropNext(operation, times = 1) {
      queue(operation, null, times);
    },
    clear() {
      pending.length = 0;
    },
    check(operation) {
      const index = pending.findIndex(
        (fault) => fault.operation === operation || fault.operation === '*',
      );
      if (index === -1) {
        return 'run';
      }
      const fault = pending[index];
      fault.remaining -= 1;
      if (fault.remaining === 0) {
        pending.splice(index, 1);
      }
      if (fault.error === null) {
        return 'drop';
      }
      throw fault.error;
    },
  };
}
