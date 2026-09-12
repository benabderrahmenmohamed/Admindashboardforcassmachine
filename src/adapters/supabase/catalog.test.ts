import { describe, expect, it } from 'vitest';
import { mm } from '@/lib/money';
import type { ProductCreateInput } from '@/ports';
import { createSupabaseCatalog } from './catalog';
import {
  failureOf,
  fakeSupabase,
  json,
  noContent,
  profileJson,
  raised,
  routes,
  type FakeHandler,
} from './fakeSupabase';

function setup(handler: FakeHandler) {
  const { client, calls } = fakeSupabase(handler);
  return { calls, catalog: createSupabaseCatalog(client) };
}

/** Rows as `select('*, categories(name)')` returns them. */
const productRows = [
  {
    id: 'p-water',
    shop_id: 'shop-1',
    category_id: 'c-drinks',
    name: 'Eau minérale 1,5 L',
    price_millimes: 850,
    barcode: '6194000100015',
    description: '',
    image_url: '',
    stock: 120,
    available: true,
    archived_at: null,
    legacy_kv_key: null,
    created_at: '2026-09-01T08:00:00+00:00',
    updated_at: '2026-09-01T08:00:00+00:00',
    categories: { name: 'Boissons' },
  },
  {
    id: 'p-bread',
    shop_id: 'shop-1',
    category_id: null,
    name: 'Baguette',
    price_millimes: 200,
    barcode: null,
    description: 'Cuite le matin',
    image_url: 'https://example.com/baguette.jpg',
    stock: -2,
    available: false,
    archived_at: null,
    legacy_kv_key: 'product:17',
    created_at: '2026-09-01T08:05:00+00:00',
    updated_at: '2026-09-03T17:40:12.52+00:00',
    categories: null,
  },
];

/** What save_product returns (private.product_json). */
const savedMilk = {
  id: 'p-milk',
  name: 'Lait demi-écrémé 1 L',
  price_millimes: 1350,
  category_id: 'c-dairy',
  category_name: 'Produits laitiers',
  barcode: '6194000200012',
  description: 'Bouteille',
  image_url: '',
  stock: 30,
  available: true,
  created_at: '2026-09-11T09:00:00+00:00',
  updated_at: '2026-09-11T09:00:00+00:00',
};

const milk: ProductCreateInput = {
  name: 'Lait demi-écrémé 1 L',
  priceMillimes: mm(1350),
  categoryId: 'c-dairy',
  barcode: '6194000200012',
  description: 'Bouteille',
  imageUrl: '',
  openingStock: 30,
};

describe('supabase catalog', () => {
  it('lists products that are not archived, oldest first, with the name of their category', async () => {
    const { calls, catalog } = setup(routes({ 'GET /rest/v1/products': () => json(productRows) }));

    const products = await catalog.listProducts();

    expect(calls[0].query.get('select')).toBe('*,categories(name)');
    expect(calls[0].query.get('archived_at')).toBe('is.null');
    expect(calls[0].query.get('order')).toBe('created_at.asc,id.asc');
    expect(products).toEqual([
      {
        id: 'p-water',
        name: 'Eau minérale 1,5 L',
        priceMillimes: 850,
        categoryId: 'c-drinks',
        categoryName: 'Boissons',
        barcode: '6194000100015',
        description: '',
        imageUrl: '',
        stock: 120,
        available: true,
        createdAt: '2026-09-01T08:00:00+00:00',
        updatedAt: '2026-09-01T08:00:00+00:00',
      },
      {
        id: 'p-bread',
        name: 'Baguette',
        priceMillimes: 200,
        categoryId: null,
        categoryName: null,
        barcode: '',
        description: 'Cuite le matin',
        imageUrl: 'https://example.com/baguette.jpg',
        stock: -2,
        available: false,
        createdAt: '2026-09-01T08:05:00+00:00',
        updatedAt: '2026-09-03T17:40:12.52+00:00',
      },
    ]);
  });

  it('refuses a stored price above the port limit as unreadable', async () => {
    const { catalog } = setup(() =>
      json([{ ...productRows[0], price_millimes: 1_000_000_000_001 }]),
    );

    const error = await failureOf(catalog.listProducts());

    expect(error.code).toBe('VALIDATION_ERROR');
    expect(error.message).toContain('p-water');
  });

  it('creates a product through save_product, its opening stock as the stock delta', async () => {
    const { calls, catalog } = setup(
      routes({ 'POST /rest/v1/rpc/save_product': () => json(savedMilk) }),
    );

    const created = await catalog.createProduct(milk);

    expect(calls[0].body).toEqual({
      p: {
        name: 'Lait demi-écrémé 1 L',
        price_millimes: 1350,
        category_id: 'c-dairy',
        barcode: '6194000200012',
        description: 'Bouteille',
        image_url: '',
        stock_delta: 30,
      },
    });
    expect(created).toEqual({
      id: 'p-milk',
      name: 'Lait demi-écrémé 1 L',
      priceMillimes: 1350,
      categoryId: 'c-dairy',
      categoryName: 'Produits laitiers',
      barcode: '6194000200012',
      description: 'Bouteille',
      imageUrl: '',
      stock: 30,
      available: true,
      createdAt: '2026-09-11T09:00:00+00:00',
      updatedAt: '2026-09-11T09:00:00+00:00',
    });
  });

  it('updates a product with its id and the stock delta', async () => {
    const { calls, catalog } = setup(
      routes({ 'POST /rest/v1/rpc/save_product': () => json({ ...savedMilk, stock: 27 }) }),
    );

    const updated = await catalog.updateProduct('p-milk', {
      name: 'Lait demi-écrémé 1 L',
      priceMillimes: mm(1400),
      categoryId: null,
      barcode: '',
      description: 'Bouteille',
      imageUrl: '',
      stockDelta: -3,
    });

    expect(calls[0].body).toEqual({
      p: {
        id: 'p-milk',
        name: 'Lait demi-écrémé 1 L',
        price_millimes: 1400,
        category_id: null,
        barcode: '',
        description: 'Bouteille',
        image_url: '',
        stock_delta: -3,
      },
    });
    expect(updated.stock).toBe(27);
  });

  it('rejects invalid input without sending anything', async () => {
    const { calls, catalog } = setup(() => json({}));

    const error = await failureOf(catalog.createProduct({ ...milk, name: '  ' }));

    expect(error).toMatchObject({ code: 'VALIDATION_ERROR', message: 'Product name is required' });
    expect(calls).toEqual([]);
  });

  it('archives a product on delete, and passes NOT_FOUND on with the product id', async () => {
    const replies = [
      noContent(),
      raised('NOT_FOUND', 404, { product_id: 'p-gone' }, 'The product does not exist.'),
    ];
    const { calls, catalog } = setup(() => replies[calls.length - 1]);

    await catalog.deleteProduct('p-water');
    const error = await failureOf(catalog.deleteProduct('p-gone'));

    expect(calls.map((call) => [call.method, call.path, call.body])).toEqual([
      ['POST', '/rest/v1/rpc/archive_product', { p_product_id: 'p-water' }],
      ['POST', '/rest/v1/rpc/archive_product', { p_product_id: 'p-gone' }],
    ]);
    expect(error).toMatchObject({
      code: 'NOT_FOUND',
      message: 'The product does not exist.',
      details: { productId: 'p-gone' },
    });
  });

  it('lists categories oldest first', async () => {
    const { calls, catalog } = setup(
      routes({
        'GET /rest/v1/categories': () =>
          json([
            { id: 'c-drinks', name: 'Boissons', color: '#3b82f6', created_at: '2026-09-01' },
            {
              id: 'c-dairy',
              name: 'Produits laitiers',
              color: '#10b981',
              created_at: '2026-09-02',
            },
          ]),
      }),
    );

    const categories = await catalog.listCategories();

    expect(calls[0].query.get('select')).toBe('id,name,color,created_at');
    expect(calls[0].query.get('order')).toBe('created_at.asc,id.asc');
    expect(categories).toEqual([
      { id: 'c-drinks', name: 'Boissons', color: '#3b82f6', createdAt: '2026-09-01' },
      { id: 'c-dairy', name: 'Produits laitiers', color: '#10b981', createdAt: '2026-09-02' },
    ]);
  });

  it('creates a category from its trimmed name and colour only', async () => {
    const { calls, catalog } = setup(
      routes({
        'POST /rest/v1/categories': () =>
          json({ id: 'c-new', name: 'Conserves', color: '#f59e0b', created_at: '2026-09-11' }, 201),
      }),
    );

    const created = await catalog.createCategory({ name: '  Conserves ', color: '#f59e0b' });

    expect(calls[0].body).toEqual({ name: 'Conserves', color: '#f59e0b' });
    expect(calls[0].query.get('select')).toBe('id,name,color,created_at');
    expect(created).toEqual({
      id: 'c-new',
      name: 'Conserves',
      color: '#f59e0b',
      createdAt: '2026-09-11',
    });
  });

  it('passes on the FORBIDDEN of row-level security refusing a cashier’s new category', async () => {
    const { catalog } = setup(() =>
      json(
        {
          code: '42501',
          message: 'new row violates row-level security policy for table "categories"',
          details: null,
          hint: null,
        },
        403,
      ),
    );

    const error = await failureOf(catalog.createCategory({ name: 'Conserves', color: '#f59e0b' }));

    expect(error.code).toBe('FORBIDDEN');
  });

  it('deletes a category as an admin, and reports a delete that removed nothing as NOT_FOUND', async () => {
    let deleted = false;
    const { calls, catalog } = setup(
      routes({
        'POST /rest/v1/rpc/my_profile': () => json(profileJson('admin')),
        'DELETE /rest/v1/categories': () => {
          const rows = deleted ? [] : [{ id: 'c-drinks' }];
          deleted = true;
          return json(rows);
        },
      }),
    );

    await catalog.deleteCategory('c-drinks');
    const error = await failureOf(catalog.deleteCategory('c-drinks'));

    const deletes = calls.filter((call) => call.method === 'DELETE');
    expect(deletes.map((call) => [call.query.get('id'), call.query.get('select')])).toEqual([
      ['eq.c-drinks', 'id'],
      ['eq.c-drinks', 'id'],
    ]);
    expect(error).toMatchObject({ code: 'NOT_FOUND', details: { categoryId: 'c-drinks' } });
  });

  it('refuses a cashier’s category delete before sending it', async () => {
    const { calls, catalog } = setup(
      routes({ 'POST /rest/v1/rpc/my_profile': () => json(profileJson('cashier')) }),
    );

    const error = await failureOf(catalog.deleteCategory('c-drinks'));

    expect(error.code).toBe('FORBIDDEN');
    expect(calls.map((call) => call.method)).toEqual(['POST']);
  });
});
