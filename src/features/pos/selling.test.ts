import { describe, expect, it } from 'vitest';
import { add, mm, mulQty } from '@/lib/money';
import { recordSaleInputSchema, type Product } from '@/ports';
import { addItem, emptyCart, setCartDiscount, setLineDiscount, setQty, totals } from './cart';
import {
  addToCartProblem,
  filterProducts,
  isSellable,
  quantityProblem,
  toRecordSaleInput,
} from './selling';

function product(overrides: Partial<Product> = {}): Product {
  return {
    id: 'p-harissa',
    name: 'Harissa Cap Bon 380 g',
    priceMillimes: mm(1350),
    categoryId: 'c-epicerie',
    categoryName: 'Épicerie',
    barcode: '6194000100017',
    description: '',
    imageUrl: '',
    stock: 5,
    available: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('isSellable', () => {
  it('needs the product to be available with stock left', () => {
    expect(isSellable(product())).toBe(true);
    expect(isSellable(product({ stock: 1 }))).toBe(true);
    expect(isSellable(product({ stock: 0 }))).toBe(false);
    expect(isSellable(product({ stock: -2 }))).toBe(false);
    expect(isSellable(product({ available: false }))).toBe(false);
  });
});

describe('filterProducts', () => {
  const harissa = product();
  const milk = product({
    id: 'p-lait',
    name: 'Lait Délice 1 L',
    categoryId: 'c-laitiers',
    categoryName: 'Produits laitiers',
    barcode: '6191',
  });
  const bag = product({ id: 'p-sachet', name: 'Sachet', categoryId: null, categoryName: null });
  const products = [harissa, milk, bag];

  it('returns every product, in order, for an empty search and no category', () => {
    expect(filterProducts(products, '', null)).toEqual([harissa, milk, bag]);
  });

  it('matches the name, ignoring case', () => {
    expect(filterProducts(products, 'LAIT', null)).toEqual([milk]);
    expect(filterProducts(products, 'a', null)).toEqual([harissa, milk, bag]);
  });

  it('searches names only, not barcodes or category names', () => {
    expect(filterProducts(products, '6191', null)).toEqual([]);
    expect(filterProducts(products, 'épicerie', null)).toEqual([]);
  });

  it('keeps the selected category by id', () => {
    expect(filterProducts(products, '', 'c-laitiers')).toEqual([milk]);
    expect(filterProducts(products, 'harissa', 'c-laitiers')).toEqual([]);
    expect(filterProducts(products, '', 'c-unknown')).toEqual([]);
  });

  it('leaves its input alone', () => {
    const input = [harissa, milk, bag];
    filterProducts(input, 'lait', 'c-laitiers');
    expect(input).toEqual([harissa, milk, bag]);
  });
});

describe('addToCartProblem', () => {
  it('refuses a product that is out of stock or unavailable', () => {
    expect(addToCartProblem(emptyCart, product({ stock: 0 }))).toBe('Product is out of stock');
    expect(addToCartProblem(emptyCart, product({ available: false }))).toBe(
      'Product is out of stock',
    );
  });

  it('allows units up to the stock, then names the limit', () => {
    const item = product({ stock: 2 });
    const once = addItem(emptyCart, item);
    const twice = addItem(once, item);
    expect(addToCartProblem(emptyCart, item)).toBeNull();
    expect(addToCartProblem(once, item)).toBeNull();
    expect(addToCartProblem(twice, item)).toBe('Only 2 items available');
  });

  it('only counts the line of the same product', () => {
    const cart = addItem(emptyCart, product({ id: 'p-other', stock: 1 }));
    expect(addToCartProblem(cart, product({ stock: 1 }))).toBeNull();
  });
});

describe('quantityProblem', () => {
  it('refuses more units than the stock', () => {
    const item = product({ stock: 3 });
    expect(quantityProblem(item, 0)).toBeNull();
    expect(quantityProblem(item, 3)).toBeNull();
    expect(quantityProblem(item, 4)).toBe('Only 3 items available');
  });
});

describe('toRecordSaleInput', () => {
  const harissa = product();
  const water = product({ id: 'p-eau', name: 'Eau Safia 1,5 L', priceMillimes: mm(650) });

  it('sends each line with its quantity and unit price in millimes', () => {
    const cart = setQty(addItem(addItem(emptyCart, harissa), water), harissa.id, 3);
    const input = toRecordSaleInput(cart, 'card');

    expect(input).toEqual({
      lines: [
        { productId: 'p-harissa', name: 'Harissa Cap Bon 380 g', qty: 3, unitPriceMillimes: 1350 },
        { productId: 'p-eau', name: 'Eau Safia 1,5 L', qty: 1, unitPriceMillimes: 650 },
      ],
      paymentMethod: 'card',
    });
    expect(recordSaleInputSchema.parse(input)).toEqual(input);
  });

  it('records exactly the total the cashier saw', () => {
    const cart = setQty(addItem(addItem(emptyCart, harissa), water), water.id, 7);
    const input = toRecordSaleInput(cart, 'cash');
    const recorded = add(...input.lines.map((line) => mulQty(line.unitPriceMillimes, line.qty)));

    expect(recorded).toBe(totals(cart).totalMillimes);
    expect(recorded).toBe(5900);
  });

  it('does not change the cart', () => {
    const cart = addItem(emptyCart, harissa);
    const snapshot = structuredClone(cart);
    toRecordSaleInput(cart, 'cash');
    expect(cart).toEqual(snapshot);
  });

  it('refuses a discounted cart, which the sales port cannot record yet', () => {
    const cart = addItem(emptyCart, harissa);
    const refused = expect.objectContaining({ code: 'VALIDATION_ERROR' }) as unknown;

    expect(() => toRecordSaleInput(setCartDiscount(cart, 500), 'cash')).toThrow(refused);
    expect(() => toRecordSaleInput(setLineDiscount(cart, harissa.id, mm(100)), 'cash')).toThrow(
      refused,
    );
  });
});
