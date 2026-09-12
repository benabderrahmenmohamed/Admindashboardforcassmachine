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
import type { RoomItem, RoomOrder } from '@/features/orders/overlay';
import { itemStage, itemTotal } from '@/features/orders/tableOrder';
import { add, ZERO, type Millimes } from '@/lib/money';

/** Rows on the table that a sale does not take: not taken off, not already paid. */
function isOwed(item: RoomItem): boolean {
  const stage = itemStage(item);
  return stage === 'unsent' || stage === 'sent' || stage === 'prepared';
}

/**
 * Why an owed row cannot be paid on this device yet:
 * - `not-on-server`: the row is this device's own add, which the server does not have — or has, but
 *   this device has not read back the name, price and quantity the server snapshotted. A sale line
 *   must match those exactly.
 * - `coming-off`: a removal written on this device goes out before any payment written after it,
 *   so the server would take the row off first.
 * - `cancelling`: the same, for a cancel of the whole table.
 * - `paying`: a sale written on this device already pays the row. Its money is in this till; a
 *   second sale for it is the same guest paying twice, and can only come back refused.
 *
 * A sale naming any of them would come back ORDER_CHANGED and stop this register's queue behind a
 * receipt number that can never be recorded. A send or a prepare changes nothing a sale checks.
 */
export type HoldReason = 'not-on-server' | 'paying' | 'coming-off' | 'cancelling';

export function holdReason(item: RoomItem): HoldReason | null {
  if (!item.fromServer) {
    return 'not-on-server';
  }
  if (item.local.paying !== null) {
    return 'paying';
  }
  if (item.local.removing !== null) {
    return item.local.removing.cause === 'cancel' ? 'cancelling' : 'coming-off';
  }
  return null;
}

/** The rows a sale may take: owed, as the server last read them, and not being taken off here. */
export function payableItems(order: RoomOrder | null): RoomItem[] {
  return (order?.items ?? []).filter((item) => isOwed(item) && holdReason(item) === null);
}

/** Owed rows the counter shows but cannot take payment for yet; see `holdReason`. */
export function heldItems(order: RoomOrder | null): RoomItem[] {
  return (order?.items ?? []).filter((item) => isOwed(item) && holdReason(item) !== null);
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

export function selectAll(items: readonly Pick<RoomItem, 'id'>[]): ItemSelection {
  return new Set(items.map((item) => item.id));
}

/**
 * The chosen rows in the order they are on the table. Rows that are no longer payable — somebody
 * else paid or removed them while the counter was looking — drop out on their own, which is what
 * keeps a stale tick from ever reaching `record_sale` and coming back as ORDER_CHANGED.
 */
export function selectedItems<Item extends Pick<RoomItem, 'id'>>(
  items: readonly Item[],
  selection: ItemSelection,
): Item[] {
  return items.filter((item) => selection.has(item.id));
}

/** A selection with everything the table no longer offers dropped, for a screen that just refreshed. */
export function pruneSelection(
  items: readonly Pick<RoomItem, 'id'>[],
  selection: ItemSelection,
): ItemSelection {
  return new Set(items.filter((item) => selection.has(item.id)).map((item) => item.id));
}

/** One cart line per chosen row, at the price snapshotted when it was ordered. */
export function cartLine(item: RoomItem): CartLine {
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
export function cartForSelection(items: readonly RoomItem[], selection: ItemSelection): Cart {
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
  items: readonly RoomItem[],
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
  /**
   * What the table would still owe afterwards: the payable rows left unticked, and the rows this
   * device added that the server does not have yet, at the prices known.
   */
  readonly remainingMillimes: Millimes;
  /** True when nothing unpaid is left, so the server closes the order. */
  readonly closesTable: boolean;
  /** Why the counter cannot take this payment yet, or null. */
  readonly problem: string | null;
}

/**
 * Everything the payment screen needs to decide from: what is being paid, what is left, and whether
 * the button may be pressed. `cart` is passed in rather than rebuilt so a discount the cashier has
 * already applied is part of the answer. `held` are the rows the counter shows but cannot charge
 * (`heldItems`): a row this device added stays on the table after this payment, so the table does
 * not close; a row being taken off does not stay.
 */
export function paymentPlan(
  items: readonly RoomItem[],
  cart: Cart,
  held: readonly RoomItem[] = [],
): PaymentPlan {
  const chosen = new Set(
    cart.lines.flatMap((line) => (line.orderItemId ? [line.orderItemId] : [])),
  );
  const rest = items.filter((item) => !chosen.has(item.id));
  const staying = held.filter((item) => holdReason(item) === 'not-on-server');
  const cartTotals = totals(cart);
  return {
    cart,
    itemIds: [...chosen],
    totalMillimes: cartTotals.totalMillimes,
    remainingMillimes: add(
      ...rest.map(itemTotal),
      ...staying.filter((item) => item.priceKnown).map(itemTotal),
    ),
    closesTable: rest.length === 0 && staying.length === 0 && chosen.size > 0,
    problem: chosen.size === 0 ? 'Choose what is being paid for' : null,
  };
}
