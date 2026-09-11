import { describe, expect, it, vi } from 'vitest';
import { AppError, isAppError, type ErrorCode } from '@/lib/errors';
import { mm } from '@/lib/money';
import {
  MAX_PRICE_MILLIMES,
  type AuthState,
  type AuthUser,
  type ProductInput,
  type RecordSaleInput,
  type Role,
} from '@/ports';
import {
  createFaultInjector,
  createMemoryBackend,
  defaultSeed,
  MEMORY_OPERATIONS,
  type MemoryBackend,
  type MemoryOperation,
} from './index';
import { randomId } from './support';

const START = Date.UTC(2026, 8, 11, 9, 0, 0);
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** A backend with a clock that ticks one second per read and ids id-1, id-2, … */
function setup() {
  let ticks = 0;
  let ids = 0;
  const faults = createFaultInjector();
  const backend = createMemoryBackend({
    faults,
    now: () => {
      ticks += 1;
      return new Date(START + ticks * 1000);
    },
    newId: () => {
      ids += 1;
      return `id-${ids}`;
    },
  });
  return { backend, faults };
}

/** Who makes a call: nobody signed in, or the seed account with that role. */
type Caller = 'signed out' | Role;

/** Signs in the seed account with `role`, as the demo buttons of the login page do. */
function signInAs(backend: MemoryBackend, role: Role): Promise<AuthUser> {
  const account = defaultSeed.accounts.find((candidate) => candidate.role === role);
  if (!account) {
    return expect.unreachable(`The default seed has no ${role} account`);
  }
  return backend.auth.signIn({ email: account.email, password: account.password });
}

/** `setup()`, then signs `caller` in. */
async function setupAs(caller: Caller) {
  const result = setup();
  if (caller !== 'signed out') {
    await signInAs(result.backend, caller);
  }
  return result;
}

function isoAt(seconds: number): string {
  return new Date(START + seconds * 1000).toISOString();
}

/** 'resolved', or whatever the promise rejected with. */
function settle(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => 'resolved',
    (error: unknown) => error,
  );
}

async function failure(promise: Promise<unknown>, code: ErrorCode): Promise<AppError> {
  const outcome = await settle(promise);
  if (!isAppError(outcome)) {
    return expect.unreachable(`Expected an AppError ${code}, got ${String(outcome)}`);
  }
  expect(outcome.code).toBe(code);
  return outcome;
}

/** 'resolved', or the code of the AppError the promise rejected with. */
async function outcomeOf(promise: Promise<unknown>): Promise<'resolved' | ErrorCode> {
  const outcome = await settle(promise);
  if (outcome === 'resolved') {
    return 'resolved';
  }
  if (!isAppError(outcome)) {
    return expect.unreachable(`Expected an AppError, got ${String(outcome)}`);
  }
  return outcome.code;
}

function signedInUser(state: AuthState): AuthUser {
  if (state.status === 'anonymous') {
    return expect.unreachable('Expected a signed-in state');
  }
  return state.user;
}

/** Everything the ports let a caller see of a backend's store. */
async function observable(backend: MemoryBackend) {
  return {
    auth: await backend.auth.getState(),
    products: await backend.catalog.listProducts(),
    categories: await backend.catalog.listCategories(),
    settings: await backend.settings.getSettings(),
    sales: backend.inspect.recordedSales(),
  };
}

const dates: ProductInput = {
  name: 'Dattes Deglet Nour 500 g',
  priceMillimes: mm(6_750),
  categoryId: 'cat-epicerie',
  barcode: '6195001000044',
  description: 'Tozeur',
  imageUrl: '',
  stock: 30,
};

/**
 * One valid call per port method. On a fresh seed backend with the admin signed in they all
 * succeed, in any order that leaves auth.signOut until after the others.
 */
const callFor: Record<MemoryOperation, (backend: MemoryBackend) => Promise<unknown>> = {
  'auth.getState': (backend) => backend.auth.getState(),
  'auth.signIn': (backend) =>
    backend.auth.signIn({ email: 'admin@demo.local', password: 'demo-admin-2026' }),
  'auth.signOut': (backend) => backend.auth.signOut(),
  'catalog.listProducts': (backend) => backend.catalog.listProducts(),
  'catalog.createProduct': (backend) => backend.catalog.createProduct(dates),
  'catalog.updateProduct': (backend) => backend.catalog.updateProduct('prod-harissa', dates),
  'catalog.deleteProduct': (backend) => backend.catalog.deleteProduct('prod-thon'),
  'catalog.listCategories': (backend) => backend.catalog.listCategories(),
  'catalog.createCategory': (backend) =>
    backend.catalog.createCategory({ name: 'Surgelés', color: '#6366f1' }),
  'catalog.deleteCategory': (backend) => backend.catalog.deleteCategory('cat-boulangerie'),
  'settings.getSettings': (backend) => backend.settings.getSettings(),
  'settings.updateSettings': (backend) =>
    backend.settings.updateSettings({ receiptFooter: 'À bientôt' }),
  'sales.recordSale': (backend) =>
    backend.sales.recordSale({
      lines: [
        { productId: 'prod-eau', name: 'Eau minérale 1,5 L', qty: 1, unitPriceMillimes: mm(750) },
      ],
      paymentMethod: 'cash',
    }),
};

/** Every port method, with auth.signOut moved last so the calls before it keep their session. */
const SIGN_OUT_LAST: readonly MemoryOperation[] = [
  ...MEMORY_OPERATIONS.filter((operation) => operation !== 'auth.signOut'),
  'auth.signOut',
];

type Access = 'anyone' | 'signed in' | 'admin';

/** Who may call each port method: the check made by the legacy route it stands for. */
const accessFor: Record<MemoryOperation, Access> = {
  // Supabase Auth itself, not the edge function.
  'auth.getState': 'anyone',
  'auth.signIn': 'anyone',
  'auth.signOut': 'anyone',
  'catalog.listProducts': 'anyone', // GET /products
  'catalog.createProduct': 'admin', // POST /products
  'catalog.updateProduct': 'admin', // PUT /products/:id
  'catalog.deleteProduct': 'admin', // DELETE /products/:id
  'catalog.listCategories': 'anyone', // GET /categories
  'catalog.createCategory': 'admin', // POST /categories
  'catalog.deleteCategory': 'admin', // DELETE /categories/:id
  'settings.getSettings': 'anyone', // GET /settings
  'settings.updateSettings': 'admin', // PUT /settings
  'sales.recordSale': 'signed in', // POST /orders, then POST /orders/:id/complete
};

const CALLERS: readonly Caller[] = ['signed out', 'cashier', 'admin'];

/** How a call settles for each caller under each access rule. */
const outcomeUnder: Record<Access, Record<Caller, 'resolved' | ErrorCode>> = {
  anyone: { 'signed out': 'resolved', cashier: 'resolved', admin: 'resolved' },
  'signed in': { 'signed out': 'UNAUTHENTICATED', cashier: 'resolved', admin: 'resolved' },
  admin: { 'signed out': 'UNAUTHENTICATED', cashier: 'FORBIDDEN', admin: 'resolved' },
};

describe('default seed', () => {
  it('has what the demo screens need', () => {
    const { accounts, categories, products, settings } = defaultSeed;
    expect(accounts.map((account) => [account.label, account.email, account.role])).toEqual([
      ['Admin', 'admin@demo.local', 'admin'],
      ['Cashier', 'cashier@demo.local', 'cashier'],
    ]);
    expect(categories).toHaveLength(4);
    expect(products.length).toBeGreaterThanOrEqual(10);
    expect(products.some((product) => product.priceMillimes % 1000 !== 0)).toBe(true);
    expect(products.some((product) => product.stock === 0)).toBe(true);
    expect(products.some((product) => product.stock > 0 && product.stock <= 10)).toBe(true);
    const withBarcode = products.filter((product) => product.barcode !== '');
    expect(withBarcode.length).toBeGreaterThan(products.length / 2);
    expect(new Set(withBarcode.map((product) => product.barcode)).size).toBe(withBarcode.length);
    for (const product of products) {
      const category = categories.find((candidate) => candidate.id === product.categoryId);
      expect(product.categoryName).toBe(category?.name);
    }
    expect(settings.receiptFooter).toBe('Merci pour votre visite !');
  });

  it('is copied, so backends never share state', async () => {
    const first = createMemoryBackend();
    const second = createMemoryBackend();
    await signInAs(first, 'admin');
    const created = await first.catalog.createProduct(dates);
    expect(created.id).toMatch(UUID_V4);
    await expect(second.catalog.listProducts()).resolves.toHaveLength(defaultSeed.products.length);
    expect(defaultSeed.products).toHaveLength(12);
  });

  it('rejects a seed with a repeated id', () => {
    const [first] = defaultSeed.products;
    expect(() =>
      createMemoryBackend({ seed: { ...defaultSeed, products: [first, first] } }),
    ).toThrow(expect.objectContaining({ code: 'CONFIG_ERROR' }));
  });
});

describe('auth', () => {
  it('starts anonymous and signs a seed account in, notifying listeners', async () => {
    const { backend } = setup();
    const events: AuthState[] = [];
    backend.auth.onStateChange((state) => {
      events.push(state);
    });
    await expect(backend.auth.getState()).resolves.toEqual({ status: 'anonymous' });

    const user = await backend.auth.signIn({
      email: '  ADMIN@Demo.Local ',
      password: 'demo-admin-2026',
    });

    expect(user).toEqual({
      id: 'user-admin',
      email: 'admin@demo.local',
      name: 'Demo Admin',
      role: 'admin',
    });
    await expect(backend.auth.getState()).resolves.toEqual({ status: 'authenticated', user });
    expect(events).toEqual([{ status: 'authenticated', user }]);
  });

  it('rejects wrong credentials without changing the state', async () => {
    const { backend } = setup();
    const events: AuthState[] = [];
    backend.auth.onStateChange((state) => {
      events.push(state);
    });

    for (const credentials of [
      { email: 'admin@demo.local', password: 'wrong' },
      { email: 'admin@demo.local', password: 'DEMO-ADMIN-2026' },
      { email: 'admin@demo.local', password: 'demo-cashier-2026' },
      { email: 'nobody@demo.local', password: 'demo-admin-2026' },
    ]) {
      const error = await failure(backend.auth.signIn(credentials), 'UNAUTHENTICATED');
      expect(error.message).toBe('Invalid login credentials');
    }

    await expect(backend.auth.getState()).resolves.toEqual({ status: 'anonymous' });
    expect(events).toEqual([]);
  });

  it('signs the cashier in and out, and stops notifying after unsubscribe', async () => {
    const { backend } = setup();
    const events: AuthState[] = [];
    const unsubscribe = backend.auth.onStateChange((state) => {
      events.push(state);
    });

    const cashier = await backend.auth.signIn({
      email: 'cashier@demo.local',
      password: 'demo-cashier-2026',
    });
    expect(cashier.role).toBe('cashier');
    await backend.auth.signOut();
    await expect(backend.auth.getState()).resolves.toEqual({ status: 'anonymous' });

    unsubscribe();
    await backend.auth.signIn({ email: 'admin@demo.local', password: 'demo-admin-2026' });

    expect(events).toEqual([{ status: 'authenticated', user: cashier }, { status: 'anonymous' }]);
  });

  it('hands out copies of the user and the state, to callers and to each listener', async () => {
    const { backend } = setup();
    backend.auth.onStateChange((state) => {
      if (state.status !== 'anonymous') {
        state.user.role = 'admin';
      }
    });
    const seen: AuthState[] = [];
    backend.auth.onStateChange((state) => {
      seen.push(state);
    });

    const user = await backend.auth.signIn({
      email: 'cashier@demo.local',
      password: 'demo-cashier-2026',
    });
    const cashier = structuredClone(user);
    expect(cashier.role).toBe('cashier');
    user.role = 'admin';

    const state = await backend.auth.getState();
    expect(state).toEqual({ status: 'authenticated', user: cashier });
    expect(seen).toEqual([{ status: 'authenticated', user: cashier }]);
    signedInUser(state).role = 'admin';

    await expect(backend.auth.getState()).resolves.toEqual({
      status: 'authenticated',
      user: cashier,
    });
  });

  it('offers the seed accounts as demo accounts', () => {
    const { backend } = setup();
    expect(backend.kind).toBe('memory');
    expect(backend.demoAccounts).toEqual([
      { label: 'Admin', email: 'admin@demo.local', password: 'demo-admin-2026' },
      { label: 'Cashier', email: 'cashier@demo.local', password: 'demo-cashier-2026' },
    ]);
  });
});

describe('catalog', () => {
  it('lists the seed products in insertion order, as copies', async () => {
    const { backend } = setup();
    const products = await backend.catalog.listProducts();
    expect(products).toEqual(defaultSeed.products);

    products[0].name = 'Changed';
    products[0].stock = 999;

    const again = await backend.catalog.listProducts();
    expect(again[0]).toEqual(defaultSeed.products[0]);
  });

  it('creates a product with an id, timestamps, availability and the category name', async () => {
    const { backend } = await setupAs('admin');
    const created = await backend.catalog.createProduct(dates);

    expect(created).toEqual({
      ...dates,
      id: 'id-1',
      categoryName: 'Épicerie',
      available: true,
      createdAt: isoAt(1),
      updatedAt: isoAt(1),
    });
    const products = await backend.catalog.listProducts();
    expect(products.at(-1)).toEqual(created);
    expect(products).toHaveLength(defaultSeed.products.length + 1);

    const loose = await backend.catalog.createProduct({ ...dates, categoryId: null, stock: 0 });
    expect(loose).toMatchObject({ categoryId: null, categoryName: null, available: true });
  });

  it('hands out copies of the products it creates and updates', async () => {
    const { backend } = await setupAs('admin');
    const created = await backend.catalog.createProduct(dates);
    const updated = await backend.catalog.updateProduct('prod-harissa', dates);
    const createdCopy = structuredClone(created);
    const updatedCopy = structuredClone(updated);

    created.stock = 999;
    created.categoryName = 'Changed';
    updated.stock = 999;
    updated.name = 'Changed';

    const products = await backend.catalog.listProducts();
    expect(products.find((product) => product.id === createdCopy.id)).toEqual(createdCopy);
    expect(products.find((product) => product.id === 'prod-harissa')).toEqual(updatedCopy);
  });

  it('rejects invalid input with the Zod issues and stores nothing', async () => {
    const { backend } = await setupAs('admin');
    const error = await failure(
      backend.catalog.createProduct({ ...dates, name: '   ', priceMillimes: mm(-1), stock: -1 }),
      'VALIDATION_ERROR',
    );
    expect(error.details?.issues).toHaveLength(3);
    expect(error.message).toBe('Product name is required');

    await failure(
      backend.catalog.updateProduct('prod-harissa', { ...dates, imageUrl: 'not a url' }),
      'VALIDATION_ERROR',
    );
    await expect(backend.catalog.listProducts()).resolves.toEqual(defaultSeed.products);
  });

  it('rejects a category id that does not exist', async () => {
    const { backend } = await setupAs('admin');
    await failure(
      backend.catalog.createProduct({ ...dates, categoryId: 'cat-missing' }),
      'NOT_FOUND',
    );
    await expect(backend.catalog.listProducts()).resolves.toHaveLength(defaultSeed.products.length);
  });

  it('updates the editable fields and keeps id, availability, createdAt and position', async () => {
    const { backend } = await setupAs('admin');
    const before = await backend.catalog.listProducts();
    const index = before.findIndex((product) => product.id === 'prod-thon');
    expect(before[index]).toMatchObject({ stock: 0, available: false });

    const input: ProductInput = {
      name: "Thon à l'huile d'olive 400 g",
      priceMillimes: mm(11_250),
      categoryId: 'cat-laitiers',
      barcode: '',
      description: 'Grand format',
      imageUrl: 'https://example.com/thon.jpg',
      stock: 12,
    };
    const updated = await backend.catalog.updateProduct('prod-thon', input);

    expect(updated).toEqual({
      ...input,
      id: 'prod-thon',
      categoryName: 'Produits laitiers',
      available: false,
      createdAt: before[index].createdAt,
      updatedAt: isoAt(1),
    });
    const after = await backend.catalog.listProducts();
    expect(after[index]).toEqual(updated);
    expect(after).toHaveLength(before.length);
  });

  it('throws NOT_FOUND for unknown product ids', async () => {
    const { backend } = await setupAs('admin');
    const error = await failure(backend.catalog.updateProduct('missing', dates), 'NOT_FOUND');
    expect(error.details).toEqual({ id: 'missing' });
    await failure(backend.catalog.deleteProduct('missing'), 'NOT_FOUND');
  });

  it('deletes a product', async () => {
    const { backend } = await setupAs('admin');
    await backend.catalog.deleteProduct('prod-harissa');
    const products = await backend.catalog.listProducts();
    expect(products.map((product) => product.id)).not.toContain('prod-harissa');
    expect(products).toHaveLength(defaultSeed.products.length - 1);
    await failure(backend.catalog.deleteProduct('prod-harissa'), 'NOT_FOUND');
  });

  it('creates categories with a trimmed name and allows duplicate names', async () => {
    const { backend } = await setupAs('admin');
    const first = await backend.catalog.createCategory({ name: '  Surgelés ', color: '#6366f1' });
    const second = await backend.catalog.createCategory({ name: 'Surgelés', color: '#8b5cf6' });

    expect(first).toEqual({ id: 'id-1', name: 'Surgelés', color: '#6366f1', createdAt: isoAt(1) });
    expect(second).toMatchObject({ id: 'id-2', name: 'Surgelés' });
    const categories = await backend.catalog.listCategories();
    expect(categories.map((category) => category.id)).toEqual([
      ...defaultSeed.categories.map((category) => category.id),
      'id-1',
      'id-2',
    ]);

    await failure(
      backend.catalog.createCategory({ name: ' ', color: '#6366f1' }),
      'VALIDATION_ERROR',
    );
    await failure(
      backend.catalog.createCategory({ name: 'Épices', color: 'blue' }),
      'VALIDATION_ERROR',
    );
  });

  it('hands out copies of the categories it lists and creates', async () => {
    const { backend } = await setupAs('admin');
    const created = await backend.catalog.createCategory({ name: 'Surgelés', color: '#6366f1' });
    const categories = await backend.catalog.listCategories();
    const expected = structuredClone(categories);
    expect(expected.at(-1)).toEqual(created);

    created.name = 'Changed';
    categories[0].name = 'x';
    categories[0].color = '#000000';

    await expect(backend.catalog.listCategories()).resolves.toEqual(expected);
  });

  it('deletes a category and clears it on its products only', async () => {
    const { backend } = await setupAs('admin');
    await backend.catalog.deleteCategory('cat-boissons');

    const categories = await backend.catalog.listCategories();
    expect(categories.map((category) => category.id)).not.toContain('cat-boissons');
    const products = await backend.catalog.listProducts();
    const drinks = defaultSeed.products.filter((product) => product.categoryId === 'cat-boissons');
    expect(drinks.length).toBeGreaterThan(0);
    for (const seeded of defaultSeed.products) {
      const product = products.find((candidate) => candidate.id === seeded.id);
      if (seeded.categoryId === 'cat-boissons') {
        expect(product).toEqual({ ...seeded, categoryId: null, categoryName: null });
      } else {
        expect(product).toEqual(seeded);
      }
    }

    await failure(backend.catalog.deleteCategory('cat-boissons'), 'NOT_FOUND');
  });
});

describe('settings', () => {
  it('reads and updates the receipt footer, handing out copies', async () => {
    const { backend } = await setupAs('admin');
    await expect(backend.settings.getSettings()).resolves.toEqual({
      receiptFooter: 'Merci pour votre visite !',
    });

    const saved = await backend.settings.updateSettings({ receiptFooter: 'À bientôt' });
    expect(saved).toEqual({ receiptFooter: 'À bientôt' });
    saved.receiptFooter = 'Changed';
    const read = await backend.settings.getSettings();
    expect(read).toEqual({ receiptFooter: 'À bientôt' });
    read.receiptFooter = 'Changed again';
    await expect(backend.settings.getSettings()).resolves.toEqual({ receiptFooter: 'À bientôt' });
  });

  it('rejects a footer that is too long', async () => {
    const { backend } = await setupAs('admin');
    await failure(
      backend.settings.updateSettings({ receiptFooter: 'x'.repeat(501) }),
      'VALIDATION_ERROR',
    );
    await expect(backend.settings.getSettings()).resolves.toEqual(defaultSeed.settings);
  });
});

describe('sales', () => {
  const sale: RecordSaleInput = {
    lines: [
      {
        productId: 'prod-croissant',
        name: 'Croissant au beurre',
        qty: 2,
        unitPriceMillimes: mm(800),
      },
      {
        productId: 'prod-jus-orange',
        name: "Jus d'orange 1 L",
        qty: 10,
        unitPriceMillimes: mm(3_200),
      },
      {
        productId: 'prod-lait',
        name: 'Lait demi-écrémé 1 L',
        qty: 1,
        unitPriceMillimes: mm(1_350),
      },
      {
        productId: 'prod-lait',
        name: 'Lait demi-écrémé 1 L',
        qty: 1,
        unitPriceMillimes: mm(1_350),
      },
    ],
    paymentMethod: 'cash',
  };

  it('decrements stock per line, clamps at zero and flips available', async () => {
    const { backend } = await setupAs('cashier');
    await expect(backend.sales.recordSale(sale)).resolves.toEqual({ saleId: 'id-1' });

    const products = await backend.catalog.listProducts();
    const byId = new Map(products.map((product) => [product.id, product]));
    expect(byId.get('prod-croissant')).toMatchObject({ stock: 3, available: true });
    expect(byId.get('prod-jus-orange')).toMatchObject({ stock: 0, available: false });
    expect(byId.get('prod-lait')).toMatchObject({ stock: 58, available: true });
    expect(byId.get('prod-harissa')).toEqual(
      defaultSeed.products.find((product) => product.id === 'prod-harissa'),
    );
  });

  it('stores the sale with its exact total in millimes', async () => {
    const { backend } = await setupAs('cashier');
    await backend.sales.recordSale(sale);

    expect(backend.inspect.recordedSales()).toEqual([
      {
        id: 'id-1',
        lines: sale.lines,
        paymentMethod: 'cash',
        createdAt: isoAt(1),
        // 2 × 0,800 + 10 × 3,200 + 2 × 1,350
        totalMillimes: 36_300,
      },
    ]);
  });

  it('rejects an unknown product without changing any stock', async () => {
    const { backend } = await setupAs('cashier');
    const error = await failure(
      backend.sales.recordSale({
        ...sale,
        lines: [
          ...sale.lines,
          { productId: 'gone', name: 'Gone', qty: 1, unitPriceMillimes: mm(1) },
        ],
      }),
      'NOT_FOUND',
    );
    expect(error.details).toEqual({ id: 'gone' });
    await expect(backend.catalog.listProducts()).resolves.toEqual(defaultSeed.products);
    expect(backend.inspect.recordedSales()).toEqual([]);
  });

  it('rejects a sale without lines or with a bad quantity', async () => {
    const { backend } = await setupAs('cashier');
    await failure(
      backend.sales.recordSale({ lines: [], paymentMethod: 'card' }),
      'VALIDATION_ERROR',
    );
    await failure(
      backend.sales.recordSale({ lines: [{ ...sale.lines[0], qty: 0 }], paymentMethod: 'card' }),
      'VALIDATION_ERROR',
    );
    expect(backend.inspect.recordedSales()).toEqual([]);
  });

  it('rejects a unit price below zero or above the maximum without changing any stock', async () => {
    const { backend } = await setupAs('cashier');
    for (const unitPriceMillimes of [mm(-1), mm(MAX_PRICE_MILLIMES + 1)]) {
      const lines = [sale.lines[0], { ...sale.lines[1], unitPriceMillimes }];
      await failure(backend.sales.recordSale({ ...sale, lines }), 'VALIDATION_ERROR');
    }
    expect(backend.inspect.recordedSales()).toEqual([]);
    await expect(backend.catalog.listProducts()).resolves.toEqual(defaultSeed.products);
  });
});

describe('access', () => {
  it.each(MEMORY_OPERATIONS)(
    '%s lets in the callers its legacy route lets in, and a refusal changes nothing',
    async (operation) => {
      for (const caller of CALLERS) {
        const { backend } = await setupAs(caller);
        const outcome = await outcomeOf(callFor[operation](backend));
        expect(outcome, `${operation} as ${caller}`).toBe(
          outcomeUnder[accessFor[operation]][caller],
        );
        if (outcome !== 'resolved') {
          const control = (await setupAs(caller)).backend;
          expect(await observable(backend)).toEqual(await observable(control));
        }
      }
    },
  );

  it('lets the cashier record a sale but not change the catalog or the settings', async () => {
    const { backend } = await setupAs('cashier');

    await failure(backend.catalog.createProduct(dates), 'FORBIDDEN');
    await failure(backend.catalog.deleteCategory('cat-boissons'), 'FORBIDDEN');
    await failure(backend.settings.updateSettings({ receiptFooter: 'À bientôt' }), 'FORBIDDEN');
    await expect(
      backend.sales.recordSale({
        lines: [{ productId: 'prod-eau', name: 'Eau', qty: 2, unitPriceMillimes: mm(750) }],
        paymentMethod: 'cash',
      }),
    ).resolves.toEqual({ saleId: 'id-1' });

    const products = await backend.catalog.listProducts();
    expect(products).toHaveLength(defaultSeed.products.length);
    expect(products.find((product) => product.id === 'prod-eau')).toMatchObject({ stock: 118 });
    expect(backend.inspect.recordedSales()).toHaveLength(1);
    await expect(backend.catalog.listCategories()).resolves.toEqual(defaultSeed.categories);
    await expect(backend.settings.getSettings()).resolves.toEqual(defaultSeed.settings);
  });

  it('refuses writes again once the user has signed out', async () => {
    const { backend } = await setupAs('admin');
    await backend.catalog.createCategory({ name: 'Surgelés', color: '#6366f1' });

    await backend.auth.signOut();

    await failure(
      backend.catalog.createCategory({ name: 'Épices', color: '#8b5cf6' }),
      'UNAUTHENTICATED',
    );
    await failure(callFor['sales.recordSale'](backend), 'UNAUTHENTICATED');
    const categories = await backend.catalog.listCategories();
    expect(categories.map((category) => category.name)).toEqual([
      ...defaultSeed.categories.map((category) => category.name),
      'Surgelés',
    ]);
    expect(backend.inspect.recordedSales()).toEqual([]);
  });

  it('checks the caller before the input, and the input before the ids', async () => {
    const nameless: ProductInput = { ...dates, name: '' };
    const { backend } = setup();
    await failure(backend.catalog.updateProduct('missing', nameless), 'UNAUTHENTICATED');
    await failure(
      backend.sales.recordSale({ lines: [], paymentMethod: 'cash' }),
      'UNAUTHENTICATED',
    );

    await signInAs(backend, 'cashier');
    await failure(backend.catalog.updateProduct('missing', nameless), 'FORBIDDEN');
    await failure(
      backend.sales.recordSale({ lines: [], paymentMethod: 'cash' }),
      'VALIDATION_ERROR',
    );

    await signInAs(backend, 'admin');
    await failure(backend.catalog.updateProduct('missing', nameless), 'VALIDATION_ERROR');
    await failure(backend.catalog.updateProduct('missing', dates), 'NOT_FOUND');
  });

  it('fails with a pending fault before it checks the caller', async () => {
    const { backend, faults } = setup();
    const offline = new AppError('NETWORK_ERROR', 'Offline');
    faults.failNext('catalog.createProduct', offline);

    await expect(backend.catalog.createProduct(dates)).rejects.toBe(offline);
    await failure(backend.catalog.createProduct(dates), 'UNAUTHENTICATED');
    await expect(backend.catalog.listProducts()).resolves.toEqual(defaultSeed.products);
  });
});

describe('fault injection', () => {
  it('makes the next calls throw the given AppError exactly `times` times', async () => {
    const { backend, faults } = setup();
    const offline = new AppError('NETWORK_ERROR', 'Offline');
    faults.failNext('catalog.listProducts', offline, 2);

    await expect(backend.catalog.listProducts()).rejects.toBe(offline);
    await expect(backend.catalog.listCategories()).resolves.toHaveLength(4);
    await expect(backend.catalog.listProducts()).rejects.toBe(offline);
    await expect(backend.catalog.listProducts()).resolves.toHaveLength(12);
  });

  it.each(MEMORY_OPERATIONS)(
    '%s checks faults under its own name before it touches the store',
    async (operation) => {
      const { backend, faults } = await setupAs('admin');
      // The same calls without the faulted one, to show that it changed nothing.
      const control = (await setupAs('admin')).backend;
      const fault = new AppError('SERVER_ERROR', `Fault for ${operation}`);
      faults.failNext(operation, fault);

      for (const other of SIGN_OUT_LAST.filter((candidate) => candidate !== operation)) {
        const outcome = await settle(callFor[other](backend));
        expect(outcome, `${other}, with a fault pending for ${operation}`).toBe('resolved');
        await callFor[other](control);
      }
      await expect(callFor[operation](backend)).rejects.toBe(fault);
      // The sign-out above ended the session that the faulted call may need.
      await signInAs(backend, 'admin');
      await signInAs(control, 'admin');
      expect(await settle(callFor[operation](backend))).toBe('resolved');
      await callFor[operation](control);

      expect(await observable(backend)).toEqual(await observable(control));
    },
  );

  it('fails once by default and leaves the store unchanged', async () => {
    const { backend, faults } = await setupAs('cashier');
    const busy = new AppError('SERVER_ERROR', 'Busy');
    faults.failNext('sales.recordSale', busy);

    await expect(
      backend.sales.recordSale({
        lines: [{ productId: 'prod-eau', name: 'Eau', qty: 1, unitPriceMillimes: mm(750) }],
        paymentMethod: 'cash',
      }),
    ).rejects.toBe(busy);
    await expect(backend.catalog.listProducts()).resolves.toEqual(defaultSeed.products);
    expect(backend.inspect.recordedSales()).toEqual([]);

    await expect(
      backend.sales.recordSale({
        lines: [{ productId: 'prod-eau', name: 'Eau', qty: 1, unitPriceMillimes: mm(750) }],
        paymentMethod: 'cash',
      }),
    ).resolves.toEqual({ saleId: 'id-1' });
  });

  it('matches any operation with * and applies faults in the order they were added', async () => {
    const { backend, faults } = setup();
    const specific = new AppError('FORBIDDEN', 'No');
    const any = new AppError('RATE_LIMITED', 'Slow down');
    faults.failNext('catalog.listProducts', specific);
    faults.failNext('*', any);

    const events: AuthState[] = [];
    backend.auth.onStateChange((state) => {
      events.push(state);
    });
    await expect(
      backend.auth.signIn({ email: 'admin@demo.local', password: 'demo-admin-2026' }),
    ).rejects.toBe(any);
    expect(events).toEqual([]);
    await expect(backend.catalog.listProducts()).rejects.toBe(specific);
    await expect(backend.catalog.listProducts()).resolves.toHaveLength(12);
    await expect(backend.settings.getSettings()).resolves.toEqual(defaultSeed.settings);
  });

  it('clear drops pending faults', async () => {
    const { backend, faults } = setup();
    faults.failNext('*', new AppError('NETWORK_ERROR', 'Offline'), 5);
    faults.clear();
    await expect(backend.auth.getState()).resolves.toEqual({ status: 'anonymous' });
  });

  it('refuses a times value below one or fractional', () => {
    const faults = createFaultInjector();
    const error = new AppError('NETWORK_ERROR', 'Offline');
    expect(() => faults.failNext('*', error, 0)).toThrow(AppError);
    expect(() => faults.failNext('*', error, 1.5)).toThrow(AppError);
    expect(() => faults.check('auth.getState')).not.toThrow();
  });
});

describe('ids and unexpected failures', () => {
  it('uses crypto.randomUUID for ids where it exists', () => {
    expect(
      randomId({ randomUUID: () => 'from-random-uuid', getRandomValues: (bytes) => bytes }),
    ).toBe('from-random-uuid');
    expect(randomId()).toMatch(UUID_V4);
  });

  it('builds a v4 UUID from getRandomValues where randomUUID is missing', () => {
    expect(randomId({ getRandomValues: (bytes) => bytes.fill(0x00) })).toBe(
      '00000000-0000-4000-8000-000000000000',
    );
    expect(randomId({ getRandomValues: (bytes) => bytes.fill(0xff) })).toBe(
      'ffffffff-ffff-4fff-bfff-ffffffffffff',
    );
    expect(randomId({ getRandomValues: (bytes) => bytes.map((_, index) => index) })).toBe(
      '00010203-0405-4607-8809-0a0b0c0d0e0f',
    );
    expect(randomId({ getRandomValues: (bytes) => crypto.getRandomValues(bytes) })).toMatch(
      UUID_V4,
    );
  });

  it('creates records with the default ids on a page that is not a secure context', async () => {
    const secure = crypto;
    // What http://192.168.x.x offers: getRandomValues but no randomUUID.
    vi.stubGlobal('crypto', {
      getRandomValues: (bytes: Uint8Array<ArrayBuffer>) => secure.getRandomValues(bytes),
    });
    try {
      const backend = createMemoryBackend();
      await signInAs(backend, 'admin');
      const category = await backend.catalog.createCategory({ name: 'Surgelés', color: '#6366f1' });
      expect(category.id).toMatch(UUID_V4);
      const { saleId } = await backend.sales.recordSale({
        lines: [{ productId: 'prod-eau', name: 'Eau', qty: 1, unitPriceMillimes: mm(750) }],
        paymentMethod: 'card',
      });
      expect(saleId).toMatch(UUID_V4);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('turns any other failure into an UNKNOWN AppError that keeps the original as its cause', async () => {
    const broken = new TypeError('crypto.randomUUID is not a function');
    const backend = createMemoryBackend({
      newId: () => {
        throw broken;
      },
    });
    await signInAs(backend, 'admin');

    const error = await failure(
      backend.catalog.createCategory({ name: 'Surgelés', color: '#6366f1' }),
      'UNKNOWN',
    );
    expect(error.message).toBe('crypto.randomUUID is not a function');
    expect(error.cause).toBe(broken);
    await expect(backend.catalog.listCategories()).resolves.toEqual(defaultSeed.categories);
  });
});
