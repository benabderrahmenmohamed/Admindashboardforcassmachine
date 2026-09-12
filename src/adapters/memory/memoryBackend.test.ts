import { describe, expect, it, vi } from 'vitest';
import { addItem, emptyCart } from '@/features/pos/cart';
import { buildSaleRecord } from '@/features/sales/records';
import { buildCloseSessionRecord, buildOpenSessionRecord } from '@/features/sessions/records';
import { AppError, isAppError, type ErrorCode } from '@/lib/errors';
import { mm } from '@/lib/money';
import type {
  AuthState,
  AuthUser,
  Category,
  CloseSessionRecord,
  Credentials,
  OpenSessionRecord,
  Product,
  ProductCreateInput,
  ProductUpdateInput,
  Role,
  SaleRecord,
} from '@/ports';
import {
  createFaultInjector,
  createMemoryBackend,
  DEMO_SHOP_ID,
  defaultSeed,
  MEMORY_OPERATIONS,
  OTHER_SHOP_ID,
  type MemoryBackend,
  type MemoryOperation,
  type MemorySeed,
  type MemorySeedProduct,
} from './index';
import { randomId } from './support';

const START = Date.UTC(2026, 8, 11, 9, 0, 0);
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const ADMIN_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
const WATER = '55555555-5555-4555-8555-555555555501';
const HARISSA = '55555555-5555-4555-8555-555555555504';
const DATES = '55555555-5555-4555-8555-555555555507';
const OTHER_PRODUCT = '66666666-6666-4666-8666-666666666601';
const BOISSONS = '44444444-4444-4444-8444-444444444401';
const LAITIERS = '44444444-4444-4444-8444-444444444402';
const EPICERIE = '44444444-4444-4444-8444-444444444403';
const BOULANGERIE = '44444444-4444-4444-8444-444444444404';
const GENERAL = '44444444-4444-4444-8444-444444444411';

const CREDENTIALS = {
  admin: { email: 'admin@demo.local', password: 'demo-admin-2026' },
  cashier: { email: 'cashier@demo.local', password: 'demo-cashier-2026' },
  otherAdmin: { email: 'other-admin@demo.local', password: 'other-admin-2026' },
  otherCashier: { email: 'other-cashier@demo.local', password: 'other-cashier-2026' },
} satisfies Record<string, Credentials>;

/** The n-th id the test id source hands out. */
function idNo(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

/** A record id chosen by a test device. */
function recordId(n: number): string {
  return `dddddddd-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

/** A seeded product as listProducts shows it. */
function listed(product: MemorySeedProduct): Product {
  return {
    id: product.id,
    name: product.name,
    priceMillimes: product.priceMillimes,
    categoryId: product.categoryId,
    categoryName:
      defaultSeed.categories.find((category) => category.id === product.categoryId)?.name ?? null,
    barcode: product.barcode,
    description: product.description,
    imageUrl: product.imageUrl,
    stock: product.stock,
    available: product.available,
    createdAt: product.createdAt,
    updatedAt: product.createdAt,
  };
}

function categoriesOf(shopId: string): Category[] {
  return defaultSeed.categories
    .filter((category) => category.shopId === shopId)
    .map(({ id, name, color, createdAt }) => ({ id, name, color, createdAt }));
}

const DEMO_PRODUCTS = defaultSeed.products
  .filter((product) => product.shopId === DEMO_SHOP_ID)
  .map(listed);
const OTHER_PRODUCTS = defaultSeed.products
  .filter((product) => product.shopId === OTHER_SHOP_ID)
  .map(listed);
const DEMO_CATEGORIES = categoriesOf(DEMO_SHOP_ID);
const OTHER_CATEGORIES = categoriesOf(OTHER_SHOP_ID);

/** A backend with a clock that ticks one second per read and ids idNo(1), idNo(2), … */
function setup(seed?: MemorySeed) {
  let ticks = 0;
  let ids = 0;
  const faults = createFaultInjector();
  const backend = createMemoryBackend({
    seed,
    faults,
    now: () => {
      ticks += 1;
      return new Date(START + ticks * 1000);
    },
    newId: () => {
      ids += 1;
      return idNo(ids);
    },
  });
  return { backend, faults };
}

/** Who makes a call: nobody signed in, or the demo shop's account with that role. */
type Caller = 'signed out' | Role;

/** Signs in the demo shop's account with `role`, as the demo buttons of the login page do. */
function signInAs(backend: MemoryBackend, role: Role): Promise<AuthUser> {
  return backend.auth.signIn(CREDENTIALS[role]);
}

/** `setup()`, then signs `caller` in. */
async function setupAs(caller: Caller) {
  const result = setup();
  if (caller !== 'signed out') {
    await signInAs(result.backend, caller);
  }
  return result;
}

/** Another client of `backend`, signed in with `credentials`. */
async function clientAs(backend: MemoryBackend, credentials: Credentials): Promise<MemoryBackend> {
  const client = backend.connect();
  await client.auth.signIn(credentials);
  return client;
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
  expect(outcome.code, outcome.message).toBe(code);
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

const dates: ProductCreateInput = {
  name: 'Dattes Deglet Nour 1 kg',
  priceMillimes: mm(14_500),
  categoryId: EPICERIE,
  barcode: '6194000300071',
  description: 'Tozeur',
  imageUrl: '',
  openingStock: 30,
};

const harissaEdit: ProductUpdateInput = {
  name: 'Harissa 380 g',
  priceMillimes: mm(2_600),
  categoryId: EPICERIE,
  barcode: '6194000300019',
  description: '',
  imageUrl: '',
  stockDelta: 5,
};

/**
 * What the calls of `callFor` need, prepared by the admin on a client of its own: terminal T1 with
 * an open session and sale T1-1, terminal T2 without a session, and records not yet sent.
 */
interface Prepared {
  readonly terminalId: string;
  readonly otherTerminalId: string;
  readonly sessionId: string;
  readonly saleId: string;
  readonly openOnT2: OpenSessionRecord;
  readonly closeT1: CloseSessionRecord;
  readonly nextSale: SaleRecord;
}

async function prepare(backend: MemoryBackend): Promise<Prepared> {
  const admin = await clientAs(backend, CREDENTIALS.admin);
  const t1 = await admin.terminals.register('T1');
  const t2 = await admin.terminals.register('T2');
  const terminal = { terminalCode: 'T1', epoch: 0 };
  const open = await buildOpenSessionRecord({
    id: recordId(1),
    terminal,
    actorUserId: ADMIN_ID,
    openedAt: isoAt(0),
    openingFloatMillimes: mm(10_000),
  });
  await admin.sessions.open(open);
  const cart = addItem(
    emptyCart,
    { id: WATER, name: 'Eau minérale 1,5 L', priceMillimes: mm(850) },
    2,
  );
  const envelope = { sessionId: open.id, createdAt: isoAt(0), terminal };
  const first = await buildSaleRecord({ ...envelope, id: recordId(2), seq: 1 }, cart, {
    method: 'cash',
  });
  await admin.sales.recordSale(first);
  return {
    terminalId: t1.terminalId,
    otherTerminalId: t2.terminalId,
    sessionId: open.id,
    saleId: first.id,
    openOnT2: await buildOpenSessionRecord({
      id: recordId(3),
      terminal: { terminalCode: 'T2', epoch: 0 },
      actorUserId: ADMIN_ID,
      openedAt: isoAt(0),
      openingFloatMillimes: mm(0),
    }),
    closeT1: await buildCloseSessionRecord({
      id: recordId(4),
      sessionId: open.id,
      terminal,
      actorUserId: ADMIN_ID,
      closedAt: isoAt(0),
      closingCountedMillimes: mm(11_700),
      clientZReport: null,
    }),
    nextSale: await buildSaleRecord({ ...envelope, id: recordId(5), seq: 2 }, cart, {
      method: 'card',
    }),
  };
}

/** `setup()` prepared by the admin, then `caller` signed in on the backend's first client. */
async function preparedAs(caller: Caller) {
  const result = setup();
  const prepared = await prepare(result.backend);
  if (caller !== 'signed out') {
    await signInAs(result.backend, caller);
  }
  return { ...result, prepared };
}

/** Everything the members of both shops see through the ports, and the state no port reads. */
async function observable(backend: MemoryBackend, prepared: Prepared) {
  const viewer = await clientAs(backend, CREDENTIALS.admin);
  const other = await clientAs(backend, CREDENTIALS.otherAdmin);
  return {
    products: await viewer.catalog.listProducts(),
    categories: await viewer.catalog.listCategories(),
    settings: await viewer.settings.getSettings(),
    sessionOnT1: await viewer.sessions.current(prepared.terminalId),
    sessionOnT2: await viewer.sessions.current(prepared.otherTerminalId),
    report: await viewer.sessions.zReport(prepared.sessionId),
    sales: await viewer.sales.listSales({}),
    otherProducts: await other.catalog.listProducts(),
    otherCategories: await other.catalog.listCategories(),
    otherSettings: await other.settings.getSettings(),
    movements: backend.inspect.stockMovements(),
    terminals: backend.inspect.terminals(),
    voids: backend.inspect.receiptVoids(),
  };
}

/** One valid call per port method. On a backend prepared by `prepare`, as the admin, each succeeds. */
const callFor: Record<
  MemoryOperation,
  (backend: MemoryBackend, prepared: Prepared) => Promise<unknown>
> = {
  'auth.getState': (backend) => backend.auth.getState(),
  'auth.signIn': (backend) => backend.auth.signIn(CREDENTIALS.admin),
  'auth.signOut': (backend) => backend.auth.signOut(),
  'catalog.listProducts': (backend) => backend.catalog.listProducts(),
  'catalog.createProduct': (backend) => backend.catalog.createProduct(dates),
  'catalog.updateProduct': (backend) => backend.catalog.updateProduct(HARISSA, harissaEdit),
  'catalog.deleteProduct': (backend) => backend.catalog.deleteProduct(DATES),
  'catalog.listCategories': (backend) => backend.catalog.listCategories(),
  'catalog.createCategory': (backend) =>
    backend.catalog.createCategory({ name: 'Surgelés', color: '#6366f1' }),
  'catalog.deleteCategory': (backend) => backend.catalog.deleteCategory(BOULANGERIE),
  'settings.getSettings': (backend) => backend.settings.getSettings(),
  'settings.updateSettings': (backend) =>
    backend.settings.updateSettings({ receiptFooter: 'À bientôt' }),
  'terminals.register': (backend) => backend.terminals.register('T3'),
  'sessions.open': (backend, prepared) => backend.sessions.open(prepared.openOnT2),
  'sessions.close': (backend, prepared) => backend.sessions.close(prepared.closeT1),
  'sessions.current': (backend, prepared) => backend.sessions.current(prepared.terminalId),
  'sessions.zReport': (backend, prepared) => backend.sessions.zReport(prepared.sessionId),
  'sales.recordSale': (backend, prepared) => backend.sales.recordSale(prepared.nextSale),
  'sales.listSales': (backend) => backend.sales.listSales({}),
  'sales.getSale': (backend, prepared) => backend.sales.getSale(prepared.saleId),
  'sales.voidReceipt': (backend, prepared) =>
    backend.sales.voidReceipt({
      record: prepared.nextSale,
      errorCode: 'VALIDATION_ERROR',
      reason: 'Refused while offline',
    }),
};

type Access = 'anyone' | 'member' | 'admin';

/** Who may call each port method: the check made by the database behind it. */
const accessFor: Record<MemoryOperation, Access> = {
  // Supabase Auth itself.
  'auth.getState': 'anyone',
  'auth.signIn': 'anyone',
  'auth.signOut': 'anyone',
  'catalog.listProducts': 'member', // products, row-level security by shop
  'catalog.createProduct': 'admin', // save_product
  'catalog.updateProduct': 'admin', // save_product
  'catalog.deleteProduct': 'admin', // archive_product
  'catalog.listCategories': 'member', // categories
  'catalog.createCategory': 'admin', // categories insert policy
  'catalog.deleteCategory': 'admin', // categories delete policy
  'settings.getSettings': 'member', // shop_settings
  'settings.updateSettings': 'admin', // shop_settings update policy
  'terminals.register': 'admin', // register_terminal
  'sessions.open': 'member', // open_session
  'sessions.close': 'member', // close_session
  'sessions.current': 'member', // cash_sessions
  'sessions.zReport': 'member', // z_report
  'sales.recordSale': 'member', // record_sale
  'sales.listSales': 'member', // sales and sale_lines
  'sales.getSale': 'member', // sales and sale_lines
  'sales.voidReceipt': 'admin', // void_receipt
};

const CALLERS: readonly Caller[] = ['signed out', 'cashier', 'admin'];

/** How a call settles for each caller under each access rule. */
const outcomeUnder: Record<Access, Record<Caller, 'resolved' | ErrorCode>> = {
  anyone: { 'signed out': 'resolved', cashier: 'resolved', admin: 'resolved' },
  member: { 'signed out': 'UNAUTHENTICATED', cashier: 'resolved', admin: 'resolved' },
  admin: { 'signed out': 'UNAUTHENTICATED', cashier: 'FORBIDDEN', admin: 'resolved' },
};

describe('default seed', () => {
  it('mirrors supabase/seed.sql: two shops with their members, categories and products, and no terminal', () => {
    const { shops, accounts, profiles, categories, products } = defaultSeed;
    expect(shops.map((shop) => [shop.id, shop.name, shop.settings.receiptFooter])).toEqual([
      [DEMO_SHOP_ID, 'Épicerie du Coin', 'Merci pour votre visite !'],
      [OTHER_SHOP_ID, 'Other Shop', 'Thank you for your purchase!'],
    ]);
    expect(accounts.map((account) => [account.email, account.demoLabel])).toEqual([
      ['admin@demo.local', 'Admin'],
      ['cashier@demo.local', 'Cashier'],
      ['other-admin@demo.local', null],
      ['other-cashier@demo.local', null],
    ]);
    expect(
      profiles.map((profile) => [
        profile.userId,
        profile.shopId,
        profile.role,
        profile.displayName,
      ]),
    ).toEqual([
      [ADMIN_ID, DEMO_SHOP_ID, 'admin', 'Demo Admin'],
      ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2', DEMO_SHOP_ID, 'cashier', 'Demo Cashier'],
      ['bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1', OTHER_SHOP_ID, 'admin', 'Other Admin'],
      ['bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2', OTHER_SHOP_ID, 'cashier', 'Other Cashier'],
    ]);

    const demoProducts = products.filter((product) => product.shopId === DEMO_SHOP_ID);
    expect(DEMO_CATEGORIES).toHaveLength(4);
    expect(demoProducts).toHaveLength(12);
    expect(OTHER_PRODUCTS).toHaveLength(2);
    expect(demoProducts.some((product) => product.priceMillimes % 1000 !== 0)).toBe(true);
    expect(demoProducts.some((product) => product.stock === 0)).toBe(true);
    expect(demoProducts.some((product) => product.stock > 0 && product.stock <= 10)).toBe(true);
    const withBarcode = demoProducts.filter((product) => product.barcode !== '');
    expect(withBarcode.length).toBeGreaterThan(demoProducts.length / 2);
    expect(new Set(withBarcode.map((product) => product.barcode)).size).toBe(withBarcode.length);
    for (const product of products) {
      const shelf = categories.find((category) => category.id === product.categoryId);
      expect(shelf?.shopId, product.name).toBe(product.shopId);
    }
    expect(createMemoryBackend().inspect.terminals()).toEqual([]);
  });

  it('writes seeded stock as opening movements, so stock is the sum of its movements', () => {
    const { backend } = setup();
    const movements = backend.inspect.stockMovements();

    expect(movements).toHaveLength(
      defaultSeed.products.filter((product) => product.stock !== 0).length,
    );
    expect(movements[0]).toEqual({
      id: 1,
      shopId: DEMO_SHOP_ID,
      productId: WATER,
      delta: 120,
      reason: 'opening',
      saleId: null,
      note: 'Seed data',
      createdBy: null,
      createdAt: '2026-01-05T08:00:00.000Z',
    });
    for (const product of defaultSeed.products) {
      const sum = movements
        .filter((movement) => movement.productId === product.id)
        .reduce((total, movement) => total + movement.delta, 0);
      expect(sum, product.name).toBe(product.stock);
    }
  });

  it('is copied, so backends never share state', async () => {
    const first = createMemoryBackend();
    const second = createMemoryBackend();
    await signInAs(first, 'admin');
    await signInAs(second, 'admin');

    const created = await first.catalog.createProduct(dates);

    expect(created.id).toMatch(UUID_V4);
    await expect(second.catalog.listProducts()).resolves.toEqual(DEMO_PRODUCTS);
    expect(defaultSeed.products).toHaveLength(14);
  });

  it('rejects a seed with a repeated id, a broken reference or an id that is not a lowercase UUID', () => {
    const [water, milk] = defaultSeed.products;
    const [admin] = defaultSeed.accounts;
    const invalid: MemorySeed[] = [
      { ...defaultSeed, products: [water, water] },
      { ...defaultSeed, products: [water, { ...milk, barcode: water.barcode }] },
      { ...defaultSeed, products: [{ ...water, categoryId: GENERAL }] },
      {
        ...defaultSeed,
        accounts: defaultSeed.accounts.map((account) => ({
          ...account,
          id: account.id.toUpperCase(),
        })),
        profiles: defaultSeed.profiles.map((profile) => ({
          ...profile,
          userId: profile.userId.toUpperCase(),
        })),
      },
      { ...defaultSeed, accounts: [...defaultSeed.accounts, { ...admin, id: idNo(1) }] },
      {
        ...defaultSeed,
        profiles: [
          ...defaultSeed.profiles,
          { userId: idNo(1), shopId: DEMO_SHOP_ID, role: 'cashier', displayName: 'Ghost' },
        ],
      },
    ];
    for (const seed of invalid) {
      expect(() => createMemoryBackend({ seed })).toThrow(
        expect.objectContaining({ code: 'CONFIG_ERROR' }),
      );
    }
  });
});

describe('auth', () => {
  it('starts anonymous and signs a member in with the name, role and shop of their profile', async () => {
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
      id: ADMIN_ID,
      email: 'admin@demo.local',
      name: 'Demo Admin',
      role: 'admin',
      shopId: DEMO_SHOP_ID,
    });
    await expect(backend.auth.getState()).resolves.toEqual({ status: 'authenticated', user });
    expect(events).toEqual([{ status: 'authenticated', user }]);
    await expect(backend.auth.signIn(CREDENTIALS.otherCashier)).resolves.toEqual({
      id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2',
      email: 'other-cashier@demo.local',
      name: 'Other Cashier',
      role: 'cashier',
      shopId: OTHER_SHOP_ID,
    });
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

  it('refuses an account without a shop membership with FORBIDDEN, ending the session it replaced', async () => {
    const drifter = {
      id: idNo(900),
      email: 'drifter@demo.local',
      password: 'drifter-2026',
      demoLabel: null,
    };
    const { backend } = setup({ ...defaultSeed, accounts: [...defaultSeed.accounts, drifter] });
    const events: AuthState[] = [];
    backend.auth.onStateChange((state) => {
      events.push(state);
    });
    const credentials = { email: drifter.email, password: drifter.password };

    const error = await failure(backend.auth.signIn(credentials), 'FORBIDDEN');
    expect(error.message).toBe('This account is not a member of any shop.');
    expect(events).toEqual([]);

    const admin = await signInAs(backend, 'admin');
    await failure(backend.auth.signIn(credentials), 'FORBIDDEN');
    await expect(backend.auth.getState()).resolves.toEqual({ status: 'anonymous' });
    expect(events).toEqual([{ status: 'authenticated', user: admin }, { status: 'anonymous' }]);
    expect(backend.demoAccounts.map((account) => account.email)).not.toContain(drifter.email);
  });

  it('signs the cashier in and out, and stops notifying after unsubscribe', async () => {
    const { backend } = setup();
    const events: AuthState[] = [];
    const unsubscribe = backend.auth.onStateChange((state) => {
      events.push(state);
    });

    const cashier = await signInAs(backend, 'cashier');
    expect(cashier).toMatchObject({ role: 'cashier', shopId: DEMO_SHOP_ID });
    await backend.auth.signOut();
    await expect(backend.auth.getState()).resolves.toEqual({ status: 'anonymous' });

    unsubscribe();
    await signInAs(backend, 'admin');

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

    const user = await signInAs(backend, 'cashier');
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
    // The role the ports check is the profile's, not the one on a cached user.
    await failure(backend.settings.updateSettings({ receiptFooter: 'À bientôt' }), 'FORBIDDEN');
  });

  it("offers the demo shop's admin and cashier as demo accounts", () => {
    const { backend } = setup();
    expect(backend.kind).toBe('memory');
    expect(backend.demoAccounts).toEqual([
      { label: 'Admin', email: 'admin@demo.local', password: 'demo-admin-2026' },
      { label: 'Cashier', email: 'cashier@demo.local', password: 'demo-cashier-2026' },
    ]);
  });
});

describe('clients', () => {
  it('connects clients that share the data but not the sign-in or the faults', async () => {
    const { backend, faults } = await setupAs('admin');
    const cashier = backend.connect();
    await expect(cashier.auth.getState()).resolves.toEqual({ status: 'anonymous' });
    await signInAs(cashier, 'cashier');

    const created = await backend.catalog.createCategory({ name: 'Surgelés', color: '#6366f1' });
    await expect(cashier.catalog.listCategories()).resolves.toContainEqual(created);
    await expect(backend.auth.getState()).resolves.toMatchObject({ user: { role: 'admin' } });

    faults.failNext('*', new AppError('NETWORK_ERROR', 'Offline'));
    await expect(cashier.catalog.listProducts()).resolves.toHaveLength(12);
    const ownFaults = createFaultInjector();
    const third = backend.connect({ faults: ownFaults });
    ownFaults.failNext('auth.getState', new AppError('SERVER_ERROR', 'Busy'));
    await failure(third.auth.getState(), 'SERVER_ERROR');
    await failure(backend.catalog.listProducts(), 'NETWORK_ERROR');

    await cashier.auth.signOut();
    await expect(backend.catalog.listCategories()).resolves.toContainEqual(created);
  });
});

describe('catalog', () => {
  it("lists the products and categories of the caller's shop, in insertion order, as copies", async () => {
    const { backend } = await setupAs('cashier');
    const products = await backend.catalog.listProducts();
    expect(products).toEqual(DEMO_PRODUCTS);

    products[0].name = 'Changed';
    products[0].stock = 999;

    await expect(backend.catalog.listProducts()).resolves.toEqual(DEMO_PRODUCTS);
    await expect(backend.catalog.listCategories()).resolves.toEqual(DEMO_CATEGORIES);
    await backend.auth.signIn(CREDENTIALS.otherCashier);
    await expect(backend.catalog.listProducts()).resolves.toEqual(OTHER_PRODUCTS);
    await expect(backend.catalog.listCategories()).resolves.toEqual(OTHER_CATEGORIES);
  });

  it('creates a product with an id, timestamps, availability, the category name and an opening movement', async () => {
    const { backend } = await setupAs('admin');
    const created = await backend.catalog.createProduct(dates);

    expect(created).toEqual({
      id: idNo(1),
      name: dates.name,
      priceMillimes: dates.priceMillimes,
      categoryId: EPICERIE,
      categoryName: 'Épicerie',
      barcode: dates.barcode,
      description: 'Tozeur',
      imageUrl: '',
      stock: 30,
      available: true,
      createdAt: isoAt(1),
      updatedAt: isoAt(1),
    });
    const products = await backend.catalog.listProducts();
    expect(products.at(-1)).toEqual(created);
    expect(products).toHaveLength(DEMO_PRODUCTS.length + 1);
    expect(backend.inspect.stockMovements().at(-1)).toEqual({
      id: 14,
      shopId: DEMO_SHOP_ID,
      productId: idNo(1),
      delta: 30,
      reason: 'opening',
      saleId: null,
      note: '',
      createdBy: ADMIN_ID,
      createdAt: isoAt(1),
    });

    const loose = await backend.catalog.createProduct({
      ...dates,
      categoryId: null,
      barcode: '',
      openingStock: 0,
    });
    expect(loose).toMatchObject({
      categoryId: null,
      categoryName: null,
      stock: 0,
      available: true,
    });
    expect(backend.inspect.stockMovements()).toHaveLength(14);
  });

  it('updates the fields and moves stock by the delta only, keeping availability, createdAt and position', async () => {
    const { backend } = await setupAs('admin');
    const before = await backend.catalog.listProducts();
    const index = before.findIndex((product) => product.id === DATES);
    expect(before[index]).toMatchObject({ stock: 0, available: true });

    const input: ProductUpdateInput = {
      name: 'Dattes Deglet Nour 1 kg',
      priceMillimes: mm(14_500),
      categoryId: LAITIERS,
      barcode: '',
      description: 'Grand format',
      imageUrl: 'https://example.com/dattes.jpg',
      stockDelta: -2,
    };
    const updated = await backend.catalog.updateProduct(DATES, input);

    expect(updated).toEqual({
      id: DATES,
      name: input.name,
      priceMillimes: input.priceMillimes,
      categoryId: LAITIERS,
      categoryName: 'Produits laitiers',
      barcode: '',
      description: 'Grand format',
      imageUrl: input.imageUrl,
      stock: -2,
      available: true,
      createdAt: before[index].createdAt,
      updatedAt: isoAt(1),
    });
    const after = await backend.catalog.listProducts();
    expect(after[index]).toEqual(updated);
    expect(after).toHaveLength(before.length);
    expect(backend.inspect.stockMovements().at(-1)).toMatchObject({
      productId: DATES,
      delta: -2,
      reason: 'adjustment',
      createdBy: ADMIN_ID,
    });

    const unchanged = await backend.catalog.updateProduct(DATES, { ...input, stockDelta: 0 });
    expect(unchanged).toEqual({ ...updated, updatedAt: isoAt(2) });
    expect(backend.inspect.stockMovements()).toHaveLength(14);
  });

  it('rejects invalid input with the Zod issues and stores nothing', async () => {
    const { backend } = await setupAs('admin');
    const error = await failure(
      backend.catalog.createProduct({
        ...dates,
        name: '   ',
        priceMillimes: mm(-1),
        openingStock: -1,
      }),
      'VALIDATION_ERROR',
    );
    expect(error.details?.issues).toHaveLength(3);
    expect(error.message).toBe('Product name is required');

    await failure(
      backend.catalog.updateProduct(HARISSA, { ...harissaEdit, imageUrl: 'not a url' }),
      'VALIDATION_ERROR',
    );
    await expect(backend.catalog.listProducts()).resolves.toEqual(DEMO_PRODUCTS);
  });

  it("checks ids, categories and products against the caller's shop", async () => {
    const { backend } = await setupAs('admin');

    const badId = await failure(
      backend.catalog.updateProduct('prod-harissa', harissaEdit),
      'VALIDATION_ERROR',
    );
    expect(badId.details).toEqual({ field: 'id' });
    const badProductId = await failure(
      backend.catalog.deleteProduct('prod-harissa'),
      'VALIDATION_ERROR',
    );
    expect(badProductId.details).toEqual({ field: 'product_id' });
    const badCategoryId = await failure(
      backend.catalog.deleteCategory('cat-epicerie'),
      'VALIDATION_ERROR',
    );
    expect(badCategoryId.details).toEqual({ field: 'id' });

    for (const categoryId of [idNo(99), GENERAL, 'cat-epicerie']) {
      const error = await failure(
        backend.catalog.createProduct({ ...dates, categoryId }),
        'VALIDATION_ERROR',
      );
      expect(error.details, categoryId).toEqual({ field: 'category_id' });
    }
    // The category is checked before the product.
    await failure(
      backend.catalog.updateProduct(idNo(99), { ...harissaEdit, categoryId: GENERAL }),
      'VALIDATION_ERROR',
    );
    for (const id of [idNo(99), OTHER_PRODUCT]) {
      const edit = await failure(backend.catalog.updateProduct(id, harissaEdit), 'NOT_FOUND');
      expect(edit.details).toEqual({ productId: id });
      const removal = await failure(backend.catalog.deleteProduct(id), 'NOT_FOUND');
      expect(removal.details).toEqual({ productId: id });
    }
    const category = await failure(backend.catalog.deleteCategory(GENERAL), 'NOT_FOUND');
    expect(category.details).toEqual({ categoryId: GENERAL });

    await expect(backend.catalog.listProducts()).resolves.toEqual(DEMO_PRODUCTS);
    const other = await clientAs(backend, CREDENTIALS.otherAdmin);
    await expect(other.catalog.listProducts()).resolves.toEqual(OTHER_PRODUCTS);
    await expect(other.catalog.listCategories()).resolves.toEqual(OTHER_CATEGORIES);
  });

  it("refuses a barcode another live product of the shop uses, but not an archived product's or another shop's", async () => {
    const { backend } = await setupAs('admin');
    const waterBarcode = '6194000100015';

    const created = await failure(
      backend.catalog.createProduct({ ...dates, barcode: waterBarcode }),
      'VALIDATION_ERROR',
    );
    expect(created.details).toEqual({ field: 'barcode' });
    const updated = await failure(
      backend.catalog.updateProduct(HARISSA, { ...harissaEdit, barcode: waterBarcode }),
      'VALIDATION_ERROR',
    );
    expect(updated.details).toEqual({ field: 'barcode' });

    await expect(backend.catalog.updateProduct(HARISSA, harissaEdit)).resolves.toMatchObject({
      barcode: harissaEdit.barcode,
    });
    await expect(
      backend.catalog.createProduct({ ...dates, barcode: '9990000000011' }),
    ).resolves.toMatchObject({ barcode: '9990000000011' });
    await backend.catalog.deleteProduct(WATER);
    await expect(
      backend.catalog.createProduct({ ...dates, barcode: waterBarcode }),
    ).resolves.toMatchObject({ barcode: waterBarcode });
  });

  it('archives a deleted product: it leaves the list, its movements stay, and it is not archived twice', async () => {
    const { backend } = await setupAs('admin');
    await backend.catalog.deleteProduct(HARISSA);

    const products = await backend.catalog.listProducts();
    expect(products.map((product) => product.id)).not.toContain(HARISSA);
    expect(products).toHaveLength(DEMO_PRODUCTS.length - 1);
    expect(
      backend.inspect.stockMovements().filter((movement) => movement.productId === HARISSA),
    ).toHaveLength(1);
    const again = await failure(backend.catalog.deleteProduct(HARISSA), 'NOT_FOUND');
    expect(again.details).toEqual({ productId: HARISSA });
    await failure(backend.catalog.updateProduct(HARISSA, harissaEdit), 'NOT_FOUND');
  });

  it("creates categories in the caller's shop with a trimmed name and allows duplicate names", async () => {
    const { backend } = await setupAs('admin');
    const first = await backend.catalog.createCategory({ name: '  Surgelés ', color: '#6366f1' });
    const second = await backend.catalog.createCategory({ name: 'Surgelés', color: '#8b5cf6' });

    expect(first).toEqual({ id: idNo(1), name: 'Surgelés', color: '#6366f1', createdAt: isoAt(1) });
    expect(second).toMatchObject({ id: idNo(2), name: 'Surgelés' });
    const categories = await backend.catalog.listCategories();
    expect(categories.map((category) => category.id)).toEqual([
      BOISSONS,
      LAITIERS,
      EPICERIE,
      BOULANGERIE,
      idNo(1),
      idNo(2),
    ]);

    await failure(
      backend.catalog.createCategory({ name: ' ', color: '#6366f1' }),
      'VALIDATION_ERROR',
    );
    await failure(
      backend.catalog.createCategory({ name: 'Épices', color: 'blue' }),
      'VALIDATION_ERROR',
    );
    const other = await clientAs(backend, CREDENTIALS.otherAdmin);
    await expect(other.catalog.listCategories()).resolves.toEqual(OTHER_CATEGORIES);
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
    await backend.catalog.deleteCategory(BOISSONS);

    const categories = await backend.catalog.listCategories();
    expect(categories.map((category) => category.id)).not.toContain(BOISSONS);
    const products = await backend.catalog.listProducts();
    expect(DEMO_PRODUCTS.filter((product) => product.categoryId === BOISSONS)).toHaveLength(2);
    for (const seeded of DEMO_PRODUCTS) {
      const product = products.find((candidate) => candidate.id === seeded.id);
      if (seeded.categoryId === BOISSONS) {
        expect(product).toEqual({ ...seeded, categoryId: null, categoryName: null });
      } else {
        expect(product).toEqual(seeded);
      }
    }

    const again = await failure(backend.catalog.deleteCategory(BOISSONS), 'NOT_FOUND');
    expect(again.details).toEqual({ categoryId: BOISSONS });
  });
});

describe('settings', () => {
  it("reads and updates the receipt footer of the caller's shop only, handing out copies", async () => {
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

    const other = await clientAs(backend, CREDENTIALS.otherCashier);
    await expect(other.settings.getSettings()).resolves.toEqual({
      receiptFooter: 'Thank you for your purchase!',
    });
  });

  it('rejects a footer that is too long', async () => {
    const { backend } = await setupAs('admin');
    await failure(
      backend.settings.updateSettings({ receiptFooter: 'x'.repeat(501) }),
      'VALIDATION_ERROR',
    );
    await expect(backend.settings.getSettings()).resolves.toEqual({
      receiptFooter: 'Merci pour votre visite !',
    });
  });
});

describe('access', () => {
  it.each(MEMORY_OPERATIONS)(
    '%s lets in the callers the database lets in, and a refusal changes nothing',
    async (operation) => {
      for (const caller of CALLERS) {
        const { backend, prepared } = await preparedAs(caller);
        const outcome = await outcomeOf(callFor[operation](backend, prepared));
        expect(outcome, `${operation} as ${caller}`).toBe(
          outcomeUnder[accessFor[operation]][caller],
        );
        if (outcome !== 'resolved') {
          const control = await preparedAs(caller);
          expect(await observable(backend, prepared)).toEqual(
            await observable(control.backend, control.prepared),
          );
        }
      }
    },
  );

  it('refuses calls again once the user has signed out', async () => {
    const { backend } = await setupAs('admin');
    await backend.catalog.createCategory({ name: 'Surgelés', color: '#6366f1' });

    await backend.auth.signOut();

    await failure(
      backend.catalog.createCategory({ name: 'Épices', color: '#8b5cf6' }),
      'UNAUTHENTICATED',
    );
    await failure(backend.catalog.listCategories(), 'UNAUTHENTICATED');
    await signInAs(backend, 'cashier');
    const categories = await backend.catalog.listCategories();
    expect(categories.map((category) => category.name)).toEqual([
      ...DEMO_CATEGORIES.map((category) => category.name),
      'Surgelés',
    ]);
  });

  it('checks the caller first, then the id, then the input, then the rows', async () => {
    const nameless: ProductUpdateInput = { ...harissaEdit, name: '' };
    const { backend } = setup();
    await failure(backend.catalog.updateProduct('missing', nameless), 'UNAUTHENTICATED');

    await signInAs(backend, 'cashier');
    await failure(backend.catalog.updateProduct('missing', nameless), 'FORBIDDEN');

    await signInAs(backend, 'admin');
    const id = await failure(
      backend.catalog.updateProduct('missing', nameless),
      'VALIDATION_ERROR',
    );
    expect(id.details).toEqual({ field: 'id' });
    const input = await failure(
      backend.catalog.updateProduct(idNo(99), nameless),
      'VALIDATION_ERROR',
    );
    expect(input.details).toHaveProperty('issues');
    await failure(backend.catalog.updateProduct(idNo(99), harissaEdit), 'NOT_FOUND');
  });

  it('fails with a pending fault before it checks the caller', async () => {
    const { backend, faults } = setup();
    const offline = new AppError('NETWORK_ERROR', 'Offline');
    faults.failNext('catalog.createProduct', offline);

    await expect(backend.catalog.createProduct(dates)).rejects.toBe(offline);
    await failure(backend.catalog.createProduct(dates), 'UNAUTHENTICATED');
  });
});

describe('fault injection', () => {
  it('makes the next calls throw the given AppError exactly `times` times', async () => {
    const { backend, faults } = await setupAs('cashier');
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
      const { backend, faults, prepared } = await preparedAs('admin');
      // The same backend without the faulted call, to show that it changed nothing.
      const control = await preparedAs('admin');
      const fault = new AppError('SERVER_ERROR', `Fault for ${operation}`);
      faults.failNext(operation, fault);

      await expect(callFor[operation](backend, prepared)).rejects.toBe(fault);
      expect(await observable(backend, prepared)).toEqual(
        await observable(control.backend, control.prepared),
      );
      await expect(backend.auth.getState()).resolves.toEqual(await control.backend.auth.getState());

      expect(await settle(callFor[operation](backend, prepared))).toBe('resolved');
      await callFor[operation](control.backend, control.prepared);
      expect(await observable(backend, prepared)).toEqual(
        await observable(control.backend, control.prepared),
      );
    },
  );

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
    await expect(backend.auth.signIn(CREDENTIALS.admin)).rejects.toBe(any);
    expect(events).toEqual([]);
    await expect(backend.catalog.listProducts()).rejects.toBe(specific);
    await signInAs(backend, 'admin');
    await expect(backend.catalog.listProducts()).resolves.toHaveLength(12);
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

  it('creates rows with the default ids on a page that is not a secure context', async () => {
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
      const { terminalId } = await backend.terminals.register('T1');
      expect(terminalId).toMatch(UUID_V4);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('refuses an id source that returns anything but an unused lowercase UUID', async () => {
    for (const id of ['id-1', idNo(1).replace('0', 'A').toUpperCase(), BOISSONS]) {
      const backend = createMemoryBackend({ newId: () => id });
      await signInAs(backend, 'admin');
      await failure(
        backend.catalog.createCategory({ name: 'Surgelés', color: '#6366f1' }),
        'CONFIG_ERROR',
      );
      await expect(backend.catalog.listCategories()).resolves.toEqual(DEMO_CATEGORIES);
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
    await expect(backend.catalog.listCategories()).resolves.toEqual(DEMO_CATEGORIES);
  });
});
