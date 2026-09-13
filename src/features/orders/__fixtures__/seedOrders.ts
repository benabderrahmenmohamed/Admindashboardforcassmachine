/**
 * Putting something on a table from a test, the way a waiter's phone does: through the port, with a
 * record built by the app's own builder, so a screen test starts from a table a real device could
 * have produced rather than from data poked into a backend.
 */
import type { Outbox } from '@/features/sync/outbox';
import type { OrderOutboxRecord } from '@/features/sync/types';
import type { Backend, OpenOrderItem, Product } from '@/ports';
import {
  buildOrderItemAddRecord,
  buildOrderItemRemoveRecord,
  buildOrderSendRecord,
  type OrderEnvelope,
} from '../records';

/**
 * The envelope of an order record written now on the device `backend` runs on: a fresh id, the
 * device, the moment, and whoever is signed in, because a record names who wrote it.
 */
export async function orderEnvelope(
  backend: Backend,
  deviceId = 'test-device',
): Promise<OrderEnvelope> {
  const state = await backend.auth.getState();
  if (state.status === 'anonymous') {
    throw new Error('An order record names who wrote it: sign the backend in first.');
  }
  return {
    id: crypto.randomUUID(),
    actorUserId: state.user.id,
    deviceId,
    createdAt: new Date().toISOString(),
  };
}

/** Adds `qty` of `product` to the table and answers with the row the backend made. */
export async function addToTable(
  backend: Backend,
  tableId: string,
  product: Product,
  options: { readonly qty?: number; readonly note?: string } = {},
): Promise<OpenOrderItem> {
  const { itemId } = await backend.orders.addItem(
    await buildOrderItemAddRecord(await orderEnvelope(backend), {
      tableId,
      productId: product.id,
      qty: options.qty ?? 1,
      note: options.note ?? '',
    }),
  );
  const order = await backend.orders.openOrder(tableId);
  const item = order?.items.find((candidate) => candidate.id === itemId);
  if (!item) {
    throw new Error('The backend took the item but does not list it on the table.');
  }
  return item;
}

/**
 * Adds `qty` of `product` to the table in this device's queue and nowhere else, as a waiter's tap
 * does: whether it reaches the server is up to the queue the test set up.
 */
export function queueAddToTable(
  device: { readonly outbox: Outbox; readonly backend: Backend },
  tableId: string,
  product: Product,
  options: { readonly qty?: number; readonly note?: string } = {},
): Promise<OrderOutboxRecord> {
  return device.outbox.appendOrder('order_item_add', async () =>
    buildOrderItemAddRecord(await orderEnvelope(device.backend), {
      tableId,
      productId: product.id,
      qty: options.qty ?? 1,
      note: options.note ?? '',
    }),
  );
}

/** Tells the kitchen about everything unsent on the table: one send, one ticket. */
export async function sendTable(backend: Backend, tableId: string): Promise<void> {
  await backend.orders.send(await buildOrderSendRecord(await orderEnvelope(backend), { tableId }));
}

/** Takes a row off the table, with the reason every removal has to carry. */
export async function removeFromTable(
  backend: Backend,
  itemId: string,
  reason: string,
): Promise<void> {
  await backend.orders.removeItem(
    await buildOrderItemRemoveRecord(await orderEnvelope(backend), { itemId, reason }),
  );
}
