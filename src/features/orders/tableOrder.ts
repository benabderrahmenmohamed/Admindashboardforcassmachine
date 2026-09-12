/**
 * What is on one table, as the waiter's table view and the caisse both read it.
 *
 * An open order is working state: rows are added, stamped when the kitchen is told, stamped again
 * when something is taken off, and finally pointed at the sale that paid them. Nothing is ever
 * deleted, so the stage of a row is read off its stamps, and every screen reads it the same way.
 *
 * The rows read here are the room as this device draws it (`overlay.ts`): the server's stamps decide
 * a row's stage, and a change of this device's that the server does not show yet is a mark on the
 * row, never a stamp. Where a mark changes what a screen offers — sending, paying, taking off — it
 * is decided here.
 */
import { add, mulQty, type Millimes } from '@/lib/money';
import type { OpenOrderItem } from '@/ports';
import {
  NO_CHANGES,
  type LocalCancel,
  type LocalChanges,
  type RoomItem,
  type RoomOrder,
} from './overlay';

/**
 * - `unsent`: ordered, the kitchen does not know yet.
 * - `sent`: with the kitchen.
 * - `prepared`: the kitchen is done with it.
 * - `paid`: a sale has taken it.
 * - `removed`: taken off the table; the row stays, with who took it off and why.
 */
export type ItemStage = 'unsent' | 'sent' | 'prepared' | 'paid' | 'removed';

export function itemStage(
  item: Pick<OpenOrderItem, 'removedAt' | 'paidSaleId' | 'preparedAt' | 'sentAt'>,
): ItemStage {
  if (item.removedAt !== null) {
    return 'removed';
  }
  if (item.paidSaleId !== null) {
    return 'paid';
  }
  if (item.preparedAt !== null) {
    return 'prepared';
  }
  return item.sentAt === null ? 'unsent' : 'sent';
}

/** What one row costs: the price snapshotted when it was added, times its quantity. */
export function itemTotal(item: Pick<OpenOrderItem, 'unitPriceMillimes' | 'qty'>): Millimes {
  return mulQty(item.unitPriceMillimes, item.qty);
}

/**
 * An item may be taken off until a sale has taken it; an already-sent one becomes a kitchen void. A
 * row this device is already taking off offers nothing more, and a row only this device has can be
 * taken off too: the removal names the add's id, which is the id the row gets on the server.
 */
export function canRemove(item: RoomItem): boolean {
  const stage = itemStage(item);
  // A row a queued sale pays is as good as paid: taking it off would come back refused.
  return (
    stage !== 'removed' &&
    stage !== 'paid' &&
    item.local.removing === null &&
    item.local.paying === null
  );
}

export interface OrderTotals {
  /** Rows still on the table, as far as the server knows: one this device is taking off counts. */
  readonly activeCount: number;
  readonly unpaidCount: number;
  /**
   * What the send button stamps: rows the kitchen has not been told about, less the ones a send or
   * a removal on this device already covers. It is what a waiter still has to do.
   */
  readonly toSendCount: number;
  /**
   * Active and unpaid, at the prices known. A row this device is taking off is still owed until the
   * server has the removal; a row whose price this device does not know is counted in
   * `unpricedCount` instead of being guessed.
   */
  readonly dueMillimes: Millimes;
  readonly unpricedCount: number;
}

export function orderTotals(items: readonly RoomItem[]): OrderTotals {
  let activeCount = 0;
  let unpaidCount = 0;
  let toSendCount = 0;
  let unpricedCount = 0;
  const due: Millimes[] = [];
  for (const item of items) {
    const stage = itemStage(item);
    if (stage === 'removed') {
      continue;
    }
    activeCount += 1;
    // Paid on this device and on its way: the money is in the till, so the table no longer owes it.
    if (stage === 'paid' || item.local.paying !== null) {
      continue;
    }
    unpaidCount += 1;
    if (item.priceKnown) {
      due.push(itemTotal(item));
    } else {
      unpricedCount += 1;
    }
    if (stage === 'unsent' && item.local.sending === null && item.local.removing === null) {
      toSendCount += 1;
    }
  }
  // Through the money module, so the table's total is added as integers like every other amount.
  return { activeCount, unpaidCount, toSendCount, dueMillimes: add(...due), unpricedCount };
}

export interface TableOrderView {
  readonly orderId: string | null;
  /** Ordered, not yet with the kitchen: a send or a removal on this device marks, never moves, them. */
  readonly unsent: readonly RoomItem[];
  /** With the kitchen or back from it, and not yet paid. */
  readonly sent: readonly RoomItem[];
  readonly paid: readonly RoomItem[];
  readonly removed: readonly RoomItem[];
  /** What the unsent rows with a known price come to. */
  readonly unsentTotalMillimes: Millimes;
  /** Active and unpaid: what the caisse would be asked for once everything is on the server. */
  readonly dueMillimes: Millimes;
  /** Rows owed whose price this device does not know yet. */
  readonly unpricedCount: number;
  readonly toSendCount: number;
  readonly canSend: boolean;
  readonly isEmpty: boolean;
  readonly changes: LocalChanges;
  readonly cancelling: LocalCancel | null;
}

/** A free table reads as an empty order rather than as nothing, so the screen has one shape. */
export function tableOrderView(order: RoomOrder | null): TableOrderView {
  const items = order?.items ?? [];
  const byStage = (...stages: readonly ItemStage[]) =>
    items.filter((item) => stages.includes(itemStage(item)));
  const unsent = byStage('unsent');
  const totals = orderTotals(items);
  return {
    orderId: order?.orderId ?? null,
    unsent,
    sent: byStage('sent', 'prepared'),
    paid: byStage('paid'),
    removed: byStage('removed'),
    unsentTotalMillimes: add(...unsent.filter((item) => item.priceKnown).map(itemTotal)),
    dueMillimes: totals.dueMillimes,
    unpricedCount: totals.unpricedCount,
    toSendCount: totals.toSendCount,
    canSend: totals.toSendCount > 0,
    isEmpty: items.length === 0,
    changes: order?.changes ?? NO_CHANGES,
    cancelling: order?.cancelling ?? null,
  };
}

/** The rows a waiter sees at the top of the table, newest order of arrival kept. */
export function activeItems(order: RoomOrder | null): RoomItem[] {
  return (order?.items ?? []).filter((item) => item.removedAt === null);
}
