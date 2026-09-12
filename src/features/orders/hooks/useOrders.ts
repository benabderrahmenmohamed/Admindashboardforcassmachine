import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { useProducts } from '@/features/products/hooks/useProducts';
import { useOutbox, useOutboxRecords } from '@/features/sync/hooks/useOutbox';
import { useBackend } from '@/lib/backend-context';
import { deviceId } from '@/lib/deviceId';
import { AppError } from '@/lib/errors';
import { queryKeys } from '@/lib/query';
import type { DiningTableInput, OpenOrder, OrdersPort, RemovedAfterSentQuery } from '@/ports';
import { overlayBoard, type RoomBoardEntry } from '../board';
import { orderErrorMessage, type OrderAction } from '../messages';
import {
  changedTables,
  menuOf,
  overlayKitchen,
  overlayOrder,
  rowTables,
  type LocalChanges,
  type Menu,
  type RoomOrder,
  type RoomTicket,
} from '../overlay';
import {
  buildOrderCancelRecord,
  buildOrderItemAddRecord,
  buildOrderItemPrepareRecord,
  buildOrderItemRemoveRecord,
  buildOrderSendRecord,
  type OrderEnvelope,
} from '../records';

/** Every table of the shop, the admin's order, inactive ones included. */
export function useTables() {
  const { orders } = useBackend();
  return useQuery({
    queryKey: queryKeys.tableList,
    queryFn: () => orders.listTables(),
  });
}

/**
 * After the admin changes the room, everything drawn from it is read again: the list, the grid, each
 * table's order, and the kitchen's tickets, which carry a table's name.
 */
function useRoomChanged(): () => void {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.tables });
    void queryClient.invalidateQueries({ queryKey: queryKeys.kitchen });
  };
}

/** Admin: adds a table to the room. */
export function useCreateTable() {
  const { orders } = useBackend();
  const roomChanged = useRoomChanged();
  return useMutation({
    mutationFn: (input: DiningTableInput) => orders.createTable(input),
    onSuccess: roomChanged,
  });
}

/** Admin: renames a table, moves it in the room, or takes it out of service. */
export function useUpdateTable() {
  const { orders } = useBackend();
  const roomChanged = useRoomChanged();
  return useMutation({
    mutationFn: ({ id, input }: { readonly id: string; readonly input: DiningTableInput }) =>
      orders.updateTable(id, input),
    onSuccess: roomChanged,
  });
}

/** The grid as the server last read it: one entry per table, free or with what it owes. */
export function useBoard() {
  const { orders } = useBackend();
  return useQuery({
    queryKey: queryKeys.board,
    queryFn: () => orders.board(),
  });
}

/** The one definition of a table's order query, so every reader of it shares one cache entry. */
function openOrderQuery(orders: OrdersPort, tableId: string) {
  return {
    queryKey: queryKeys.openOrder(tableId),
    queryFn: () => orders.openOrder(tableId),
  };
}

/** One table's open order as the server last read it, or null when it is free. */
export function useOpenOrder(tableId: string | null) {
  const { orders } = useBackend();
  return useQuery({
    ...openOrderQuery(orders, tableId ?? ''),
    enabled: tableId !== null,
  });
}

/** Sent, unprepared items grouped by send, oldest first, as the server last read them. */
export function useKitchenTickets() {
  const { orders } = useBackend();
  return useQuery({
    queryKey: queryKeys.kitchenTickets,
    queryFn: () => orders.kitchenTickets(),
  });
}

/** The admin's report: what was taken off tables after the kitchen had been told. */
export function useRemovedAfterSent(query: RemovedAfterSentQuery) {
  const { orders } = useBackend();
  return useQuery({
    queryKey: queryKeys.removedAfterSent(query),
    queryFn: () => orders.removedAfterSent(query),
  });
}

/**
 * The menu this device has, by product: where a row it added takes its name and price from until
 * the server's snapshot is read. It is the catalog cache the menu sheet already keeps offline.
 */
function useMenu(): Menu {
  const productsQuery = useProducts();
  const products = productsQuery.data;
  return useMemo(() => menuOf(products ?? []), [products]);
}

/**
 * One table as this device draws it (`overlayOrder`): the server's order with what this device has
 * written since and the server does not show yet. `order` is null while the table is free, and
 * until `query` has read it — a screen checks `query` for loading and errors first.
 */
export function useRoomOrder(tableId: string | null) {
  const query = useOpenOrder(tableId);
  const records = useOutboxRecords();
  const menu = useMenu();
  const { data, dataUpdatedAt } = query;
  const order = useMemo(
    (): RoomOrder | null =>
      tableId === null || data === undefined
        ? null
        : overlayOrder(tableId, { data, readAt: dataUpdatedAt }, records, menu),
    [data, dataUpdatedAt, menu, records, tableId],
  );
  return { query, order };
}

const NO_CHANGED_TABLES: ReadonlyMap<string, LocalChanges> = new Map();

/**
 * The grid as this device draws it (`overlayBoard`). A table this device has changed is drawn from
 * its own order, so this reads the order of each such table too; the rest come from the grid alone.
 * `entries` is empty until `query` has read the grid.
 */
export function useRoomBoard() {
  const { orders } = useBackend();
  const queryClient = useQueryClient();
  const query = useBoard();
  const records = useOutboxRecords();
  const menu = useMenu();
  const board = query.data;

  // Nothing is placed before the grid is read: against no read at all, every ack this device ever
  // had would count as unshown, and the order of every table it ever served would be fetched.
  const changed =
    board === undefined
      ? NO_CHANGED_TABLES
      : changedTables(
          records,
          query.dataUpdatedAt,
          // A removal names a row, not a table. The orders this device has already read say which
          // table each row is on; they are taken from the cache rather than fetched, because only
          // a table that turns out to be changed needs its order, and that one is fetched below.
          rowTables(
            records,
            board.map(
              (entry) =>
                queryClient.getQueryData<OpenOrder | null>(queryKeys.openOrder(entry.table.id)) ??
                null,
            ),
          ),
        );
  const tableIds = [...changed.keys()];
  const orderQueries = useQueries({
    queries: tableIds.map((tableId) => openOrderQuery(orders, tableId)),
  });

  const drawn = new Map<string, RoomOrder | null>();
  tableIds.forEach((tableId, index) => {
    const { data, dataUpdatedAt } = orderQueries[index];
    if (data !== undefined) {
      drawn.set(tableId, overlayOrder(tableId, { data, readAt: dataUpdatedAt }, records, menu));
    }
  });

  const entries: readonly RoomBoardEntry[] =
    board === undefined ? [] : overlayBoard(board, changed, drawn);
  return { query, entries };
}

/** The kitchen's tickets as this device draws them (`overlayKitchen`); empty until `query` has read them. */
export function useRoomKitchen() {
  const query = useKitchenTickets();
  const records = useOutboxRecords();
  const { data, dataUpdatedAt } = query;
  const tickets = useMemo(
    (): readonly RoomTicket[] =>
      data === undefined ? [] : overlayKitchen({ data, readAt: dataUpdatedAt }, records),
    [data, dataUpdatedAt, records],
  );
  return { query, tickets };
}

/** A new record id, chosen on this device. */
function newRecordId(): string {
  if (typeof crypto.randomUUID !== 'function') {
    throw new AppError('CONFIG_ERROR', 'Serve the app over https to take orders.');
  }
  return crypto.randomUUID();
}

function envelope(): OrderEnvelope {
  return { id: newRecordId(), deviceId: deviceId(), createdAt: new Date().toISOString() };
}

export interface AddItemInput {
  readonly tableId: string;
  readonly productId: string;
  readonly qty: number;
  readonly note: string;
}

export interface RemoveItemInput {
  readonly itemId: string;
  readonly reason: string;
}

export interface CancelOrderInput {
  readonly tableId: string;
  readonly reason: string;
}

export interface OrderWrites {
  /** True while a record is being written to this device; the screens disable their buttons on it. */
  readonly isWriting: boolean;
  readonly addItem: (input: AddItemInput) => Promise<boolean>;
  readonly removeItem: (input: RemoveItemInput) => Promise<boolean>;
  readonly send: (tableId: string) => Promise<boolean>;
  readonly prepareItem: (itemId: string) => Promise<boolean>;
  readonly cancelOrder: (input: CancelOrderInput) => Promise<boolean>;
}

/**
 * The order records, written into this device's outbox. Each resolves true as soon as its record
 * is on the device: the queue delivers it, in the order it was written, and the screens draw it at
 * once from the queue (`useRoomOrder` and friends), so nothing here waits for the network.
 *
 * Only this device can refuse at this point — no https to take an id from, a record that does not
 * validate, a queue that could not be written — and that is toasted, worded by the error's code.
 * What the server refuses arrives later as a conflict the queue stops at, which the sync chip shows.
 */
export function useOrderWrites(): OrderWrites {
  // Kept whole rather than destructured: the outbox's methods are called on it, like a port's.
  const runtime = useOutbox();
  const [writing, setWriting] = useState(0);

  const write = useCallback(
    async (
      action: OrderAction,
      append: (recordEnvelope: OrderEnvelope) => Promise<unknown>,
    ): Promise<boolean> => {
      setWriting((count) => count + 1);
      try {
        await append(envelope());
        return true;
      } catch (error) {
        toast.error(orderErrorMessage(error, action));
        return false;
      } finally {
        setWriting((count) => count - 1);
      }
    },
    [],
  );

  return useMemo<OrderWrites>(
    () => ({
      isWriting: writing > 0,
      addItem: (input) =>
        write('add', (recordEnvelope) =>
          runtime.outbox.appendOrder('order_item_add', () =>
            buildOrderItemAddRecord(recordEnvelope, input),
          ),
        ),
      removeItem: (input) =>
        write('remove', (recordEnvelope) =>
          runtime.outbox.appendOrder('order_item_remove', () =>
            buildOrderItemRemoveRecord(recordEnvelope, input),
          ),
        ),
      send: (tableId) =>
        write('send', (recordEnvelope) =>
          runtime.outbox.appendOrder('order_send', () =>
            buildOrderSendRecord(recordEnvelope, { tableId }),
          ),
        ),
      prepareItem: (itemId) =>
        write('prepare', (recordEnvelope) =>
          runtime.outbox.appendOrder('order_item_prepare', () =>
            buildOrderItemPrepareRecord(recordEnvelope, { itemId }),
          ),
        ),
      cancelOrder: (input) =>
        write('cancel', (recordEnvelope) =>
          runtime.outbox.appendOrder('order_cancel', () =>
            buildOrderCancelRecord(recordEnvelope, input),
          ),
        ),
    }),
    [runtime, write, writing],
  );
}
