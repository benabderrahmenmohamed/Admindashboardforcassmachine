import { describe, expect, it } from 'vitest';
import { mm } from '@/lib/money';
import type { Category, Product } from '@/ports';
import { availableProducts, filterProducts, menuSections, soldOutCount } from './menu';

function product(overrides: Partial<Product> & { id: string; name: string }): Product {
  return {
    priceMillimes: mm(2_500),
    categoryId: null,
    categoryName: null,
    barcode: '',
    description: '',
    imageUrl: '',
    isAvailable: true,
    trackStock: false,
    stockQty: 0,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    ...overrides,
  };
}

function category(id: string, name: string): Category {
  return { id, name, color: '#112233', createdAt: '2026-09-01T00:00:00.000Z' };
}

describe('availableProducts', () => {
  it('keeps what is on the menu and drops what is sold out', () => {
    const menu = availableProducts([
      product({ id: 'a', name: 'Express' }),
      product({ id: 'b', name: 'Croissant', isAvailable: false }),
    ]);

    expect(menu.map((item) => item.id)).toEqual(['a']);
  });

  it('keeps an item with no stock, because stock never blocks an order at a cafe', () => {
    const menu = availableProducts([
      product({ id: 'a', name: 'Express', trackStock: true, stockQty: -4 }),
    ]);

    expect(menu.map((item) => item.id)).toEqual(['a']);
  });
});

describe('filterProducts', () => {
  const menu = [
    product({ id: 'a', name: 'Express', categoryId: 'hot' }),
    product({ id: 'b', name: 'Cappuccino', categoryId: 'hot' }),
    product({ id: 'c', name: 'Jus d orange', categoryId: 'cold' }),
  ];

  it('matches part of a name, ignoring case', () => {
    expect(filterProducts(menu, 'PRES', null).map((item) => item.id)).toEqual(['a']);
  });

  it('keeps to one category when one is chosen', () => {
    expect(filterProducts(menu, '', 'cold').map((item) => item.id)).toEqual(['c']);
  });

  it('ignores the spaces around what was typed', () => {
    expect(filterProducts(menu, '  express  ', null).map((item) => item.id)).toEqual(['a']);
  });

  it('keeps the catalog order', () => {
    expect(filterProducts(menu, '', null).map((item) => item.id)).toEqual(['a', 'b', 'c']);
  });
});

describe('menuSections', () => {
  const categories = [category('hot', 'Boissons chaudes'), category('cold', 'Boissons fraiches')];

  it('follows the order the admin gave the categories', () => {
    const sections = menuSections(
      [
        product({ id: 'c', name: 'Jus', categoryId: 'cold' }),
        product({ id: 'a', name: 'Express', categoryId: 'hot' }),
      ],
      categories,
    );

    expect(sections.map((section) => section.categoryName)).toEqual([
      'Boissons chaudes',
      'Boissons fraiches',
    ]);
  });

  it('leaves out a category with nothing in it', () => {
    const sections = menuSections(
      [product({ id: 'a', name: 'Express', categoryId: 'hot' })],
      categories,
    );

    expect(sections.map((section) => section.categoryId)).toEqual(['hot']);
  });

  it('puts what has no category last, under one heading', () => {
    const sections = menuSections(
      [product({ id: 'x', name: 'Eau' }), product({ id: 'a', name: 'Express', categoryId: 'hot' })],
      categories,
    );

    expect(sections.map((section) => section.categoryId)).toEqual(['hot', null]);
    expect(sections[1].products.map((item) => item.id)).toEqual(['x']);
  });

  it('does not lose a product whose category has been deleted', () => {
    const sections = menuSections(
      [product({ id: 'g', name: 'Ghost', categoryId: 'gone' })],
      categories,
    );

    expect(sections).toHaveLength(1);
    expect(sections[0].products.map((item) => item.id)).toEqual(['g']);
  });
});

describe('soldOutCount', () => {
  it('counts what the café has run out of today', () => {
    expect(
      soldOutCount([
        product({ id: 'a', name: 'Express' }),
        product({ id: 'b', name: 'Croissant', isAvailable: false }),
      ]),
    ).toBe(1);
  });
});
