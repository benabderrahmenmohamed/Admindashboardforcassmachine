/**
 * Row-level security and the append-only ledger on the local Supabase stack, against
 * supabase/seed.sql (`npm run db:start`, then `npm run db:reset`).
 *
 * Runs only with CONTRACT_BACKEND=supabase and is skipped otherwise. It reads:
 *   SUPABASE_URL               the local API URL, http://127.0.0.1:54321 by default (`supabase status`)
 *   SUPABASE_ANON_KEY          the anon key from `supabase status`; the seeded accounts sign in with it
 *   SUPABASE_SERVICE_ROLE_KEY  the service role key from `supabase status`; it bypasses row-level
 *                              security, so it only reads rows back, and tries the writes nobody
 *                              may make
 * and signs in the seeded accounts of shop A (admin@demo.local, cashier@demo.local,
 * waiter@demo.local) and shop B (other-admin@demo.local, other-cashier@demo.local,
 * other-waiter@demo.local).
 */
import { createClient } from '@supabase/supabase-js';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { keysToCamel, keysToSnake } from '@/lib/caseConversion';
import { mm } from '@/lib/money';
import { withPayloadHash } from '@/lib/payloadHash';
import {
  openSessionResultSchema,
  productSchema,
  terminalRegistrationSchema,
  type OpenSessionRecord,
  type Product,
  type SaleRecord,
  type TerminalRegistration,
} from '@/ports';
import { contractBackendIs, freshTerminalCode, requireTestEnv } from '@/ports/__contracts__';
import {
  cartOf,
  closeRecord,
  contextOf,
  failure,
  newId,
  openRecord,
  rewrite,
  saleRecord,
  timestamp,
  type Till,
} from '@/ports/__contracts__/support';
import type { SupabaseDatabaseClient } from './client';
import type { Database, Json } from './database.types';
import { toAuthAppError, unwrap } from './errors';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

const SHOP_A = '11111111-1111-4111-8111-111111111111';
const CASHIER_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2';
const CASHIER_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2';

/** The seeded accounts, as supabase/seed.sql creates them. */
const ACCOUNTS = {
  adminA: ['admin@demo.local', 'demo-admin-2026'],
  cashierA: ['cashier@demo.local', 'demo-cashier-2026'],
  waiterA: ['waiter@demo.local', 'demo-waiter-2026'],
  adminB: ['other-admin@demo.local', 'other-admin-2026'],
  cashierB: ['other-cashier@demo.local', 'other-cashier-2026'],
  waiterB: ['other-waiter@demo.local', 'other-waiter-2026'],
} as const;

const WITHOUT_STORAGE = {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
};

function client(key: string): SupabaseDatabaseClient {
  return createClient<Database>(requireTestEnv('SUPABASE_URL'), key, WITHOUT_STORAGE);
}

async function signedIn(account: keyof typeof ACCOUNTS): Promise<SupabaseDatabaseClient> {
  const [email, password] = ACCOUNTS[account];
  const signedInClient = client(requireTestEnv('SUPABASE_ANON_KEY'));
  const { error } = await signedInClient.auth.signInWithPassword({ email, password });
  if (error) {
    throw toAuthAppError(error);
  }
  return signedInClient;
}

/** A port value on the wire: snake_case keys, nothing else changed. */
function wire(value: unknown): Json {
  return keysToSnake(value) as Json;
}

async function registerTerminal(admin: SupabaseDatabaseClient): Promise<TerminalRegistration> {
  const data = await unwrap(admin.rpc('register_terminal', { p_code: freshTerminalCode() }));
  return terminalRegistrationSchema.parse(keysToCamel(data));
}

/**
 * An item a waiter adds to a table, as the adapter sends it: the record in snake_case with
 * `added_at` beside its `created_at`. Adding is what creates the table's open order.
 */
async function addItemPayload(tableId: string, productId: string): Promise<Json> {
  const createdAt = timestamp();
  const record = await withPayloadHash({
    id: newId(),
    deviceId: 'security-test',
    createdAt,
    tableId,
    productId,
    qty: 1,
    note: '',
  });
  return wire({ ...record, addedAt: createdAt });
}

/** The first table of the shop the caller belongs to; row-level security shows no other shop's. */
async function firstTable(reader: SupabaseDatabaseClient): Promise<string> {
  const rows = await unwrap(
    reader.from('dining_tables').select('id').eq('is_active', true).order('sort_order').limit(1),
  );
  return rows[0]?.id ?? expect.unreachable('supabase/seed.sql has no active dining table');
}

async function createProduct(admin: SupabaseDatabaseClient): Promise<Product> {
  const input = {
    name: `Security ${newId().slice(0, 8)}`,
    priceMillimes: 1_500,
    categoryId: null,
    barcode: null,
    description: '',
    imageUrl: '',
    stockDelta: 10,
  };
  const data = await unwrap(admin.rpc('save_product', { p: wire(input) }));
  return productSchema.parse(keysToCamel(data));
}

type RowsOf = (
  reader: SupabaseDatabaseClient,
  shopId: string,
) => PromiseLike<{ readonly data: readonly unknown[] | null; readonly error: unknown }>;

/** One row of `shopId` from every table that holds shop data. */
const SHOP_TABLES: Readonly<Record<string, RowsOf>> = {
  shops: (reader, shopId) => reader.from('shops').select('id').eq('id', shopId).limit(1),
  profiles: (reader, shopId) =>
    reader.from('profiles').select('shop_id').eq('shop_id', shopId).limit(1),
  categories: (reader, shopId) =>
    reader.from('categories').select('shop_id').eq('shop_id', shopId).limit(1),
  products: (reader, shopId) =>
    reader.from('products').select('shop_id').eq('shop_id', shopId).limit(1),
  dining_tables: (reader, shopId) =>
    reader.from('dining_tables').select('shop_id').eq('shop_id', shopId).limit(1),
  open_orders: (reader, shopId) =>
    reader.from('open_orders').select('shop_id').eq('shop_id', shopId).limit(1),
  open_order_items: (reader, shopId) =>
    reader.from('open_order_items').select('shop_id').eq('shop_id', shopId).limit(1),
  stock_movements: (reader, shopId) =>
    reader.from('stock_movements').select('shop_id').eq('shop_id', shopId).limit(1),
  shop_settings: (reader, shopId) =>
    reader.from('shop_settings').select('shop_id').eq('shop_id', shopId).limit(1),
  terminals: (reader, shopId) =>
    reader.from('terminals').select('shop_id').eq('shop_id', shopId).limit(1),
  cash_sessions: (reader, shopId) =>
    reader.from('cash_sessions').select('shop_id').eq('shop_id', shopId).limit(1),
  sales: (reader, shopId) => reader.from('sales').select('shop_id').eq('shop_id', shopId).limit(1),
  sale_lines: (reader, shopId) =>
    reader.from('sale_lines').select('shop_id').eq('shop_id', shopId).limit(1),
  receipt_voids: (reader, shopId) =>
    reader.from('receipt_voids').select('shop_id').eq('shop_id', shopId).limit(1),
  legacy_orders: (reader, shopId) =>
    reader.from('legacy_orders').select('shop_id').eq('shop_id', shopId).limit(1),
};

/** Tables the seed and beforeAll leave without a row of shop A. */
const EMPTY_FOR_SHOP_A: ReadonlySet<string> = new Set(['legacy_orders']);

/** A write the database refused, with an error or by changing no row. */
function expectRefused(
  result: { readonly data: readonly unknown[] | null; readonly error: unknown },
  what: string,
): void {
  if (result.error === null) {
    expect(result.data, `${what} changed rows`).toEqual([]);
  }
}

describe.runIf(contractBackendIs('supabase'))('Supabase row-level security and ledger', () => {
  let service: SupabaseDatabaseClient;
  let adminA: SupabaseDatabaseClient;
  let cashierA: SupabaseDatabaseClient;
  let waiterA: SupabaseDatabaseClient;
  let adminB: SupabaseDatabaseClient;
  let cashierB: SupabaseDatabaseClient;
  let waiterB: SupabaseDatabaseClient;
  /** A terminal of shop A with an open session, a recorded sale (T-1) and a voided receipt (T-2). */
  let tillA: Till;
  let openA: OpenSessionRecord;
  let saleA: SaleRecord;
  /** A table of shop A a waiter has put an item on, so it has an open order with an item. */
  let tableA: string;

  beforeAll(async () => {
    service = client(requireTestEnv('SUPABASE_SERVICE_ROLE_KEY'));
    adminA = await signedIn('adminA');
    cashierA = await signedIn('cashierA');
    waiterA = await signedIn('waiterA');
    adminB = await signedIn('adminB');
    cashierB = await signedIn('cashierB');
    waiterB = await signedIn('waiterB');

    const registration = await registerTerminal(adminA);
    const product = await createProduct(adminA);
    tableA = await firstTable(adminA);
    await unwrap(waiterA.rpc('order_item_add', { p: await addItemPayload(tableA, product.id) }));
    openA = await openRecord(contextOf(registration), CASHIER_A, mm(10_000));
    const opened = openSessionResultSchema.parse(
      keysToCamel(await unwrap(cashierA.rpc('open_session', { p: wire(openA) }))),
    );
    tillA = {
      terminalId: registration.terminalId,
      terminal: contextOf(registration),
      sessionId: opened.sessionId,
      openingFloatMillimes: mm(10_000),
    };
    saleA = await saleRecord(tillA, 1, cartOf([[product, 2]]), { method: 'card' });
    await unwrap(cashierA.rpc('record_sale', { p: wire(saleA) }));
    const abandoned = await saleRecord(tillA, 2, cartOf([[product, 1]]), { method: 'card' });
    await unwrap(
      adminA.rpc('void_receipt', {
        p: wire({ record: abandoned, errorCode: 'VALIDATION_ERROR', reason: 'Security test' }),
      }),
    );
  });

  it.each(['cashier', 'waiter'])(
    'shows a %s of shop B no row of shop A in any table',
    async (role) => {
      const reader = role === 'waiter' ? waiterB : cashierB;
      for (const [table, rowsOf] of Object.entries(SHOP_TABLES)) {
        const seen = await rowsOf(reader, SHOP_A);
        expect(seen.error, table).toBeNull();
        expect(seen.data, `rows of shop A in ${table}`).toEqual([]);
        if (!EMPTY_FOR_SHOP_A.has(table)) {
          // Not vacuous: the rows are there.
          const stored = await rowsOf(service, SHOP_A);
          expect(stored.data, `rows of shop A stored in ${table}`).toHaveLength(1);
        }
      }
    },
  );

  // A waiter takes orders and is never a till: the ledger is for cashiers and admins.
  it('refuses a waiter of the same shop the sale RPCs, and moves no number', async () => {
    const product = await createProduct(adminA);
    const record = await saleRecord(tillA, 3, cartOf([[product, 1]]), { method: 'card' });
    const lastSeq = async () =>
      (
        await unwrap(
          service.from('terminals').select('last_seq').eq('id', tillA.terminalId).single(),
        )
      ).last_seq;
    const before = await lastSeq();

    await failure(unwrap(waiterA.rpc('record_sale', { p: wire(record) })), 'FORBIDDEN');

    expect(await lastSeq()).toBe(before);
    await expect(unwrap(service.from('sales').select('id').eq('id', record.id))).resolves.toEqual(
      [],
    );
  });

  it('refuses a waiter of shop B the open order of a table of shop A', async () => {
    const productB = await createProduct(adminB);
    const itemA = await unwrap(
      service.from('open_order_items').select('id').eq('shop_id', SHOP_A).limit(1).single(),
    );

    // Adding to another shop's table: only TABLE_INACTIVE and FORBIDDEN refuse an add.
    await failure(
      unwrap(waiterB.rpc('order_item_add', { p: await addItemPayload(tableA, productB.id) })),
      'FORBIDDEN',
    );
    // An item of another shop does not exist for this caller (contracts/errors.md).
    await failure(
      unwrap(
        waiterB.rpc('order_item_remove', {
          p: wire(
            await withPayloadHash({
              id: newId(),
              deviceId: 'security-test',
              createdAt: timestamp(),
              itemId: itemA.id,
              reason: 'Not ours',
            }),
          ),
        }),
      ),
      'ITEM_NOT_FOUND',
    );

    // Shop A's table is untouched: its item is still on it, and no order of shop B was opened.
    const item = await unwrap(
      service.from('open_order_items').select('removed_at, order_id').eq('id', itemA.id).single(),
    );
    expect(item.removed_at).toBeNull();
    const ordersB = await unwrap(
      service.from('open_orders').select('id').eq('table_id', tableA).neq('shop_id', SHOP_A),
    );
    expect(ordersB).toEqual([]);
  });

  it('refuses shop B every RPC that names a terminal, record, session or person of shop A', async () => {
    const registration = await registerTerminal(adminB);
    const terminalB = contextOf(registration);
    const productB = await createProduct(adminB);
    const tillB: Till = { ...tillA, terminalId: registration.terminalId, terminal: terminalB };
    const cartB = cartOf([[productB, 1]]);

    // A terminal of shop A.
    await failure(
      unwrap(
        cashierB.rpc('record_sale', {
          p: wire(
            await saleRecord(tillB, 1, cartB, { method: 'card' }, { terminal: tillA.terminal }),
          ),
        }),
      ),
      'FORBIDDEN',
    );
    // The id of a sale of shop A, sent through a terminal of shop B.
    const borrowed = await rewrite(saleA, {
      terminalCode: terminalB.terminalCode,
      epoch: terminalB.epoch,
    });
    await failure(unwrap(cashierB.rpc('record_sale', { p: wire(borrowed) })), 'FORBIDDEN');
    // A session of shop A.
    await failure(
      unwrap(
        cashierB.rpc('record_sale', {
          p: wire(await saleRecord(tillB, 1, cartB, { method: 'card' })),
        }),
      ),
      'FORBIDDEN',
    );
    // The id of a session of shop A, opened again in shop B.
    await failure(
      unwrap(
        cashierB.rpc('open_session', {
          p: wire(await openRecord(terminalB, CASHIER_B, mm(0), openA.id)),
        }),
      ),
      'FORBIDDEN',
    );
    // A cashier of shop A as the person who opens a session in shop B.
    await failure(
      unwrap(
        cashierB.rpc('open_session', { p: wire(await openRecord(terminalB, CASHIER_A, mm(0))) }),
      ),
      'FORBIDDEN',
    );
    // Closing a session of shop A.
    await failure(
      unwrap(
        cashierB.rpc('close_session', {
          p: wire(await closeRecord(terminalB, tillA.sessionId, CASHIER_B, mm(0))),
        }),
      ),
      'FORBIDDEN',
    );
    // Voiding a sale of shop A.
    await failure(
      unwrap(
        adminB.rpc('void_receipt', {
          p: wire({ record: borrowed, errorCode: 'VALIDATION_ERROR', reason: 'Not ours' }),
        }),
      ),
      'FORBIDDEN',
    );

    // Reading the Z-report of a session of shop A, or force-closing it.
    await failure(unwrap(cashierB.rpc('z_report', { p_session_id: tillA.sessionId })), 'FORBIDDEN');
    await failure(
      unwrap(
        adminB.rpc('force_close_session', { p_session_id: tillA.sessionId, p_reason: 'Not ours' }),
      ),
      'FORBIDDEN',
    );

    // Nothing moved: shop A's session is open and shop B's terminal used no number.
    const session = await unwrap(
      service.from('cash_sessions').select('closed_at').eq('id', tillA.sessionId).single(),
    );
    expect(session.closed_at).toBeNull();
    const terminal = await unwrap(
      service.from('terminals').select('last_seq').eq('id', registration.terminalId).single(),
    );
    expect(terminal.last_seq).toBe(0);
  });

  it('lets nobody update or delete a sale or its lines, and the rows stay exactly as they were', async () => {
    const saleRow = () => service.from('sales').select('*').eq('id', saleA.id).single();
    const lineRows = () =>
      service.from('sale_lines').select('*').eq('sale_id', saleA.id).order('line_no');
    const sale = await unwrap(saleRow());
    const lines = await unwrap(lineRows());
    expect(lines).toHaveLength(saleA.lines.length);

    const writers = [
      ['cashier', cashierA],
      ['admin', adminA],
      ['service role', service],
    ] as const;
    for (const [writer, writerClient] of writers) {
      expectRefused(
        await writerClient.from('sales').update({ total_millimes: 0 }).eq('id', saleA.id).select(),
        `${writer}: update sales`,
      );
      expectRefused(
        await writerClient.from('sales').delete().eq('id', saleA.id).select(),
        `${writer}: delete sales`,
      );
      expectRefused(
        await writerClient.from('sale_lines').update({ qty: 99 }).eq('sale_id', saleA.id).select(),
        `${writer}: update sale_lines`,
      );
      expectRefused(
        await writerClient.from('sale_lines').delete().eq('sale_id', saleA.id).select(),
        `${writer}: delete sale_lines`,
      );
    }

    await expect(unwrap(saleRow())).resolves.toEqual(sale);
    await expect(unwrap(lineRows())).resolves.toEqual(lines);
  });
});
