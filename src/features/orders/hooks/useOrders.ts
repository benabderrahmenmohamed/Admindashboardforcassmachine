import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useCallback, useMemo } from 'react';
import { toast } from 'sonner';
import { useBackend } from '@/lib/backend-context';
import { deviceId } from '@/lib/deviceId';
import { AppError } from '@/lib/errors';
import { queryKeys } from '@/lib/query';
import type { OrdersPort, RemovedAfterSentQuery } from '@/ports';
import { orderErrorMessage, shouldRefreshTable, type OrderAction } from '../messages';
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

/** The grid: one entry per table, free or with what it owes. */
export function useBoard() {
  const { orders } = useBackend();
  return useQuery({
    queryKey: queryKeys.board,
    queryFn: () => orders.board(),
  });
}

/** One table's open order, or null when it is free. Idle until a table is chosen. */
export function useOpenOrder(tableId: string | null) {
  const { orders } = useBackend();
  return useQuery({
    queryKey: queryKeys.openOrder(tableId ?? ''),
    queryFn: () => orders.openOrder(tableId ?? ''),
    enabled: tableId !== null,
  });
}

/** Sent, unprepared items grouped by send, oldest first. */
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

/** After any order write: the grid, the table on screen and the kitchen board are all stale. */
async function refreshRoom(queryClient: QueryClient): Promise<void> {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: queryKeys.tables }),
    queryClient.invalidateQueries({ queryKey: queryKeys.kitchen }),
  ]);
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
  /** True while any of them is in flight; the screens disable their buttons on it. */
  readonly isWriting: boolean;
  readonly addItem: (input: AddItemInput) => Promise<boolean>;
  readonly removeItem: (input: RemoveItemInput) => Promise<boolean>;
  readonly send: (tableId: string) => Promise<boolean>;
  readonly prepareItem: (itemId: string) => Promise<boolean>;
  readonly cancelOrder: (input: CancelOrderInput) => Promise<boolean>;
}

/**
 * The writes of the four order RPCs, awaited.
 *
 * This phase sends them and waits: the screen knows the answer before it moves on. The next phase
 * puts the same records — built by `../records.ts`, which is why they are built there and not here —
 * into the device's outbox and returns as soon as they are on the device. Nothing else in a screen
 * changes when that happens, because a screen already only learns "it worked" or "here is why not".
 *
 * A failure is never swallowed: it becomes a sentence chosen by the error's code, and a table that
 * moved underneath the screen is re-read before the person tries again.
 */
export function useOrderWrites(): OrderWrites {
  const { orders } = useBackend();
  const queryClient = useQueryClient();

  const write = useMutation({
    mutationFn: async ({
      run,
    }: {
      readonly action: OrderAction;
      readonly run: (port: OrdersPort) => Promise<unknown>;
    }) => run(orders),
    onSettled: () => refreshRoom(queryClient),
  });

  // Kept whole rather than destructured: `mutateAsync` is a method of the mutation, like a port's.
  const run = useCallback(
    async (action: OrderAction, task: (port: OrdersPort) => Promise<unknown>): Promise<boolean> => {
      try {
        await write.mutateAsync({ action, run: task });
        return true;
      } catch (error) {
        toast.error(orderErrorMessage(error, action));
        if (shouldRefreshTable(error)) {
          await refreshRoom(queryClient);
        }
        return false;
      }
    },
    [queryClient, write],
  );

  return useMemo<OrderWrites>(
    () => ({
      isWriting: write.isPending,
      addItem: (input) =>
        run('add', async (port) => port.addItem(await buildOrderItemAddRecord(envelope(), input))),
      removeItem: (input) =>
        run('remove', async (port) =>
          port.removeItem(await buildOrderItemRemoveRecord(envelope(), input)),
        ),
      send: (tableId) =>
        run('send', async (port) => port.send(await buildOrderSendRecord(envelope(), { tableId }))),
      prepareItem: (itemId) =>
        run('prepare', async (port) =>
          port.prepareItem(await buildOrderItemPrepareRecord(envelope(), { itemId })),
        ),
      cancelOrder: (input) =>
        run('cancel', async (port) =>
          port.cancelOrder(await buildOrderCancelRecord(envelope(), input)),
        ),
    }),
    [run, write.isPending],
  );
}
