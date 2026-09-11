/**
 * Selling rules of the register screen, kept out of the components so they run without a DOM.
 * Messages returned here are the toasts the cashier sees.
 */
import { AppError } from '@/lib/errors';
import type { PaymentMethod, Product, RecordSaleInput } from '@/ports';
import type { Cart } from './cart';

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

/**
 * The sale to record for `cart`: one line per cart line, at the unit price it was added with.
 * The sales port has no discounts yet, so a discounted cart is refused rather than recorded at a
 * total the cashier never saw.
 */
export function toRecordSaleInput(cart: Cart, paymentMethod: PaymentMethod): RecordSaleInput {
  if (
    cart.discountBasisPoints !== 0 ||
    cart.lines.some((line) => line.lineDiscountMillimes !== 0)
  ) {
    throw new AppError('VALIDATION_ERROR', 'Discounts cannot be recorded yet');
  }
  return {
    lines: cart.lines.map((line) => ({
      productId: line.productId,
      name: line.name,
      qty: line.qty,
      unitPriceMillimes: line.unitPriceMillimes,
    })),
    paymentMethod,
  };
}
