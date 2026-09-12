/**
 * What is on one table, as the waiter's table view and the caisse both read it.
 *
 * An open order is working state: rows are added, stamped when the kitchen is told, stamped again
 * when something is taken off, and finally pointed at the sale that paid them. Nothing is ever
 * deleted, so the stage of a row is read off its stamps, and every screen reads it the same way.
 */
import { add, mulQty, type Millimes } from '@/lib/money';
import type { OpenOrder, OpenOrderItem } from '@/ports';

/**
 * - `unsent`: ordered, the kitchen does not know yet.
 * - `sent`: with the kitchen.
 * - `prepared`: the kitchen is done with it.
 * - `paid`: a sale has taken it.
 * - `removed`: taken off the table; the row stays, with who took it off and why.
 */
export type ItemStage = 'unsent' | 'sent' | 'prepared' | 'paid' | 'removed';

export function itemStage(item: OpenOrderItem): ItemStage {
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
export function itemTotal(item: OpenOrderItem): Millimes {
  return mulQty(item.unitPriceMillimes, item.qty);
}

/** An item may be taken off until a sale has taken it; an already-sent one becomes a kitchen void. */
export function canRemove(item: OpenOrderItem): boolean {
  const stage = itemStage(item);
  return stage !== 'removed' && stage !== 'paid';
}

export interface TableOrderView {
  readonly orderId: string | null;
  /** Ordered, not yet with the kitchen: what the send button will stamp. */
  readonly unsent: readonly OpenOrderItem[];
  /** With the kitchen or back from it, and not yet paid. */
  readonly sent: readonly OpenOrderItem[];
  readonly paid: readonly OpenOrderItem[];
  readonly removed: readonly OpenOrderItem[];
  readonly unsentTotalMillimes: Millimes;
  /** Active and unpaid: what the caisse would be asked for right now. */
  readonly dueMillimes: Millimes;
  readonly canSend: boolean;
  readonly isEmpty: boolean;
}

/** A free table reads as an empty order rather than as nothing, so the screen has one shape. */
export function tableOrderView(order: OpenOrder | null): TableOrderView {
  const items = order?.items ?? [];
  const byStage = (...stages: readonly ItemStage[]) =>
    items.filter((item) => stages.includes(itemStage(item)));
  const unsent = byStage('unsent');
  const sent = byStage('sent', 'prepared');
  const unpaid = [...unsent, ...sent];
  return {
    orderId: order?.id ?? null,
    unsent,
    sent,
    paid: byStage('paid'),
    removed: byStage('removed'),
    unsentTotalMillimes: add(...unsent.map(itemTotal)),
    dueMillimes: add(...unpaid.map(itemTotal)),
    canSend: unsent.length > 0,
    isEmpty: items.length === 0,
  };
}

/** The rows a waiter sees at the top of the table, newest order of arrival kept. */
export function activeItems(order: OpenOrder | null): OpenOrderItem[] {
  return (order?.items ?? []).filter((item) => item.removedAt === null);
}
