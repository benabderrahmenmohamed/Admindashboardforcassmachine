import { AppError } from '@/lib/errors';
import { add, allocate, mulQty, pct, sub, ZERO, type Millimes } from '@/lib/money';

/**
 * What the counter is about to take money for.
 *
 * At a café a cart is almost always a table's own rows: items are paid whole, so one order item is
 * one cart line, and two coffees ordered separately stay two lines because one of them may be
 * offered and the other paid. `orderItemId` is what makes that possible — it is the identity of a
 * line when it is there, and the product is the identity only for a line typed at the counter with
 * no table behind it.
 */
export interface CartLine {
  readonly productId: string;
  readonly name: string;
  readonly unitPriceMillimes: Millimes;
  readonly qty: number;
  /** Taken off this line before the cart discount; never more than qty × unit price. */
  readonly lineDiscountMillimes: Millimes;
  /**
   * The row of a table's open order this line pays. Absent for a line with no table behind it, and
   * what keeps two rows of the same product apart when there is.
   */
  readonly orderItemId?: string;
  /** Why this line was discounted or offered. Required by `offerLine`, the only way to set one. */
  readonly lineDiscountReason?: string;
}

export interface Cart {
  readonly lines: readonly CartLine[];
  /**
   * Cart-wide discount in basis points (100 = 1 %). It is rounded once on the subtotal and then
   * shared across the lines by `totals`, so the line totals add up to the cart total exactly.
   */
  readonly discountBasisPoints: number;
}

export interface CartProduct {
  readonly id: string;
  readonly name: string;
  readonly priceMillimes: Millimes;
}

export interface LineTotals {
  readonly productId: string;
  /** qty × unit price */
  readonly grossMillimes: Millimes;
  readonly lineDiscountMillimes: Millimes;
  /** gross − line discount; the weight this line gets when the cart discount is shared out */
  readonly netMillimes: Millimes;
  /** this line's part of the cart discount */
  readonly cartDiscountShareMillimes: Millimes;
  /** net − cart discount share */
  readonly totalMillimes: Millimes;
}

export interface CartTotals {
  readonly lines: readonly LineTotals[];
  /** sum of line nets */
  readonly subtotalMillimes: Millimes;
  /** pct(subtotal, discountBasisPoints), rounded once and shared across lines */
  readonly discountMillimes: Millimes;
  /** subtotal − discount, equal to the sum of line totals */
  readonly totalMillimes: Millimes;
  /** sum of quantities */
  readonly itemCount: number;
}

export const emptyCart: Cart = { lines: [], discountBasisPoints: 0 };

/**
 * How a line is named by everything that changes it: the order item it pays when there is one, and
 * the product otherwise. Two rows of the same product on one table are two lines, not one.
 */
export function lineKey(line: CartLine): string {
  return line.orderItemId ?? line.productId;
}

/** A cart of lines built elsewhere — a table's chosen rows — with no cart discount yet. */
export function cartOf(lines: readonly CartLine[]): Cart {
  return { lines: [...lines], discountBasisPoints: 0 };
}

function invalid(message: string): AppError {
  return new AppError('VALIDATION_ERROR', message);
}

function assertWholeQty(qty: number): void {
  if (!Number.isSafeInteger(qty)) {
    throw invalid(`Quantity must be a whole number: ${qty}`);
  }
}

/** Adds `qty` units of `product`, merging into its existing line. */
export function addItem(cart: Cart, product: CartProduct, qty = 1): Cart {
  assertWholeQty(qty);
  if (qty < 1) {
    throw invalid('Add at least one unit');
  }
  // Never merges into a line that pays a table's row: that row has its own quantity and its own fate.
  const existing = cart.lines.find(
    (line) => line.orderItemId === undefined && line.productId === product.id,
  );
  if (existing) {
    return setQty(cart, lineKey(existing), existing.qty + qty);
  }
  const line: CartLine = {
    productId: product.id,
    name: product.name,
    unitPriceMillimes: product.priceMillimes,
    qty,
    lineDiscountMillimes: ZERO,
  };
  return { ...cart, lines: [...cart.lines, line] };
}

/** Sets a line's quantity; zero or less removes the line. A line discount is capped at the new gross. */
export function setQty(cart: Cart, key: string, qty: number): Cart {
  assertWholeQty(qty);
  if (qty <= 0) {
    return removeLine(cart, key);
  }
  return {
    ...cart,
    lines: cart.lines.map((line) => {
      if (lineKey(line) !== key) {
        return line;
      }
      const gross = mulQty(line.unitPriceMillimes, qty);
      const lineDiscountMillimes =
        line.lineDiscountMillimes > gross ? gross : line.lineDiscountMillimes;
      return { ...line, qty, lineDiscountMillimes };
    }),
  };
}

export function removeLine(cart: Cart, key: string): Cart {
  return { ...cart, lines: cart.lines.filter((line) => lineKey(line) !== key) };
}

/**
 * Sets a discount on one line, between zero and the line's gross amount. Not exported: a discount
 * without a reason is a record the ledger refuses, so `offerLine` is the only way in.
 */
function setLineDiscount(cart: Cart, key: string, discount: Millimes): Cart {
  return {
    ...cart,
    lines: cart.lines.map((line) => {
      if (lineKey(line) !== key) {
        return line;
      }
      const gross = mulQty(line.unitPriceMillimes, line.qty);
      if (!Number.isSafeInteger(discount) || discount < 0 || discount > gross) {
        throw invalid(
          'A line discount must be a whole number of millimes between zero and the line amount',
        );
      }
      return { ...line, lineDiscountMillimes: discount };
    }),
  };
}

/** The same line with no reason on it at all, rather than one whose reason is `undefined`. */
function withoutReason(line: CartLine): CartLine {
  const bare: CartLine = {
    productId: line.productId,
    name: line.name,
    unitPriceMillimes: line.unitPriceMillimes,
    qty: line.qty,
    lineDiscountMillimes: line.lineDiscountMillimes,
  };
  return line.orderItemId === undefined ? bare : { ...bare, orderItemId: line.orderItemId };
}

/**
 * A discount with the reason on it: what the spec calls an "offert". A line discount only ever
 * exists at payment and always has to say why, so this is the only way the caisse sets one — and
 * taking it back off (a discount of zero) takes the reason with it.
 */
export function offerLine(cart: Cart, key: string, discount: Millimes, reason: string): Cart {
  const trimmed = reason.trim();
  if (discount > 0 && trimmed === '') {
    throw invalid('Say why this line is discounted');
  }
  const discounted = setLineDiscount(cart, key, discount);
  return {
    ...discounted,
    lines: discounted.lines.map((line) => {
      if (lineKey(line) !== key) {
        return line;
      }
      return discount === 0 ? withoutReason(line) : { ...line, lineDiscountReason: trimmed };
    }),
  };
}

/** Sets the cart-wide discount, in basis points from 0 to 10 000. */
export function setCartDiscount(cart: Cart, basisPoints: number): Cart {
  if (!Number.isSafeInteger(basisPoints) || basisPoints < 0 || basisPoints > 10_000) {
    throw invalid('The cart discount must be a whole number of basis points from 0 to 10 000');
  }
  return { ...cart, discountBasisPoints: basisPoints };
}

/**
 * The cart discount is rounded once on the subtotal, then shared across lines in proportion to
 * their net amounts (largest remainder, ties to the earlier line), so line totals add up exactly.
 */
export function totals(cart: Cart): CartTotals {
  const gross = cart.lines.map((line) => mulQty(line.unitPriceMillimes, line.qty));
  const nets = cart.lines.map((line, index) => sub(gross[index], line.lineDiscountMillimes));
  const subtotalMillimes = add(...nets);
  const discountMillimes = pct(subtotalMillimes, cart.discountBasisPoints);
  const shares = allocate(discountMillimes, nets);
  const lines = cart.lines.map((line, index): LineTotals => ({
    productId: line.productId,
    grossMillimes: gross[index],
    lineDiscountMillimes: line.lineDiscountMillimes,
    netMillimes: nets[index],
    cartDiscountShareMillimes: shares[index],
    totalMillimes: sub(nets[index], shares[index]),
  }));
  return {
    lines,
    subtotalMillimes,
    discountMillimes,
    totalMillimes: sub(subtotalMillimes, discountMillimes),
    itemCount: cart.lines.reduce((count, line) => count + line.qty, 0),
  };
}

/** Change to hand back for a cash payment. Throws VALIDATION_ERROR when the tender is short. */
export function changeDue(totalMillimes: Millimes, tenderedMillimes: Millimes): Millimes {
  if (tenderedMillimes < totalMillimes) {
    throw invalid('The amount tendered is less than the total');
  }
  return sub(tenderedMillimes, totalMillimes);
}
