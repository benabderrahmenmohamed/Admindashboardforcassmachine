/**
 * Choosing what of a table is being paid for, right now, at the counter.
 *
 * A table pays in parts: four people, one leaves, the cashier ticks that person's rows and takes
 * their money, and the order closes only when nothing unpaid is left. An item is paid whole —
 * splitting one coffee between two payers is roadmap — so the choice is a set of order-item ids and
 * nothing finer.
 *
 * The cart the counter then works with has one line per chosen row rather than one per product, so
 * two coffees ordered separately can be treated separately: one offered, one paid.
 */
import {
  cartOf,
  offerLine,
  setCartDiscount,
  totals,
  type Cart,
  type CartLine,
} from '@/features/caisse/cart';
import { itemStage, itemTotal } from '@/features/orders/tableOrder';
import { add, ZERO, type Millimes } from '@/lib/money';
import type { OpenOrder, OpenOrderItem } from '@/ports';

/** The rows a sale may take: on the table, not taken off, not already paid. */
export function payableItems(order: OpenOrder | null): OpenOrderItem[] {
  return (order?.items ?? []).filter((item) => {
    const stage = itemStage(item);
    return stage === 'unsent' || stage === 'sent' || stage === 'prepared';
  });
}

/** The chosen rows, by order-item id. */
export type ItemSelection = ReadonlySet<string>;

export const noSelection: ItemSelection = new Set<string>();

export function toggleItem(selection: ItemSelection, itemId: string): ItemSelection {
  const next = new Set(selection);
  if (!next.delete(itemId)) {
    next.add(itemId);
  }
  return next;
}

export function selectAll(items: readonly OpenOrderItem[]): ItemSelection {
  return new Set(items.map((item) => item.id));
}

/**
 * The chosen rows in the order they are on the table. Rows that are no longer payable — somebody
 * else paid or removed them while the counter was looking — drop out on their own, which is what
 * keeps a stale tick from ever reaching `record_sale` and coming back as ORDER_CHANGED.
 */
export function selectedItems(
  items: readonly OpenOrderItem[],
  selection: ItemSelection,
): OpenOrderItem[] {
  return items.filter((item) => selection.has(item.id));
}

/** A selection with everything the table no longer offers dropped, for a screen that just refreshed. */
export function pruneSelection(
  items: readonly OpenOrderItem[],
  selection: ItemSelection,
): ItemSelection {
  return new Set(items.filter((item) => selection.has(item.id)).map((item) => item.id));
}

/** One cart line per chosen row, at the price snapshotted when it was ordered. */
export function cartLine(item: OpenOrderItem): CartLine {
  return {
    productId: item.productId,
    name: item.nameSnapshot,
    unitPriceMillimes: item.unitPriceMillimes,
    qty: item.qty,
    lineDiscountMillimes: ZERO,
    orderItemId: item.id,
  };
}

/** The cart for what has been ticked, with no discount on it yet. */
export function cartForSelection(items: readonly OpenOrderItem[], selection: ItemSelection): Cart {
  return cartOf(selectedItems(items, selection).map(cartLine));
}

/**
 * A cart-wide discount as the cashier types it: a percentage with up to two decimals, "." or ",",
 * which becomes basis points so `allocate` can share it across the lines without a float. Empty is
 * no discount, because clearing the box must not be an error.
 */
const PERCENT = /^(?:(\d+)(?:[.,](\d{1,2}))?|[.,](\d{1,2}))$/;

export type PercentReading =
  | { readonly ok: true; readonly basisPoints: number }
  | { readonly ok: false; readonly problem: string };

export function readDiscountPercent(text: string): PercentReading {
  const trimmed = text.trim();
  if (trimmed === '') {
    return { ok: true, basisPoints: 0 };
  }
  const match = PERCENT.exec(trimmed);
  if (!match) {
    return { ok: false, problem: 'Enter a percentage, e.g. 10 or 7,5' };
  }
  const whole = match[1] ?? '0';
  const fraction = (match[2] ?? match[3] ?? '').padEnd(2, '0');
  const basisPoints = Number(whole) * 100 + Number(fraction);
  if (basisPoints > 10_000) {
    return { ok: false, problem: 'A discount cannot be more than 100 %' };
  }
  return { ok: true, basisPoints };
}

/** An amount taken off one row, and the reason the cashier had to give for it. */
export interface LineDiscount {
  readonly millimes: Millimes;
  readonly reason: string;
}

/**
 * The whole cart the counter is working with, rebuilt from what is on the table right now.
 *
 * It is derived rather than kept, so a table that moves underneath the screen — another waiter adds
 * something, or removes the very row that was being discounted — heals itself: a discount whose row
 * is gone is dropped, and one that no longer fits the row is capped at it. Nothing here throws, so
 * a stale click can never take the payment screen down.
 */
export function buildPaymentCart(
  items: readonly OpenOrderItem[],
  selection: ItemSelection,
  discounts: ReadonlyMap<string, LineDiscount>,
  cartDiscountBasisPoints: number,
): Cart {
  const chosen = selectedItems(items, selection);
  const withLines = chosen.reduce(
    (cart, item) => {
      const discount = discounts.get(item.id);
      if (discount === undefined || discount.millimes <= 0 || discount.reason.trim() === '') {
        return cart;
      }
      const gross = itemTotal(item);
      const capped = discount.millimes > gross ? gross : discount.millimes;
      return offerLine(cart, item.id, capped, discount.reason);
    },
    cartOf(chosen.map(cartLine)),
  );
  return setCartDiscount(withLines, cartDiscountBasisPoints);
}

export interface PaymentPlan {
  readonly cart: Cart;
  /** The rows this payment closes; the order stays open for the rest. */
  readonly itemIds: readonly string[];
  readonly totalMillimes: Millimes;
  /** What the table would still owe afterwards. */
  readonly remainingMillimes: Millimes;
  /** True when nothing unpaid is left, so the server closes the order. */
  readonly closesTable: boolean;
  /** Why the counter cannot take this payment yet, or null. */
  readonly problem: string | null;
}

/**
 * Everything the payment screen needs to decide from: what is being paid, what is left, and whether
 * the button may be pressed. `cart` is passed in rather than rebuilt so a discount the cashier has
 * already applied is part of the answer.
 */
export function paymentPlan(items: readonly OpenOrderItem[], cart: Cart): PaymentPlan {
  const chosen = new Set(
    cart.lines.flatMap((line) => (line.orderItemId ? [line.orderItemId] : [])),
  );
  const rest = items.filter((item) => !chosen.has(item.id));
  const cartTotals = totals(cart);
  return {
    cart,
    itemIds: [...chosen],
    totalMillimes: cartTotals.totalMillimes,
    remainingMillimes: add(...rest.map(itemTotal)),
    closesTable: rest.length === 0 && chosen.size > 0,
    problem: chosen.size === 0 ? 'Choose what is being paid for' : null,
  };
}
