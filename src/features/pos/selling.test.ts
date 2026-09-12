import { describe, expect, it } from 'vitest';
import { mm, toDinarsString } from '@/lib/money';
import type { Product } from '@/ports';
import { addItem, emptyCart } from './cart';
import {
  addToCartProblem,
  filterProducts,
  isSellable,
  quantityProblem,
  readCashAmount,
  readCashTender,
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

describe('readCashAmount', () => {
  it('reads dinars with "." or "," and up to three decimals, exactly', () => {
    expect(readCashAmount('50')).toEqual({ ok: true, millimes: 50_000 });
    expect(readCashAmount('12,5')).toEqual({ ok: true, millimes: 12_500 });
    expect(readCashAmount(' 0.050 ')).toEqual({ ok: true, millimes: 50 });
    expect(readCashAmount('0')).toEqual({ ok: true, millimes: 0 });
  });

  it('refuses anything it would have to guess or round', () => {
    for (const text of ['', '   ', 'abc', '1.2345', '1 000', '1,000.5', '5e3']) {
      expect(readCashAmount(text)).toEqual({
        ok: false,
        problem: 'Enter an amount in dinars, e.g. 50 or 12,500',
      });
    }
  });

  it('refuses a negative amount', () => {
    expect(readCashAmount('-1')).toEqual({ ok: false, problem: 'The amount cannot be negative' });
  });
});

describe('readCashTender', () => {
  const total = mm(5900);

  it('starts from the total, which needs no change', () => {
    expect(readCashTender(total, toDinarsString(total))).toEqual({
      ok: true,
      tenderedMillimes: 5900,
      changeMillimes: 0,
    });
  });

  it('gives back the difference for cash above the total', () => {
    expect(readCashTender(total, '10')).toEqual({
      ok: true,
      tenderedMillimes: 10_000,
      changeMillimes: 4100,
    });
  });

  it('refuses less than the total, or an amount it cannot read', () => {
    expect(readCashTender(total, '5.899')).toEqual({
      ok: false,
      problem: 'The amount tendered is less than the total',
    });
    expect(readCashTender(total, 'ten')).toMatchObject({ ok: false });
  });
});
