import { describe, expect, it } from 'vitest';
import { AppError } from '@/lib/errors';
import { mm } from '@/lib/money';
import type { Product } from '@/ports';
import {
  PRICE_FORMAT_MESSAGE,
  productEditFormSchema,
  productFormSchema,
  toProductCreateInput,
  toProductFormValues,
  toProductUpdateInput,
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

/** The messages the add form shows under one field. */
function errorsFor(
  field: keyof ProductFormValues,
  overrides: Partial<ProductFormValues>,
): string[] {
  return messagesFor(productFormSchema.safeParse(formValues(overrides)), field);
}

/** The messages the edit form of a product loaded with `loadedStock` shows under one field. */
function editErrorsFor(
  loadedStock: number,
  field: keyof ProductFormValues,
  overrides: Partial<ProductFormValues>,
): string[] {
  return messagesFor(productEditFormSchema(loadedStock).safeParse(formValues(overrides)), field);
}

function messagesFor(
  result: ReturnType<typeof productFormSchema.safeParse>,
  field: keyof ProductFormValues,
): string[] {
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
      expect(toProductCreateInput(formValues({ price })).priceMillimes).toBe(millimes);
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
      { stock: '-0', units: 0 },
    ])('accepts $stock as the opening stock', ({ stock, units }) => {
      expect(errorsFor('stock', { stock })).toEqual([]);
      expect(toProductCreateInput(formValues({ stock })).openingStock).toBe(units);
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

describe('productEditFormSchema', () => {
  it('keeps a stock that sales took below zero, so the product stays editable', () => {
    const values = toProductFormValues({ ...product, stock: -2 });
    expect(productEditFormSchema(-2).safeParse(values).success).toBe(true);
    expect(productFormSchema.safeParse(values).success).toBe(false);
  });

  it.each([
    { loaded: -2, stock: '-1' },
    { loaded: -2, stock: '-3' },
    { loaded: 5, stock: '-1' },
  ])('rejects a typed stock of $stock below zero (loaded $loaded)', ({ loaded, stock }) => {
    expect(editErrorsFor(loaded, 'stock', { stock })).toEqual(['Stock cannot be negative']);
  });

  it.each([
    { stock: '', message: 'Stock is required' },
    { stock: '2.5', message: 'Stock must be a whole number' },
    { stock: 'abc', message: 'Stock must be a whole number' },
  ])('still rejects $stock', ({ stock, message }) => {
    expect(editErrorsFor(5, 'stock', { stock })).toEqual([message]);
  });

  it('applies the same rules as the add form to the other fields', () => {
    expect(editErrorsFor(5, 'price', { price: '1.2345' })).toEqual([PRICE_FORMAT_MESSAGE]);
    expect(editErrorsFor(5, 'name', { name: ' ' })).toEqual(['Product name is required']);
    expect(editErrorsFor(5, 'imageUrl', { imageUrl: 'not a url' })).toEqual([URL_MESSAGE]);
  });
});

describe('toProductCreateInput', () => {
  it('builds the port input with the price in millimes and the stock as opening stock', () => {
    expect(
      toProductCreateInput(formValues({ name: '  Harissa  ', barcode: ' 6191234567890 ' })),
    ).toEqual({
      name: 'Harissa',
      priceMillimes: 2_450,
      categoryId: 'cat-epicerie',
      barcode: '6191234567890',
      description: 'Tube 70 g',
      imageUrl: '',
      openingStock: 24,
    });
  });

  it('sends no category for the empty option', () => {
    expect(toProductCreateInput(formValues({ categoryId: '' })).categoryId).toBeNull();
  });

  it.each([
    // As a float times 1000 these give 1004.9999999999999 and 1000.9999999999999: the conversion
    // must not go through floating point.
    { price: '1.005', millimes: 1_005 },
    { price: '1,001', millimes: 1_001 },
    { price: '999999999.999', millimes: 999_999_999_999 },
    { price: '1000000000', millimes: 1_000_000_000_000 },
  ])('converts $price exactly', ({ price, millimes }) => {
    expect(toProductCreateInput(formValues({ price })).priceMillimes).toBe(millimes);
  });

  it('rejects a price above one billion dinars', () => {
    const message = 'Price cannot be above one billion dinars';
    expect(errorsFor('price', { price: '1000000000.001' })).toEqual([message]);
    const error = thrownBy(() => toProductCreateInput(formValues({ price: '9007199254740.991' })));
    expect(error).toMatchObject({ code: 'VALIDATION_ERROR', message });
  });

  it('throws VALIDATION_ERROR with the issues for values the form rejects', () => {
    const error = thrownBy(() => toProductCreateInput(formValues({ price: '1.2345' })));
    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({ code: 'VALIDATION_ERROR', message: PRICE_FORMAT_MESSAGE });
    expect((error as AppError).details?.issues).toHaveLength(1);
  });

  it('refuses a negative opening stock', () => {
    const error = thrownBy(() => toProductCreateInput(formValues({ stock: '-1' })));
    expect(error).toMatchObject({ code: 'VALIDATION_ERROR', message: 'Stock cannot be negative' });
  });
});

describe('toProductUpdateInput', () => {
  it('builds the port input with the stock as the change from the loaded stock', () => {
    expect(
      toProductUpdateInput(formValues({ name: '  Harissa  ', barcode: ' 6191234567890 ' }), 20),
    ).toEqual({
      name: 'Harissa',
      priceMillimes: 2_450,
      categoryId: 'cat-epicerie',
      barcode: '6191234567890',
      description: 'Tube 70 g',
      imageUrl: '',
      stockDelta: 4,
    });
  });

  it.each([
    { loaded: 24, stock: '30', delta: 6 },
    { loaded: 24, stock: '20', delta: -4 },
    { loaded: 24, stock: '24', delta: 0 },
    { loaded: 24, stock: '0', delta: -24 },
    { loaded: 0, stock: '-0', delta: 0 },
    { loaded: -3, stock: '5', delta: 8 },
    { loaded: -3, stock: '-3', delta: 0 },
  ])('sends $delta for $stock typed over $loaded loaded', ({ loaded, stock, delta }) => {
    expect(toProductUpdateInput(formValues({ stock }), loaded).stockDelta).toBe(delta);
  });

  it('sends no category for the empty option', () => {
    expect(toProductUpdateInput(formValues({ categoryId: '' }), 24).categoryId).toBeNull();
  });

  it('throws VALIDATION_ERROR with the issues for values the edit form rejects', () => {
    const error = thrownBy(() => toProductUpdateInput(formValues({ stock: '-1' }), -2));
    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({ code: 'VALIDATION_ERROR', message: 'Stock cannot be negative' });
    expect((error as AppError).details?.issues).toHaveLength(1);
  });

  it('refuses a change too large to count exactly', () => {
    const error = thrownBy(() =>
      toProductUpdateInput(formValues({ stock: String(Number.MAX_SAFE_INTEGER) }), -1),
    );
    expect(error).toMatchObject({ code: 'VALIDATION_ERROR' });
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
    expect(toProductFormValues({ ...product, stock: -2 })).toMatchObject({ stock: '-2' });
  });

  it('keeps the price and the stock of a product saved without changes', () => {
    for (const millimes of [0, 1, 999, 1_000, 1_350, 12_500, 999_999_999_999, 1_000_000_000_000]) {
      const input = toProductUpdateInput(
        toProductFormValues({ ...product, priceMillimes: mm(millimes) }),
        product.stock,
      );
      expect(input.priceMillimes).toBe(millimes);
      expect(input.stockDelta).toBe(0);
    }
    for (const stock of [-5, 0, 7, 1_000_000]) {
      const input = toProductUpdateInput(toProductFormValues({ ...product, stock }), stock);
      expect(input.stockDelta).toBe(0);
    }
  });
});
