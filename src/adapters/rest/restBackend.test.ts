/**
 * The REST adapter against MSW handlers that answer contracts/openapi.yaml (see fakeApi.ts). The
 * port contract suite in contract.test.ts covers the ledger's own rules; what these tests pin down
 * is the boundary: the paths, the session, snake_case out and camelCase in, 201 against 200, and
 * the codes an answer is read as. Where an answer has to be exactly wrong, a handler of the test's
 * own replaces the fake's for that one route.
 */
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { isAppError, type ErrorCode } from '@/lib/errors';
import { mm } from '@/lib/money';
import type { AuthState, AuthUser, DemoAccount, Sale } from '@/ports';
import type { ContractFixture } from '@/ports/__contracts__';
import {
  cartOf,
  closeRecord,
  createProduct,
  newId,
  openRecord,
  openTill,
  refundRecord,
  registerTerminal,
  saleRecord,
  timestamp,
} from '@/ports/__contracts__/support';
import { createFakeApi, demoFixture, memoryStorage, type FakeApi } from './fakeApi';
import { createRestBackend } from './index';

const server = setupServer();

let api: FakeApi;
let fixture: ContractFixture;

beforeAll(() => {
  server.listen({ onUnhandledRequest: 'error' });
});

beforeEach(async () => {
  api = createFakeApi();
  server.use(...api.handlers);
  fixture = await demoFixture(api);
});

afterEach(() => {
  server.resetHandlers();
  server.events.removeAllListeners();
});

afterAll(() => {
  server.close();
});

function apiPath(path: string): string {
  return `${api.baseUrl}/api/v1${path}`;
}

/** The demo account `user` signed in with. */
function accountOf(user: AuthUser): DemoAccount {
  const account = api.backend.demoAccounts.find((candidate) => candidate.email === user.email);
  if (!account) {
    return expect.unreachable(`The API offers no demo account for ${user.email}`);
  }
  return account;
}

/** A device of its own: its own session store, like another browser. */
function device(): ReturnType<typeof createRestBackend> {
  const storage = memoryStorage();
  return createRestBackend({
    baseUrl: api.baseUrl,
    storage: () => storage,
    storageKey: `device-${newId()}`,
  });
}

/** The statuses the API answered `method path` with, in order. */
function statusesOf(method: string, path: string): number[] {
  const statuses: number[] = [];
  server.events.on('response:mocked', ({ request, response }) => {
    if (request.method === method && new URL(request.url).pathname === `/api/v1${path}`) {
      statuses.push(response.status);
    }
  });
  return statuses;
}

/** Fails the test unless `promise` rejects with an AppError of `code`; returns its details. */
async function rejectsWith(promise: Promise<unknown>, code: ErrorCode): Promise<unknown> {
  const outcome = await promise.then(
    (value: unknown) => ({ settled: 'resolved' as const, value }),
    (error: unknown) => ({ settled: 'rejected' as const, error }),
  );
  if (outcome.settled === 'resolved') {
    return expect.unreachable(`Expected ${code}, got ${JSON.stringify(outcome.value)}`);
  }
  if (!isAppError(outcome.error)) {
    return expect.unreachable(`Expected an AppError ${code}, got ${String(outcome.error)}`);
  }
  expect(outcome.error.code, outcome.error.message).toBe(code);
  return outcome.error.details;
}

describe('the session of a device', () => {
  it('signs in, keeps the token and sends it with every later request', async () => {
    const account = accountOf(fixture.adminUser);
    const backend = device();
    await expect(backend.auth.getState()).resolves.toEqual({ status: 'anonymous' });

    const user = await backend.auth.signIn({ email: account.email, password: account.password });

    expect(user).toEqual(fixture.adminUser);
    await expect(backend.auth.getState()).resolves.toEqual({ status: 'authenticated', user });
    await expect(backend.catalog.listCategories()).resolves.toBeInstanceOf(Array);
  });

  it('keeps the session in storage, so a reload finds it again', async () => {
    const account = accountOf(fixture.cashierUser);
    const storage = memoryStorage();
    const first = createRestBackend({ baseUrl: api.baseUrl, storage: () => storage });
    const user = await first.auth.signIn({ email: account.email, password: account.password });

    // The same device after a reload: another backend over the same storage.
    const reloaded = createRestBackend({ baseUrl: api.baseUrl, storage: () => storage });

    await expect(reloaded.auth.getState()).resolves.toEqual({ status: 'authenticated', user });
  });

  it('refuses a wrong password and leaves the device signed out', async () => {
    const account = accountOf(fixture.adminUser);
    const backend = device();

    await rejectsWith(
      backend.auth.signIn({ email: account.email, password: 'not-the-password' }),
      'UNAUTHENTICATED',
    );

    await expect(backend.auth.getState()).resolves.toEqual({ status: 'anonymous' });
  });

  it('refuses a request that needs a session before anything is sent', async () => {
    await rejectsWith(device().catalog.listProducts(), 'UNAUTHENTICATED');
  });

  it('signs out on this device only', async () => {
    const account = accountOf(fixture.adminUser);
    const backend = device();
    await backend.auth.signIn({ email: account.email, password: account.password });

    await backend.auth.signOut();

    await expect(backend.auth.getState()).resolves.toEqual({ status: 'anonymous' });
    await rejectsWith(backend.settings.getSettings(), 'UNAUTHENTICATED');
    // The other device keeps working: nothing was revoked for it.
    await expect(fixture.admin.settings.getSettings()).resolves.toBeDefined();
  });

  it('stays offline while the API cannot be reached, on the session this device holds', async () => {
    const account = accountOf(fixture.cashierUser);
    const backend = device();
    const user = await backend.auth.signIn({ email: account.email, password: account.password });

    server.use(http.get(apiPath('/me'), () => HttpResponse.error()));
    await expect(backend.auth.getState()).resolves.toEqual({ status: 'offline', user });

    // The session is still there when the API answers again.
    server.resetHandlers(...api.handlers);
    await expect(backend.auth.getState()).resolves.toEqual({ status: 'authenticated', user });
  });

  it('drops a session the API refuses, and stays signed out afterwards', async () => {
    const account = accountOf(fixture.adminUser);
    const backend = device();
    await backend.auth.signIn({ email: account.email, password: account.password });

    server.use(
      http.get(apiPath('/me'), () =>
        HttpResponse.json(
          { error: { code: 'UNAUTHENTICATED', message: 'The token has expired.' } },
          { status: 401 },
        ),
      ),
    );
    await expect(backend.auth.getState()).resolves.toEqual({ status: 'anonymous' });

    server.resetHandlers(...api.handlers);
    await expect(backend.auth.getState()).resolves.toEqual({ status: 'anonymous' });
  });

  it('tells listeners about a sign-in and a sign-out until they unsubscribe', async () => {
    const account = accountOf(fixture.adminUser);
    const backend = device();
    const seen: AuthState[] = [];
    const unsubscribe = backend.auth.onStateChange((state) => seen.push(state));

    const user = await backend.auth.signIn({ email: account.email, password: account.password });
    await backend.auth.signOut();
    unsubscribe();
    await backend.auth.signIn({ email: account.email, password: account.password });

    expect(seen).toEqual([{ status: 'authenticated', user }, { status: 'anonymous' }]);
  });
});

describe('the wire', () => {
  it('sends a record as snake_case, with the payload hash exactly as it was written', async () => {
    const product = await createProduct(fixture, 'water', 750, 10);
    const till = await openTill(fixture);
    const record = await saleRecord(till, 1, cartOf([[product, 2]]));
    let sent: unknown;
    server.use(
      http.post(apiPath('/sales'), async ({ request }) => {
        sent = await request.json();
        return HttpResponse.json(
          { sale_id: record.id, receipt_number: `${record.terminalCode}-1`, status: 'created' },
          { status: 201 },
        );
      }),
    );

    await fixture.cashier.sales.recordSale(record);

    expect(sent).toEqual({
      id: record.id,
      kind: 'sale',
      terminal_code: till.terminal.terminalCode,
      epoch: till.terminal.epoch,
      seq: 1,
      session_id: till.sessionId,
      // A counter sale: it sat on no table, and its line pays no item of one.
      table_id: null,
      created_at: record.createdAt,
      lines: [
        {
          // The device names its own rows, so a refund written offline can point at this line.
          id: record.lines[0].id,
          line_no: 1,
          open_order_item_id: null,
          product_id: product.id,
          product_name: product.name,
          qty: 2,
          unit_price_millimes: 750,
          line_discount_millimes: 0,
          line_discount_reason: null,
          allocated_discount_millimes: 0,
          net_millimes: 1_500,
          refunds_sale_line_id: null,
        },
      ],
      cart_discount_millimes: 0,
      total_millimes: 1_500,
      payment: { method: 'cash', tendered_millimes: 1_500, change_millimes: 0 },
      refunds_sale_id: null,
      payload_hash: record.payloadHash,
    });
  });

  it('sends a close record with its client Z-report renamed at every depth', async () => {
    const till = await openTill(fixture, mm(20_000));
    const clientZReport = await fixture.cashier.sessions.zReport(till.sessionId);
    const record = await closeRecord(
      till.terminal,
      till.sessionId,
      fixture.cashierUser.id,
      mm(20_000),
      { clientZReport },
    );
    let sent: unknown;
    server.use(
      http.post(apiPath(`/cash-sessions/${till.sessionId}/closures`), async ({ request }) => {
        sent = await request.json();
        return HttpResponse.json(
          { session_id: till.sessionId, status: 'created', z_report: null },
          { status: 201 },
        );
      }),
    );

    // The answer's z_report is null, which no Z-report may be: the call fails, the request stands.
    await rejectsWith(fixture.cashier.sessions.close(record), 'VALIDATION_ERROR');

    expect(sent).toMatchObject({
      session_id: till.sessionId,
      terminal_code: till.terminal.terminalCode,
      actor_user_id: fixture.cashierUser.id,
      closing_counted_millimes: 20_000,
      payload_hash: record.payloadHash,
      client_z_report: {
        session_id: till.sessionId,
        opening_float_millimes: 20_000,
        by_method: {
          cash: { sales_millimes: 0, refunds_millimes: 0, net_millimes: 0 },
          card: { sales_millimes: 0, refunds_millimes: 0, net_millimes: 0 },
        },
        expected_cash_millimes: 20_000,
        // The report the register computed while the session was still open, nulls and all.
        counted_cash_millimes: null,
        variance_millimes: null,
        voids_count: 0,
      },
    });
  });

  it('reads an answer as camelCase, money included', async () => {
    const saleId = newId();
    const wireSale = {
      id: saleId,
      kind: 'sale',
      receipt_number: 'T1-7',
      seq: 7,
      terminal_id: newId(),
      terminal_code: 'T1',
      session_id: newId(),
      // A table paid at the counter: the table and the item its line paid travel with the sale.
      table_id: newId(),
      table_name: 'Terrasse 2',
      refunds_sale_id: null,
      payment_method: 'cash',
      cart_discount_millimes: 500,
      total_millimes: 12_000,
      tendered_millimes: 20_000,
      change_millimes: 8_000,
      created_at: timestamp(),
      received_at: timestamp(),
      lines: [
        {
          id: newId(),
          line_no: 1,
          open_order_item_id: newId(),
          product_id: newId(),
          product_name: 'Olive oil',
          qty: 1,
          unit_price_millimes: 12_500,
          line_discount_millimes: 0,
          line_discount_reason: null,
          allocated_discount_millimes: 500,
          net_millimes: 12_000,
          refunds_sale_line_id: null,
          refunded_qty: 0,
          refunded_millimes: 0,
        },
      ],
    };
    server.use(
      http.get(apiPath(`/sales/${saleId}`), () => HttpResponse.json(wireSale, { status: 200 })),
    );

    const sale: Sale = await fixture.cashier.sales.getSale(saleId);

    expect(sale).toEqual({
      id: saleId,
      kind: 'sale',
      receiptNumber: 'T1-7',
      seq: 7,
      terminalId: wireSale.terminal_id,
      terminalCode: 'T1',
      sessionId: wireSale.session_id,
      tableId: wireSale.table_id,
      tableName: 'Terrasse 2',
      refundsSaleId: null,
      paymentMethod: 'cash',
      cartDiscountMillimes: 500,
      totalMillimes: 12_000,
      tenderedMillimes: 20_000,
      changeMillimes: 8_000,
      createdAt: wireSale.created_at,
      receivedAt: wireSale.received_at,
      lines: [
        {
          id: wireSale.lines[0].id,
          lineNo: 1,
          openOrderItemId: wireSale.lines[0].open_order_item_id,
          productId: wireSale.lines[0].product_id,
          productName: 'Olive oil',
          qty: 1,
          unitPriceMillimes: 12_500,
          lineDiscountMillimes: 0,
          lineDiscountReason: null,
          allocatedDiscountMillimes: 500,
          netMillimes: 12_000,
          refundsSaleLineId: null,
          refundedQty: 0,
          refundedMillimes: 0,
        },
      ],
    });
  });

  it('refuses an answer the port schema cannot read, however well-formed the JSON is', async () => {
    server.use(
      http.get(apiPath('/products'), () =>
        HttpResponse.json([{ id: 'p1', name: 'Water', price_millimes: 'free' }], { status: 200 }),
      ),
    );

    await rejectsWith(fixture.cashier.catalog.listProducts(), 'VALIDATION_ERROR');
  });

  it('normalises a terminal code before it reaches the path', async () => {
    const paths: string[] = [];
    server.events.on('request:start', ({ request }) => {
      paths.push(new URL(request.url).pathname);
    });

    const registration = await fixture.admin.terminals.register(' cash1 ');

    expect(registration.code).toBe('CASH1');
    expect(paths).toContain('/api/v1/terminals/CASH1/registrations');
  });
});

describe('a record write', () => {
  it('reads 201 as created and 200 as replayed, for a sale', async () => {
    const statuses = statusesOf('POST', '/sales');
    const product = await createProduct(fixture, 'bread', 190, 10);
    const till = await openTill(fixture);
    const record = await saleRecord(till, 1, cartOf([[product, 1]]), { method: 'card' });

    const created = await fixture.cashier.sales.recordSale(record);
    const replayed = await fixture.cashier.sales.recordSale(record);

    expect(created.status).toBe('created');
    expect(replayed.status).toBe('replayed');
    expect(replayed.receiptNumber).toBe(created.receiptNumber);
    expect(statuses).toEqual([201, 200]);
  });

  it('reads 201 as created and 200 as replayed, for opening and closing a session', async () => {
    const opens = statusesOf('POST', '/cash-sessions');
    const registered = await registerTerminal(fixture);
    const open = await openRecord(registered.terminal, fixture.cashierUser.id, mm(10_000));

    await expect(fixture.cashier.sessions.open(open)).resolves.toMatchObject({
      status: 'created',
    });
    await expect(fixture.cashier.sessions.open(open)).resolves.toMatchObject({
      status: 'replayed',
    });
    expect(opens).toEqual([201, 200]);

    const closures = statusesOf('POST', `/cash-sessions/${open.id}/closures`);
    const close = await closeRecord(
      registered.terminal,
      open.id,
      fixture.cashierUser.id,
      mm(10_000),
    );
    const closed = await fixture.cashier.sessions.close(close);
    const again = await fixture.cashier.sessions.close(close);

    expect(closed.status).toBe('created');
    expect(again).toEqual({ ...closed, status: 'replayed' });
    expect(closures).toEqual([201, 200]);
  });

  it('reads 201 as voided and 200 as replayed or recorded, for a receipt void', async () => {
    const statuses = statusesOf('POST', '/receipt-voids');
    const product = await createProduct(fixture, 'tea', 4_200, 10);
    const till = await openTill(fixture);
    const sale = await saleRecord(till, 1, cartOf([[product, 1]]));
    await fixture.cashier.sales.recordSale(sale);
    const stuck = await refundRecord(till, 2, await fixture.cashier.sales.getSale(sale.id), [
      { lineNo: 1, qty: 1 },
    ]);
    await fixture.cashier.sessions.close(
      await closeRecord(till.terminal, till.sessionId, fixture.cashierUser.id, mm(24_200)),
    );
    const input = { record: stuck, errorCode: 'SESSION_CLOSED', reason: 'Sold after the close' };

    const voided = await fixture.admin.sales.voidReceipt(input);
    const replayed = await fixture.admin.sales.voidReceipt(input);
    // The sale did reach the ledger, so its number is not voided but reported as recorded.
    const recorded = await fixture.admin.sales.voidReceipt({ ...input, record: sale });

    expect(voided.status).toBe('voided');
    expect(replayed.status).toBe('replayed');
    expect(recorded.status).toBe('recorded');
    expect(statuses).toEqual([201, 200, 200]);
  });

  it('refuses an outcome that contradicts the status line', async () => {
    const product = await createProduct(fixture, 'milk', 1_350, 10);
    const till = await openTill(fixture);
    const record = await saleRecord(till, 1, cartOf([[product, 1]]), { method: 'card' });
    const answer = { sale_id: record.id, receipt_number: `${record.terminalCode}-1` };

    server.use(
      http.post(apiPath('/sales'), () =>
        HttpResponse.json({ ...answer, status: 'created' }, { status: 200 }),
      ),
    );
    await rejectsWith(fixture.cashier.sales.recordSale(record), 'VALIDATION_ERROR');

    server.use(
      http.post(apiPath('/sales'), () =>
        HttpResponse.json({ ...answer, status: 'replayed' }, { status: 201 }),
      ),
    );
    await rejectsWith(fixture.cashier.sales.recordSale(record), 'VALIDATION_ERROR');
  });
});

describe('an error the API answers with', () => {
  const codes: readonly (readonly [ErrorCode, number])[] = [
    ['RATE_LIMITED', 429],
    ['SERVER_ERROR', 500],
    ['UNAUTHENTICATED', 401],
    ['NOT_FOUND', 404],
  ];

  it.each(codes)('reaches the port as %s when the envelope says so', async (code, status) => {
    server.use(
      http.get(apiPath('/products'), () =>
        HttpResponse.json({ error: { code, message: 'Told to a person.' } }, { status }),
      ),
    );

    await rejectsWith(fixture.cashier.catalog.listProducts(), code);
  });

  it.each(codes)('reaches the port as %s when only the status says so', async (code, status) => {
    server.use(http.get(apiPath('/products'), () => new HttpResponse('nginx', { status })));

    await rejectsWith(fixture.cashier.catalog.listProducts(), code);
  });

  it('keeps the details of a conflict, renamed for the app', async () => {
    const product = await createProduct(fixture, 'dates', 3_000, 10);
    const till = await openTill(fixture);

    const details = await rejectsWith(
      fixture.cashier.sales.recordSale(await saleRecord(till, 4, cartOf([[product, 1]]))),
      'SEQUENCE_GAP',
    );

    expect(details).toMatchObject({ expectedSeq: 1, receivedSeq: 4, status: 409 });
  });

  it('is NETWORK_ERROR when the API cannot be reached at all', async () => {
    server.use(http.get(apiPath('/products'), () => HttpResponse.error()));

    await rejectsWith(fixture.cashier.catalog.listProducts(), 'NETWORK_ERROR');
  });
});

describe('the settings port', () => {
  it('reads the shop settings and lets an admin change them', async () => {
    const before = await fixture.admin.settings.getSettings();
    expect(typeof before.receiptFooter).toBe('string');

    const saved = await fixture.admin.settings.updateSettings({ receiptFooter: 'Merci !' });

    expect(saved).toEqual({ receiptFooter: 'Merci !' });
    await expect(fixture.cashier.settings.getSettings()).resolves.toEqual({
      receiptFooter: 'Merci !',
    });
  });

  it('refuses a footer above the limit before sending it, and a cashier at the API', async () => {
    await rejectsWith(
      fixture.admin.settings.updateSettings({ receiptFooter: 'x'.repeat(501) }),
      'VALIDATION_ERROR',
    );
    await rejectsWith(
      fixture.cashier.settings.updateSettings({ receiptFooter: 'From the till' }),
      'FORBIDDEN',
    );

    await expect(fixture.admin.settings.getSettings()).resolves.not.toEqual({
      receiptFooter: 'From the till',
    });
  });
});
