import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '@/lib/errors';
import { mm } from '@/lib/money';
import type { ProductInput } from '@/ports';
import { createSupabaseCatalog } from './catalog';
import { createEdgeRequest, type FetchLike } from './http';

const PROJECT_URL = 'https://project-ref.supabase.co';
/** Written out rather than built from http.ts, so a wrong function slug or prefix fails here. */
const BASE = 'https://project-ref.supabase.co/functions/v1/make-server-81f0b18a';

interface Call {
  readonly method: string;
  readonly path: string;
  readonly authorization: string | null;
  readonly rawBody: string | undefined;
  readonly body: unknown;
}

type Route = (body: unknown) => unknown;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** A stand-in for the edge function: answers "METHOD /path" routes with JSON and records calls. */
function fakeEdgeFunction(routes: Record<string, Route>) {
  const calls: Call[] = [];
  const fetch: FetchLike = (url, init) => {
    const method = init.method ?? 'GET';
    // A URL outside the function matches no route, and its `path` shows the whole URL.
    const path = url.startsWith(BASE) ? url.slice(BASE.length) : url;
    const rawBody = typeof init.body === 'string' ? init.body : undefined;
    const body: unknown = rawBody === undefined ? undefined : JSON.parse(rawBody);
    calls.push({
      method,
      path,
      authorization: new Headers(init.headers).get('Authorization'),
      rawBody,
      body,
    });
    const route = routes[`${method} ${path}`];
    return Promise.resolve(
      route
        ? new Response(JSON.stringify(route(body)), { status: 200 })
        : new Response(JSON.stringify({ error: `No route for ${method} ${path}` }), {
            status: 404,
          }),
    );
  };
  const catalog = createSupabaseCatalog(
    createEdgeRequest({
      url: PROJECT_URL,
      anonKey: 'anon-key',
      getAccessToken: () => Promise.resolve('user-token'),
      fetch,
    }),
  );
  return { calls, catalog };
}

const categoryRows = [
  { id: 'c-drinks', name: 'Boissons', color: '#3b82f6', createdAt: '2026-01-05T09:00:00.000Z' },
  // The legacy store allows duplicate names; products take the id of the first category named so.
  { id: 'c-drinks-2', name: 'Boissons', color: '#6366f1', createdAt: '2026-01-05T09:00:30.000Z' },
  { id: 'c-grocery', name: 'Épicerie', color: '#10b981', createdAt: '2026-01-05T09:01:00.000Z' },
];

/** What the key-value store holds after years of the old app. */
const legacyProductRows = [
  // Created through the old form: the create route stored price and stock as numbers.
  {
    id: 'p-water',
    name: 'Eau minérale 1,5 L',
    price: 0.85,
    category: 'Boissons',
    barcode: '6191234000011',
    description: '',
    image: '',
    stock: 48,
    available: true,
    createdAt: '2026-01-06T10:00:00.000Z',
    updatedAt: '2026-01-06T10:00:00.000Z',
  },
  // Edited through the old form: the update route stored the form's text as it was.
  {
    id: 'p-harissa',
    name: 'Harissa',
    price: '2.4',
    category: 'Épicerie',
    barcode: '6191234000028',
    description: 'Pot 380 g',
    image: 'https://example.com/harissa.jpg',
    stock: '7',
    available: false,
    createdAt: '2026-01-06T10:05:00.000Z',
    updatedAt: '2026-02-01T08:30:00.000Z',
  },
  // An early row: server-defaulted category, and no stock, barcode, image or updatedAt.
  { id: 'p-bread', name: 'Pain', price: 0.2, category: 'uncategorized', createdAt: '2026-01-02' },
  // A category that was deleted since, and a stock that is not a whole number.
  {
    id: 'p-oil',
    name: "Huile d'olive 1 L",
    price: '18,750',
    category: 'Huiles',
    barcode: '',
    description: '',
    image: '',
    stock: '2.5',
    available: true,
    createdAt: '2026-01-07T11:00:00.000Z',
    updatedAt: '2026-01-07T11:00:00.000Z',
  },
];

/** Answers a product write the way the legacy routes do: the stored row, echoed back. */
function echoProduct(id: string, extra: Record<string, unknown>): Route {
  return (body) => ({ product: { ...(isRecord(body) ? body : {}), id, ...extra } });
}

const milk: ProductInput = {
  name: 'Lait demi-écrémé 1 L',
  priceMillimes: mm(1350),
  categoryId: 'c-drinks',
  barcode: '6191234000035',
  description: 'Bouteille',
  imageUrl: '',
  stock: 30,
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('supabase catalog', () => {
  it('reads mixed legacy product rows', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { calls, catalog } = fakeEdgeFunction({
      'GET /products': () => ({ products: legacyProductRows }),
      'GET /categories': () => ({ categories: categoryRows }),
    });

    const products = await catalog.listProducts();

    expect(products).toEqual([
      {
        id: 'p-water',
        name: 'Eau minérale 1,5 L',
        priceMillimes: 850,
        categoryId: 'c-drinks',
        categoryName: 'Boissons',
        barcode: '6191234000011',
        description: '',
        imageUrl: '',
        stock: 48,
        available: true,
        createdAt: '2026-01-06T10:00:00.000Z',
        updatedAt: '2026-01-06T10:00:00.000Z',
      },
      {
        id: 'p-harissa',
        name: 'Harissa',
        priceMillimes: 2400,
        categoryId: 'c-grocery',
        categoryName: 'Épicerie',
        barcode: '6191234000028',
        description: 'Pot 380 g',
        imageUrl: 'https://example.com/harissa.jpg',
        stock: 7,
        available: false,
        createdAt: '2026-01-06T10:05:00.000Z',
        updatedAt: '2026-02-01T08:30:00.000Z',
      },
      {
        id: 'p-bread',
        name: 'Pain',
        priceMillimes: 200,
        categoryId: null,
        categoryName: 'uncategorized',
        barcode: '',
        description: '',
        imageUrl: '',
        stock: 0,
        available: true,
        createdAt: '2026-01-02',
        updatedAt: '2026-01-02',
      },
      {
        id: 'p-oil',
        name: "Huile d'olive 1 L",
        priceMillimes: 18750,
        categoryId: null,
        categoryName: 'Huiles',
        barcode: '',
        description: '',
        imageUrl: '',
        stock: 0,
        available: true,
        createdAt: '2026-01-07T11:00:00.000Z',
        updatedAt: '2026-01-07T11:00:00.000Z',
      },
    ]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('p-bread'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('p-oil'));
    expect(calls.map((call) => call.authorization)).toEqual(['Bearer anon-key', 'Bearer anon-key']);
  });

  it('rejects a stored price it cannot read exactly, naming the product', async () => {
    const { catalog } = fakeEdgeFunction({
      'GET /products': () => ({
        products: [{ ...legacyProductRows[0], id: 'p-odd', price: 0.30000000000000004 }],
      }),
      'GET /categories': () => ({ categories: categoryRows }),
    });

    const error: unknown = await catalog.listProducts().then(
      () => null,
      (failure: unknown) => failure,
    );

    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({ code: 'VALIDATION_ERROR', details: { productId: 'p-odd' } });
  });

  it('names every product it cannot read in one error', async () => {
    const { catalog } = fakeEdgeFunction({
      'GET /products': () => ({
        products: [
          { ...legacyProductRows[0], id: 'p-odd', price: 0.30000000000000004 },
          legacyProductRows[1],
          { ...legacyProductRows[0], id: 'p-negative', price: -1 },
        ],
      }),
      'GET /categories': () => ({ categories: categoryRows }),
    });

    const error: unknown = await catalog.listProducts().then(
      () => null,
      (failure: unknown) => failure,
    );

    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({ code: 'VALIDATION_ERROR' });
    const { message, details } = error as AppError;
    expect(message).toContain('p-odd');
    expect(message).toContain('p-negative');
    expect(details?.failures).toHaveLength(2);
  });

  it('reads a whole stock the old form stored with a decimal point', async () => {
    const { catalog } = fakeEdgeFunction({
      'GET /products': () => ({
        products: [{ ...legacyProductRows[0], id: 'p-count', stock: '12.0' }],
      }),
      'GET /categories': () => ({ categories: categoryRows }),
    });

    const [product] = await catalog.listProducts();

    expect(product.stock).toBe(12);
  });

  it('creates a product with dinars as a JSON number and the category name', async () => {
    const { calls, catalog } = fakeEdgeFunction({
      'GET /categories': () => ({ categories: categoryRows }),
      'POST /products': echoProduct('p-milk', {
        available: true,
        createdAt: '2026-03-01T09:00:00.000Z',
        updatedAt: '2026-03-01T09:00:00.000Z',
      }),
    });

    const created = await catalog.createProduct(milk);

    const post = calls.find((call) => call.method === 'POST');
    expect(post?.path).toBe('/products');
    expect(post?.authorization).toBe('Bearer user-token');
    expect(post?.body).toEqual({
      name: 'Lait demi-écrémé 1 L',
      price: 1.35,
      category: 'Boissons',
      barcode: '6191234000035',
      description: 'Bouteille',
      image: '',
      stock: 30,
    });
    expect(post?.rawBody).toContain('"price":1.35,');
    expect(post?.rawBody).toContain('"stock":30');
    expect(created).toEqual({
      id: 'p-milk',
      name: 'Lait demi-écrémé 1 L',
      priceMillimes: 1350,
      categoryId: 'c-drinks',
      categoryName: 'Boissons',
      barcode: '6191234000035',
      description: 'Bouteille',
      imageUrl: '',
      stock: 30,
      available: true,
      createdAt: '2026-03-01T09:00:00.000Z',
      updatedAt: '2026-03-01T09:00:00.000Z',
    });
  });

  it('updates a product with a PUT carrying dinars as a JSON number and the category name', async () => {
    const { calls, catalog } = fakeEdgeFunction({
      'GET /categories': () => ({ categories: categoryRows }),
      'PUT /products/p-harissa': echoProduct('p-harissa', {
        available: false,
        createdAt: '2026-01-06T10:05:00.000Z',
        updatedAt: '2026-03-02T12:00:00.000Z',
      }),
    });

    const updated = await catalog.updateProduct('p-harissa', {
      name: 'Harissa',
      priceMillimes: mm(12500),
      categoryId: 'c-grocery',
      barcode: '6191234000028',
      description: 'Pot 380 g',
      imageUrl: 'https://example.com/harissa.jpg',
      stock: 12,
    });

    const put = calls.find((call) => call.method === 'PUT');
    expect(put?.authorization).toBe('Bearer user-token');
    expect(put?.body).toEqual({
      name: 'Harissa',
      price: 12.5,
      category: 'Épicerie',
      barcode: '6191234000028',
      description: 'Pot 380 g',
      image: 'https://example.com/harissa.jpg',
      stock: 12,
    });
    expect(put?.rawBody).toContain('"price":12.5,');
    expect(updated).toMatchObject({
      id: 'p-harissa',
      priceMillimes: 12500,
      categoryId: 'c-grocery',
      stock: 12,
      available: false,
    });
  });

  it.each<[number, number]>([
    [0, 0],
    [5, 0.005],
    [990, 0.99],
    [18750, 18.75],
    [123456789, 123456.789],
  ])('sends %i millimes as %d dinars', async (millimes, dinars) => {
    const { calls, catalog } = fakeEdgeFunction({
      'GET /categories': () => ({ categories: categoryRows }),
      'POST /products': echoProduct('p-new', { createdAt: '2026-03-01' }),
    });

    const created = await catalog.createProduct({ ...milk, priceMillimes: mm(millimes) });

    expect(calls.find((call) => call.method === 'POST')?.body).toMatchObject({ price: dinars });
    expect(created.priceMillimes).toBe(millimes);
  });

  it('sends an empty category name for a product without a category', async () => {
    const { calls, catalog } = fakeEdgeFunction({
      'GET /categories': () => ({ categories: categoryRows }),
      'POST /products': echoProduct('p-new', { createdAt: '2026-03-01' }),
    });

    const created = await catalog.createProduct({ ...milk, categoryId: null });

    expect(calls.find((call) => call.method === 'POST')?.body).toMatchObject({ category: '' });
    expect(created).toMatchObject({ categoryId: null, categoryName: null });
  });

  it('rejects invalid input without sending anything', async () => {
    const { calls, catalog } = fakeEdgeFunction({});

    const error: unknown = await catalog.createProduct({ ...milk, name: '  ' }).then(
      () => null,
      (failure: unknown) => failure,
    );

    expect(error).toMatchObject({ code: 'VALIDATION_ERROR', message: 'Product name is required' });
    expect(calls).toEqual([]);
  });

  it('deletes products and categories as the user', async () => {
    const { calls, catalog } = fakeEdgeFunction({
      'DELETE /products/p-water': () => ({ message: 'Product deleted successfully' }),
      'DELETE /categories/c-drinks': () => ({ message: 'Category deleted successfully' }),
    });

    await catalog.deleteProduct('p-water');
    await catalog.deleteCategory('c-drinks');

    expect(calls.map((call) => [call.method, call.path, call.authorization])).toEqual([
      ['DELETE', '/products/p-water', 'Bearer user-token'],
      ['DELETE', '/categories/c-drinks', 'Bearer user-token'],
    ]);
  });

  it('creates a category with a trimmed name', async () => {
    const { calls, catalog } = fakeEdgeFunction({
      'POST /categories': (body) => ({
        category: { ...(isRecord(body) ? body : {}), id: 'c-new', createdAt: '2026-03-03' },
      }),
    });

    const created = await catalog.createCategory({ name: '  Conserves ', color: '#f59e0b' });

    expect(calls[0].body).toEqual({ name: 'Conserves', color: '#f59e0b' });
    expect(created).toEqual({
      id: 'c-new',
      name: 'Conserves',
      color: '#f59e0b',
      createdAt: '2026-03-03',
    });
  });
});
