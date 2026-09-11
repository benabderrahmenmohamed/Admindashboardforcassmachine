import { describe, expect, it } from 'vitest';
import { AppError } from '@/lib/errors';
import { mm } from '@/lib/money';
import type { Product } from '@/ports';
import {
  PRICE_FORMAT_MESSAGE,
  productFormSchema,
  toProductFormValues,
  toProductInput,
  type ProductFormValues,
} from './schema';

const URL_MESSAGE = 'Enter a full http(s) URL, e.g. https://example.com/image.jpg';

function formValues(overrides: Partial<ProductFormValues> = {}): ProductFormValues {
  return {
    name: 'Harissa',
    price: '2.450',
    categoryId: 'cat-epicerie',
    barcode: '6191234567890',
    stock: '24',
    description: 'Tube 70 g',
    imageUrl: '',
    ...overrides,
  };
}

/** The messages the form shows under one field. */
function errorsFor(
  field: keyof ProductFormValues,
  overrides: Partial<ProductFormValues>,
): string[] {
  const result = productFormSchema.safeParse(formValues(overrides));
  if (result.success) {
    return [];
  }
  return result.error.issues
    .filter((issue) => issue.path[0] === field)
    .map((issue) => issue.message);
}

function thrownBy(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  return undefined;
}

const product: Product = {
  id: 'prod-lait',
  name: 'Lait demi-écrémé 1 L',
  priceMillimes: mm(1350),
  categoryId: null,
  categoryName: null,
  barcode: '',
  description: '',
  imageUrl: '',
  stock: 0,
  available: false,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

describe('productFormSchema', () => {
  describe('price', () => {
    it.each([
      { price: '12.5', millimes: 12_500 },
      { price: '12,500', millimes: 12_500 },
      { price: '0', millimes: 0 },
      { price: '1,35', millimes: 1_350 },
      { price: '0.001', millimes: 1 },
      { price: ' 7 ', millimes: 7_000 },
    ])('accepts $price as $millimes millimes', ({ price, millimes }) => {
      expect(errorsFor('price', { price })).toEqual([]);
      expect(toProductInput(formValues({ price })).priceMillimes).toBe(millimes);
    });

    it.each(['', '   '])('requires a price (%j)', (price) => {
      expect(errorsFor('price', { price })).toEqual(['Price is required']);
    });

    it('rejects a negative price', () => {
      expect(errorsFor('price', { price: '-1' })).toEqual(['Price cannot be negative']);
    });

    it.each(['1.2345', 'abc', '1 000', '1e3', '12.', '1,000.5', '12.5 DT'])(
      'rejects %j',
      (price) => {
        expect(errorsFor('price', { price })).toEqual([PRICE_FORMAT_MESSAGE]);
      },
    );
  });

  describe('stock', () => {
    it.each([
      { stock: '10', units: 10 },
      { stock: '0', units: 0 },
    ])('accepts $stock', ({ stock, units }) => {
      expect(errorsFor('stock', { stock })).toEqual([]);
      expect(toProductInput(formValues({ stock })).stock).toBe(units);
    });

    it.each([
      { stock: '', message: 'Stock is required' },
      { stock: '-1', message: 'Stock cannot be negative' },
      { stock: '2.5', message: 'Stock must be a whole number' },
      { stock: 'abc', message: 'Stock must be a whole number' },
      { stock: '1e3', message: 'Stock must be a whole number' },
    ])('rejects $stock', ({ stock, message }) => {
      expect(errorsFor('stock', { stock })).toEqual([message]);
    });
  });

  describe('name', () => {
    it.each(['', '   '])('requires a name that is not blank (%j)', (name) => {
      expect(errorsFor('name', { name })).toEqual(['Product name is required']);
    });
  });

  describe('imageUrl', () => {
    it.each(['', 'https://example.com/image.jpg'])('accepts %j', (imageUrl) => {
      expect(errorsFor('imageUrl', { imageUrl })).toEqual([]);
    });

    it.each([
      'example.com/image.jpg',
      'not a url',
      'javascript:alert(1)',
      'ftp://example.com/image.jpg',
    ])('rejects %j', (imageUrl) => {
      expect(errorsFor('imageUrl', { imageUrl })).toEqual([URL_MESSAGE]);
    });
  });

  it('asks for a name and a price on an untouched empty form', () => {
    const result = productFormSchema.safeParse(toProductFormValues());
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => [issue.path.join('.'), issue.message])).toEqual([
      ['name', 'Product name is required'],
      ['price', 'Price is required'],
    ]);
  });
});

describe('toProductInput', () => {
  it('builds the port input with the price in millimes', () => {
    expect(toProductInput(formValues({ name: '  Harissa  ', barcode: ' 6191234567890 ' }))).toEqual(
      {
        name: 'Harissa',
        priceMillimes: 2_450,
        categoryId: 'cat-epicerie',
        barcode: '6191234567890',
        description: 'Tube 70 g',
        imageUrl: '',
        stock: 24,
      },
    );
  });

  it('sends no category for the empty option', () => {
    expect(toProductInput(formValues({ categoryId: '' })).categoryId).toBeNull();
  });

  it.each([
    // As a float times 1000 these give 1004.9999999999999 and 1000.9999999999999: the conversion
    // must not go through floating point.
    { price: '1.005', millimes: 1_005 },
    { price: '1,001', millimes: 1_001 },
    { price: '999999999.999', millimes: 999_999_999_999 },
    { price: '1000000000', millimes: 1_000_000_000_000 },
  ])('converts $price exactly', ({ price, millimes }) => {
    expect(toProductInput(formValues({ price })).priceMillimes).toBe(millimes);
  });

  it('rejects a price above one billion dinars', () => {
    const message = 'Price cannot be above one billion dinars';
    expect(errorsFor('price', { price: '1000000000.001' })).toEqual([message]);
    const error = thrownBy(() => toProductInput(formValues({ price: '9007199254740.991' })));
    expect(error).toMatchObject({ code: 'VALIDATION_ERROR', message });
  });

  it('throws VALIDATION_ERROR with the issues for values the form rejects', () => {
    const error = thrownBy(() => toProductInput(formValues({ price: '1.2345' })));
    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({ code: 'VALIDATION_ERROR', message: PRICE_FORMAT_MESSAGE });
    expect((error as AppError).details?.issues).toHaveLength(1);
  });
});

describe('toProductFormValues', () => {
  it('starts an empty form with 100 in stock', () => {
    expect(toProductFormValues()).toEqual({
      name: '',
      price: '',
      categoryId: '',
      barcode: '',
      stock: '100',
      description: '',
      imageUrl: '',
    });
  });

  it('shows a product with its price in dinars and its stock as text', () => {
    expect(toProductFormValues({ ...product, categoryId: 'cat-laitier', stock: 7 })).toEqual({
      name: 'Lait demi-écrémé 1 L',
      price: '1.350',
      categoryId: 'cat-laitier',
      barcode: '',
      stock: '7',
      description: '',
      imageUrl: '',
    });
    expect(toProductFormValues(product)).toMatchObject({ categoryId: '', stock: '0' });
  });

  it('keeps the price of a product saved without changes', () => {
    for (const millimes of [0, 1, 999, 1_000, 1_350, 12_500, 999_999_999_999, 1_000_000_000_000]) {
      const input = toProductInput(
        toProductFormValues({ ...product, priceMillimes: mm(millimes) }),
      );
      expect(input.priceMillimes).toBe(millimes);
    }
  });
});
