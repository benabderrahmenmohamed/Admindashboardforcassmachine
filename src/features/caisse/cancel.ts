/**
 * Cancelling the order of a table at the counter: everything still on it comes off at once, with the
 * reason the cashier gives. The spec gives it to the cashier and the admin, and the server refuses it
 * (ORDER_CHANGED) once a row of the order is paid, because a paid row is in the ledger and only a
 * refund undoes it. No React and no I/O, so it runs without a DOM.
 */
import type { RoomOrder } from '@/features/orders/overlay';
import { activeItems, itemStage } from '@/features/orders/tableOrder';

/**
 * Why the counter does not offer to cancel a table's order:
 * - `nothing`: nothing is on the table, on the server or on its way there.
 * - `cancelling`: a cancel written on this device has not reached the server yet.
 * - `paid`: a row is paid, so the server would refuse the cancel.
 * - `paying`: a payment written on this device pays a row. It reaches the server first, so the
 *   cancel behind it would be refused all the same, and stop the queue.
 */
export type CancelBlock = 'nothing' | 'cancelling' | 'paid' | 'paying';

/** Why the order of the table drawn as `order` cannot be cancelled, or null when it can. */
export function cancelBlock(order: RoomOrder | null): CancelBlock | null {
  const onTable = activeItems(order);
  if (order === null || onTable.length === 0) {
    return 'nothing';
  }
  if (order.cancelling !== null) {
    return 'cancelling';
  }
  if (onTable.some((item) => itemStage(item) === 'paid')) {
    return 'paid';
  }
  if (onTable.some((item) => item.local.paying !== null)) {
    return 'paying';
  }
  return null;
}
