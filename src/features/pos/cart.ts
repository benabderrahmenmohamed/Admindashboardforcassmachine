import { AppError } from '@/lib/errors';
import { add, allocate, mulQty, pct, sub, ZERO, type Millimes } from '@/lib/money';

export interface CartLine {
  readonly productId: string;
  readonly name: string;
  readonly unitPriceMillimes: Millimes;
  readonly qty: number;
  /** Taken off this line before the cart discount; never more than qty × unit price. */
  readonly lineDiscountMillimes: Millimes;
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
  const existing = cart.lines.find((line) => line.productId === product.id);
  if (existing) {
    return setQty(cart, product.id, existing.qty + qty);
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
export function setQty(cart: Cart, productId: string, qty: number): Cart {
  assertWholeQty(qty);
  if (qty <= 0) {
    return removeLine(cart, productId);
  }
  return {
    ...cart,
    lines: cart.lines.map((line) => {
      if (line.productId !== productId) {
        return line;
      }
      const gross = mulQty(line.unitPriceMillimes, qty);
      const lineDiscountMillimes =
        line.lineDiscountMillimes > gross ? gross : line.lineDiscountMillimes;
      return { ...line, qty, lineDiscountMillimes };
    }),
  };
}

export function removeLine(cart: Cart, productId: string): Cart {
  return { ...cart, lines: cart.lines.filter((line) => line.productId !== productId) };
}

/** Sets a discount on one line, between zero and the line's gross amount. */
export function setLineDiscount(cart: Cart, productId: string, discount: Millimes): Cart {
  return {
    ...cart,
    lines: cart.lines.map((line) => {
      if (line.productId !== productId) {
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
