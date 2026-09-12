import { useQueryClient, type QueryCache, type QueryKey } from '@tanstack/react-query';
import { useCallback, useSyncExternalStore } from 'react';
import type { RecordNames } from '@/features/pos/recording';
import { queryKeys } from '@/lib/query';
import type { OutboxRecord } from '../types';
import { recordNames } from './recordNames';

/** Every `queryKeys.openOrder(tableId)`, whichever tables this device opened. */
const OPEN_ORDERS: QueryKey = queryKeys.openOrder('').slice(0, 2);

const NAME_SOURCES: readonly QueryKey[] = [
  queryKeys.tableList,
  queryKeys.board,
  queryKeys.kitchenTickets,
  queryKeys.products,
];

/**
 * When the cached data a name comes from last changed. It is a string so an event that changed
 * nothing a name depends on — a fetch starting, an observer joining — compares equal and costs no
 * render.
 */
function nameSourcesVersion(cache: QueryCache): string {
  const lists = NAME_SOURCES.map(
    (queryKey) => cache.find({ queryKey, exact: true })?.state.dataUpdatedAt ?? 0,
  );
  const orders = cache
    .findAll({ queryKey: OPEN_ORDERS })
    .map((query) => `${query.queryHash}@${query.state.dataUpdatedAt}`);
  return [...lists, ...orders].join('|');
}

/**
 * The names this device has cached for what `records` point at: tables, products and the items on
 * the tables it opened. It only reads what the room's screens already loaded — it starts no request,
 * because the screen that needs it is opened on phones that are offline — and it follows the cache,
 * so a menu that finishes loading names the records on screen as it arrives.
 */
export function useRecordNames(records: readonly OutboxRecord[]): RecordNames {
  const queryClient = useQueryClient();
  const cache = queryClient.getQueryCache();
  const subscribe = useCallback((onChange: () => void) => cache.subscribe(onChange), [cache]);
  const version = useCallback(() => nameSourcesVersion(cache), [cache]);
  // Subscribed for the re-render alone: the names are read below from the cache as it is now.
  useSyncExternalStore(subscribe, version);

  return recordNames(
    {
      tableList: queryClient.getQueryData(queryKeys.tableList),
      board: queryClient.getQueryData(queryKeys.board),
      kitchenTickets: queryClient.getQueryData(queryKeys.kitchenTickets),
      products: queryClient.getQueryData(queryKeys.products),
      openOrders: cache.findAll({ queryKey: OPEN_ORDERS }).map((query) => query.state.data),
    },
    records,
  );
}
