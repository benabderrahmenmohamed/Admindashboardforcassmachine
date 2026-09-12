/**
 * Selling rules of the register screen, kept out of the components so they run without a DOM.
 * Messages returned here are the toasts and field messages the cashier sees.
 */
import { tryParseTND, type Millimes } from '@/lib/money';
import type { PaymentMethod, Product } from '@/ports';
import { changeDue, type Cart } from './cart';

/** A product can go in the cart when it is marked available and has stock left. */
export function isSellable(product: Product): boolean {
  return product.available && product.stock > 0;
}

/**
 * Products whose name contains `searchTerm`, ignoring case, in the category `categoryId`, or in any
 * category when it is null. Keeps the catalog order.
 */
export function filterProducts(
  products: readonly Product[],
  searchTerm: string,
  categoryId: string | null,
): Product[] {
  const needle = searchTerm.toLowerCase();
  return products.filter(
    (product) =>
      product.name.toLowerCase().includes(needle) &&
      (categoryId === null || product.categoryId === categoryId),
  );
}

function stockLimitMessage(product: Product): string {
  return `Only ${product.stock} items available`;
}

/** Why one more unit of `product` cannot go in `cart`, or null when it can. */
export function addToCartProblem(cart: Cart, product: Product): string | null {
  if (!isSellable(product)) {
    return 'Product is out of stock';
  }
  const line = cart.lines.find((candidate) => candidate.productId === product.id);
  if (line && line.qty >= product.stock) {
    return stockLimitMessage(product);
  }
  return null;
}

/** Why a cart line of `product` cannot hold `qty` units, or null when it can. */
export function quantityProblem(product: Product, qty: number): string | null {
  return qty > product.stock ? stockLimitMessage(product) : null;
}

/** How a sale is paid, as the checkout dialog confirms it. Card is always exactly the total. */
export interface CheckoutPayment {
  readonly method: PaymentMethod;
  readonly tenderedMillimes: Millimes;
}

export type CashAmount =
  | { readonly ok: true; readonly millimes: Millimes }
  | { readonly ok: false; readonly problem: string };

/**
 * A cash amount the cashier typed (opening float, counted cash, amount tendered): dinars with up to
 * three decimals after "." or ",", zero or more. Never rounded: anything else is a problem to show.
 */
export function readCashAmount(text: string): CashAmount {
  const millimes = tryParseTND(text);
  if (millimes === null) {
    return { ok: false, problem: 'Enter an amount in dinars, e.g. 50 or 12,500' };
  }
  if (millimes < 0) {
    return { ok: false, problem: 'The amount cannot be negative' };
  }
  return { ok: true, millimes };
}

export type CashTender =
  | { readonly ok: true; readonly tenderedMillimes: Millimes; readonly changeMillimes: Millimes }
  | { readonly ok: false; readonly problem: string };

/** The cash handed over for a total of `totalMillimes`, and the change to give back. */
export function readCashTender(totalMillimes: Millimes, tenderedText: string): CashTender {
  const amount = readCashAmount(tenderedText);
  if (!amount.ok) {
    return amount;
  }
  if (amount.millimes < totalMillimes) {
    return { ok: false, problem: 'The amount tendered is less than the total' };
  }
  return {
    ok: true,
    tenderedMillimes: amount.millimes,
    changeMillimes: changeDue(totalMillimes, amount.millimes),
  };
}
