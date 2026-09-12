import { QueryClient } from '@tanstack/react-query';
import type { ListSalesQuery, RemovedAfterSentQuery } from '@/ports';
import { errorClass, isAppError } from './errors';

/** Prefix keys (`sales`, `sessions`, `tables`) invalidate every query under them. */
export const queryKeys = {
  products: ['products'] as const,
  categories: ['categories'] as const,
  settings: ['settings'] as const,
  /** The room: the tables themselves, the grid and each table's open order. */
  tables: ['tables'] as const,
  tableList: ['tables', 'list'] as const,
  board: ['tables', 'board'] as const,
  openOrder: (tableId: string) => ['tables', 'order', tableId] as const,
  kitchen: ['kitchen'] as const,
  kitchenTickets: ['kitchen', 'tickets'] as const,
  removedAfterSent: (query: RemovedAfterSentQuery) =>
    ['reports', 'removed-after-sent', query] as const,
  sales: ['sales'] as const,
  salesList: (query: ListSalesQuery) => ['sales', 'list', query] as const,
  sale: (id: string) => ['sales', 'detail', id] as const,
  sessions: ['sessions'] as const,
  currentSession: (terminalId: string) => ['sessions', 'current', terminalId] as const,
  zReport: (sessionId: string) => ['sessions', 'z-report', sessionId] as const,
};

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        refetchOnWindowFocus: false,
        // Retry only what can succeed later; a 403 or a validation error will not.
        retry: (failureCount, error) =>
          failureCount < 2 && isAppError(error) && errorClass(error.code) === 'retriable',
      },
      mutations: {
        retry: false,
      },
    },
  });
}
