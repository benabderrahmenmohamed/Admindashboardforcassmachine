import { describe, expect, it } from 'vitest';
import {
  addItem,
  emptyCart,
  setCartDiscount,
  setLineDiscount,
  type Cart,
  type CartProduct,
} from '@/features/pos/cart';
import {
  buildRefundRecord,
  buildSaleRecord,
  type RecordEnvelope,
  type RefundSelection,
} from '@/features/sales/records';
import { buildCloseSessionRecord, buildOpenSessionRecord } from '@/features/sessions/records';
import { computeZReport, sameZReport } from '@/features/sessions/zReport';
import { createTerminalStore, type KeyValueStorage } from '@/features/terminal/terminalStore';
import type { TerminalContext } from '@/features/terminal/types';
import { AppError, isAppError, type ErrorCode } from '@/lib/errors';
import { mm, ZERO, type Millimes } from '@/lib/money';
import { withPayloadHash } from '@/lib/payloadHash';
import {
  MAX_PRICE_MILLIMES,
  type AuthUser,
  type CloseSessionRecord,
  type Credentials,
  type OpenSessionRecord,
  type PaymentMethod,
  type Sale,
  type SaleRecord,
} from '@/ports';
import {
  createMemoryBackend,
  DEMO_SHOP_ID,
  defaultSeed,
  OTHER_SHOP_ID,
  type MemoryBackend,
} from './index';

/*
 * Terminals, sessions and sales beyond the port contract (src/ports/__contracts__): the order of
 * checks down to the values of a record, the other shop, stock movements, voids, and the
 * credential-free demo from sign-in to Z-report.
 */

const START = Date.UTC(2026, 8, 11, 9, 0, 0);
const OPENED_AT = '2026-09-11T08:00:00.000Z';
const CREATED_AT = '2026-09-11T10:00:00.000Z';
const CLOSED_AT = '2026-09-11T20:00:00.000Z';

const CREDENTIALS = {
  admin: { email: 'admin@demo.local', password: 'demo-admin-2026' },
  cashier: { email: 'cashier@demo.local', password: 'demo-cashier-2026' },
  otherAdmin: { email: 'other-admin@demo.local', password: 'other-admin-2026' },
  otherCashier: { email: 'other-cashier@demo.local', password: 'other-cashier-2026' },
} satisfies Record<string, Credentials>;

function isoAt(seconds: number): string {
  return new Date(START + seconds * 1000).toISOString();
}

function seeded(id: string): CartProduct {
  const product = defaultSeed.products.find((candidate) => candidate.id === id);
  if (!product) {
    throw new AppError('CONFIG_ERROR', `The default seed has no product ${id}`);
  }
  return { id: product.id, name: product.name, priceMillimes: product.priceMillimes };
}

/** 0,850 DT, 120 in stock. */
const WATER = seeded('55555555-5555-4555-8555-555555555501');
/** 1,900 DT, 8 in stock. */
const YAOURT = seeded('55555555-5555-4555-8555-555555555503');
/** 2,450 DT, 40 in stock. */
const HARISSA = seeded('55555555-5555-4555-8555-555555555504');
/** The other shop's, 1,000 DT. */
const OTHER_A = seeded('66666666-6666-4666-8666-666666666601');

function newId(): string {
  return crypto.randomUUID();
}

async function failure(promise: Promise<unknown>, code: ErrorCode): Promise<AppError> {
  const outcome = await promise.then(
    () => 'resolved',
    (error: unknown) => error,
  );
  if (!isAppError(outcome)) {
    return expect.unreachable(`Expected an AppError ${code}, got ${String(outcome)}`);
  }
  expect(outcome.code, outcome.message).toBe(code);
  return outcome;
}

/**
 * A backend with a clock that ticks one second per read, and a client signed in for each seeded
 * member: the demo shop's admin and cashier, and the other shop's.
 */
async function setup() {
  let ticks = 0;
  const backend = createMemoryBackend({
    now: () => {
      ticks += 1;
      return new Date(START + ticks * 1000);
    },
  });
  const signedIn = async (credentials: Credentials) => {
    const client = backend.connect();
    return { client, user: await client.auth.signIn(credentials) };
  };
  const admin = await signedIn(CREDENTIALS.admin);
  const cashier = await signedIn(CREDENTIALS.cashier);
  const otherAdmin = await signedIn(CREDENTIALS.otherAdmin);
  const otherCashier = await signedIn(CREDENTIALS.otherCashier);
  return {
    backend,
    admin: admin.client,
    adminUser: admin.user,
    cashier: cashier.client,
    cashierUser: cashier.user,
    otherAdmin: otherAdmin.client,
    otherCashier: otherCashier.client,
    otherCashierUser: otherCashier.user,
  };
}

/** A registered terminal with an open session. */
interface Till {
  readonly terminalId: string;
  readonly terminal: TerminalContext;
  readonly sessionId: string;
}

function contextOf(registration: { readonly code: string; readonly epoch: number }) {
  return { terminalCode: registration.code, epoch: registration.epoch };
}

function openRecord(
  terminal: TerminalContext,
  actorUserId: string,
  openingFloatMillimes: Millimes,
  id = newId(),
): Promise<OpenSessionRecord> {
  return buildOpenSessionRecord({
    id,
    terminal,
    actorUserId,
    openedAt: OPENED_AT,
    openingFloatMillimes,
  });
}

function closeRecord(
  till: Pick<Till, 'terminal' | 'sessionId'>,
  actorUserId: string,
  closingCountedMillimes: Millimes,
): Promise<CloseSessionRecord> {
  return buildCloseSessionRecord({
    id: newId(),
    sessionId: till.sessionId,
    terminal: till.terminal,
    actorUserId,
    closedAt: CLOSED_AT,
    closingCountedMillimes,
    clientZReport: null,
  });
}

/** Registers `code` as `admin` and opens a session on it through `cashier`, for `actor`. */
async function openTill(
  admin: MemoryBackend,
  cashier: MemoryBackend,
  actor: AuthUser,
  code = 'T1',
): Promise<Till> {
  const registration = await admin.terminals.register(code);
  const terminal = contextOf(registration);
  const record = await openRecord(terminal, actor.id, mm(50_000));
  await expect(cashier.sessions.open(record)).resolves.toMatchObject({ status: 'created' });
  return { terminalId: registration.terminalId, terminal, sessionId: record.id };
}

function cartOf(...items: readonly (readonly [CartProduct, number])[]): Cart {
  return items.reduce<Cart>((cart, [product, qty]) => addItem(cart, product, qty), emptyCart);
}

type Tender = Parameters<typeof buildSaleRecord>[2];

function saleOf(
  till: Till,
  seq: number,
  cart: Cart,
  payment: Tender = { method: 'card' },
  envelope: Partial<RecordEnvelope> = {},
): Promise<SaleRecord> {
  return buildSaleRecord(
    {
      id: newId(),
      seq,
      sessionId: till.sessionId,
      createdAt: CREATED_AT,
      terminal: till.terminal,
      ...envelope,
    },
    cart,
    payment,
  );
}

function refundOf(
  till: Till,
  seq: number,
  sale: Sale,
  selections: readonly RefundSelection[],
  method: PaymentMethod = 'card',
): Promise<SaleRecord> {
  return buildRefundRecord(
    { id: newId(), seq, sessionId: till.sessionId, createdAt: CREATED_AT, terminal: till.terminal },
    sale,
    selections,
    method,
  );
}

/** `record` with `changes`, hashed again as a device would hash what it wrote. */
function rewrite<T extends object>(record: T, changes: Partial<T>): Promise<T> {
  return withPayloadHash({ ...record, ...changes });
}

function memoryStorage(): KeyValueStorage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
    removeItem: (key) => {
      values.delete(key);
    },
  };
}

describe('terminals', () => {
  it("registers codes per shop: the other shop's T1 is a terminal of its own", async () => {
    const { backend, admin, otherAdmin } = await setup();
    const mine = await admin.terminals.register('T1');
    const theirs = await otherAdmin.terminals.register('t1');

    expect(theirs).toMatchObject({ code: 'T1', lastSeq: 0, epoch: 0, openSession: null });
    expect(theirs.terminalId).not.toBe(mine.terminalId);
    await expect(admin.terminals.register('T1')).resolves.toMatchObject({
      terminalId: mine.terminalId,
      epoch: 1,
    });
    expect(backend.inspect.terminals()).toEqual([
      {
        id: mine.terminalId,
        shopId: DEMO_SHOP_ID,
        code: 'T1',
        lastSeq: 0,
        epoch: 1,
        createdAt: isoAt(1),
      },
      {
        id: theirs.terminalId,
        shopId: OTHER_SHOP_ID,
        code: 'T1',
        lastSeq: 0,
        epoch: 0,
        createdAt: isoAt(2),
      },
    ]);
  });
});

describe('sessions', () => {
  it('reads the values of an open record after the replay and the session, as the database does', async () => {
    const { admin, cashier, cashierUser } = await setup();
    const registration = await admin.terminals.register('T1');
    const terminal = contextOf(registration);
    const valid = await openRecord(terminal, cashierUser.id, mm(0));
    const negative = await rewrite(valid, { openingFloatMillimes: mm(-1) });

    const float = await failure(cashier.sessions.open(negative), 'VALIDATION_ERROR');
    expect(float.details).toEqual({ field: 'opening_float_millimes' });
    const openedAt = await failure(
      cashier.sessions.open(await rewrite(valid, { openedAt: 'yesterday' })),
      'VALIDATION_ERROR',
    );
    expect(openedAt.details).toEqual({ field: 'opened_at' });
    const actor = await failure(
      cashier.sessions.open(await rewrite(valid, { actorUserId: 'cashier' })),
      'VALIDATION_ERROR',
    );
    expect(actor.details).toEqual({ field: 'actor_user_id' });
    await failure(
      cashier.sessions.open(await rewrite(valid, { id: 'not-a-uuid' })),
      'VALIDATION_ERROR',
    );
    await expect(cashier.sessions.current(registration.terminalId)).resolves.toBeNull();

    await cashier.sessions.open(valid);
    // With a session open, the same negative float is refused as SESSION_ALREADY_OPEN first.
    const open = await failure(
      cashier.sessions.open(await rewrite(negative, { id: newId() })),
      'SESSION_ALREADY_OPEN',
    );
    expect(open.details).toEqual({ openSessionId: valid.id });
  });

  it('reads the values of a close record after the session checks', async () => {
    const { admin, cashier, cashierUser } = await setup();
    const till = await openTill(admin, cashier, cashierUser);
    const valid = await closeRecord(till, cashierUser.id, mm(50_000));
    const negative = await rewrite(valid, { closingCountedMillimes: mm(-1) });

    const counted = await failure(cashier.sessions.close(negative), 'VALIDATION_ERROR');
    expect(counted.details).toEqual({ field: 'closing_counted_millimes' });
    const closedAt = await failure(
      cashier.sessions.close(await rewrite(valid, { closedAt: 'tonight' })),
      'VALIDATION_ERROR',
    );
    expect(closedAt.details).toEqual({ field: 'closed_at' });
    // A session id that is not a UUID is refused as the record is read, as private.json_uuid does.
    const session = await failure(
      cashier.sessions.close(await rewrite(valid, { sessionId: 'S1' })),
      'VALIDATION_ERROR',
    );
    expect(session.details).toEqual({ field: 'session_id' });
    await expect(cashier.sessions.current(till.terminalId)).resolves.toMatchObject({
      closedAt: null,
    });

    await cashier.sessions.close(valid);
    await failure(
      cashier.sessions.close(await rewrite(negative, { id: newId() })),
      'SESSION_CLOSED',
    );
  });

  it("keeps shops apart: another shop's sessions are not reported, not closed and not reused", async () => {
    const { admin, cashier, cashierUser, otherAdmin, otherCashier, otherCashierUser } =
      await setup();
    const till = await openTill(admin, cashier, cashierUser);
    const theirs = contextOf(await otherAdmin.terminals.register('T1'));

    await expect(otherCashier.sessions.current(till.terminalId)).resolves.toBeNull();
    const report = await failure(otherCashier.sessions.zReport(till.sessionId), 'FORBIDDEN');
    expect(report.details).toEqual({ sessionId: till.sessionId });
    const close = await failure(
      otherCashier.sessions.close(
        await closeRecord({ ...till, terminal: theirs }, otherCashierUser.id, mm(0)),
      ),
      'FORBIDDEN',
    );
    expect(close.details).toEqual({ sessionId: till.sessionId });
    const actor = await failure(
      otherCashier.sessions.open(await openRecord(theirs, cashierUser.id, mm(0))),
      'FORBIDDEN',
    );
    expect(actor.details).toEqual({ actorUserId: cashierUser.id });
    const reused = await failure(
      otherCashier.sessions.open(
        await openRecord(theirs, otherCashierUser.id, mm(0), till.sessionId),
      ),
      'FORBIDDEN',
    );
    expect(reused.details).toBeUndefined();
    const terminal = await failure(
      otherCashier.sessions.open(
        await openRecord({ terminalCode: 'T2', epoch: 0 }, otherCashierUser.id, mm(0)),
      ),
      'FORBIDDEN',
    );
    expect(terminal.details).toEqual({ terminalCode: 'T2' });

    await expect(cashier.sessions.current(till.terminalId)).resolves.toMatchObject({
      id: till.sessionId,
      closedAt: null,
    });
  });
});

describe('sales', () => {
  it('checks in order: terminal, replay, registration, session, number, then the document', async () => {
    const { admin, cashier, cashierUser } = await setup();
    const till = await openTill(admin, cashier, cashierUser);
    const cart = cartOf([WATER, 1]);
    const first = await saleOf(till, 1, cart);
    await cashier.sales.recordSale(first);

    // A stored record sent under a code the shop does not have is refused for the terminal.
    const unregistered = await failure(
      cashier.sales.recordSale(await rewrite(first, { terminalCode: 'T9' })),
      'FORBIDDEN',
    );
    expect(unregistered.details).toEqual({ terminalCode: 'T9' });

    const registration = await admin.terminals.register('T1');
    await failure(
      cashier.sales.recordSale(
        await saleOf(till, 2, cart, { method: 'card' }, { sessionId: newId() }),
      ),
      'TERMINAL_SUPERSEDED',
    );
    const current: Till = { ...till, terminal: contextOf(registration) };
    // A session id that is not a UUID is refused as the record is read, as private.json_uuid does.
    const session = await failure(
      cashier.sales.recordSale(
        await saleOf(current, 2, cart, { method: 'card' }, { sessionId: 'S1' }),
      ),
      'VALIDATION_ERROR',
    );
    expect(session.details).toEqual({ field: 'session_id' });

    const empty = await rewrite(await saleOf(current, 3, cart), {
      lines: [],
      subtotalMillimes: ZERO,
      totalMillimes: ZERO,
      payment: { method: 'card', tenderedMillimes: ZERO, changeMillimes: ZERO },
    });
    await failure(cashier.sales.recordSale(empty), 'SEQUENCE_GAP');
    const lines = await failure(
      cashier.sales.recordSale(await rewrite(empty, { seq: 2 })),
      'VALIDATION_ERROR',
    );
    expect(lines.details).toEqual({ field: 'lines' });

    await expect(cashier.sales.listSales({})).resolves.toHaveLength(1);
  });

  it('refuses sale lines and totals that do not add up, naming the line or the recomputed totals', async () => {
    const { admin, cashier, cashierUser } = await setup();
    const till = await openTill(admin, cashier, cashierUser);
    // 2 × 850 + 2 450 = 4 150, by card.
    const valid = await saleOf(till, 1, cartOf([WATER, 2], [HARISSA, 1]));
    const [water, harissa] = valid.lines;

    const cases: [Partial<SaleRecord>, Record<string, unknown>][] = [
      [{ lines: [harissa, water] }, { field: 'lines' }],
      [{ lines: [water, { ...harissa, refundsLineNo: 1 }] }, { lineNo: 2 }],
      [{ lines: [water, { ...harissa, qty: -1, lineTotalMillimes: mm(-2_450) }] }, { lineNo: 2 }],
      [{ lines: [{ ...water, lineTotalMillimes: mm(1_699) }, harissa] }, { lineNo: 1 }],
      [
        {
          lines: [
            {
              ...water,
              lineDiscountMillimes: mm(1_000),
              cartDiscountShareMillimes: mm(701),
              lineTotalMillimes: mm(-1),
            },
            harissa,
          ],
        },
        { lineNo: 1 },
      ],
      [
        { subtotalMillimes: mm(4_000) },
        { subtotalMillimes: 4_150, discountMillimes: 0, totalMillimes: 4_150 },
      ],
      [{ refundsSaleId: newId() }, { field: 'refunds_sale_id' }],
      [{ createdAt: 'now' }, { field: 'created_at' }],
    ];
    for (const [changes, details] of cases) {
      const error = await failure(
        cashier.sales.recordSale(await rewrite(valid, changes)),
        'VALIDATION_ERROR',
      );
      expect(error.details, JSON.stringify(changes)).toEqual(details);
    }
    // A product id that is not a UUID is refused as the line is read, as private.json_uuid does.
    const product = await failure(
      cashier.sales.recordSale(
        await rewrite(valid, { lines: [{ ...water, productId: 'water' }, harissa] }),
      ),
      'VALIDATION_ERROR',
    );
    expect(product.details).toEqual({ field: 'product_id' });

    await expect(cashier.sales.recordSale(valid)).resolves.toMatchObject({
      receiptNumber: 'T1-1',
      status: 'created',
    });
  });

  it('refuses a sale line above the price cap and records one exactly at it', async () => {
    const { admin, cashier, cashierUser } = await setup();
    const till = await openTill(admin, cashier, cashierUser);
    // A record carries its own unit price, so record_sale bounds it like a product price
    // (20260911000006_sales_ledger.sql:257-262), whatever the catalog says today.
    const atCap = await saleOf(
      till,
      1,
      cartOf([{ ...WATER, priceMillimes: MAX_PRICE_MILLIMES }, 1]),
    );
    const overCap = mm(MAX_PRICE_MILLIMES + 1);
    const above = await rewrite(atCap, {
      id: newId(),
      lines: [{ ...atCap.lines[0], unitPriceMillimes: overCap, lineTotalMillimes: overCap }],
      subtotalMillimes: overCap,
      totalMillimes: overCap,
      payment: { method: 'card', tenderedMillimes: overCap, changeMillimes: ZERO },
    });

    const error = await failure(cashier.sales.recordSale(above), 'VALIDATION_ERROR');
    expect(error.details).toEqual({ lineNo: 1 });
    await expect(cashier.sales.listSales({})).resolves.toEqual([]);

    await expect(cashier.sales.recordSale(atCap)).resolves.toMatchObject({
      receiptNumber: 'T1-1',
      status: 'created',
    });
    await expect(cashier.sales.getSale(atCap.id)).resolves.toMatchObject({
      totalMillimes: MAX_PRICE_MILLIMES,
      lines: [{ unitPriceMillimes: MAX_PRICE_MILLIMES }],
    });
  });

  it('refuses refunds that do not match the sale they name', async () => {
    const { admin, cashier, cashierUser, otherAdmin, otherCashier, otherCashierUser } =
      await setup();
    const till = await openTill(admin, cashier, cashierUser);
    const sold = await saleOf(till, 1, cartOf([WATER, 2], [HARISSA, 1]));
    await cashier.sales.recordSale(sold);
    // One unit of each line: −850 and −2 450.
    const valid = await refundOf(till, 2, await cashier.sales.getSale(sold.id), [
      { lineNo: 1, qty: 1 },
      { lineNo: 2, qty: 1 },
    ]);
    const [water, harissa] = valid.lines;

    // No sale and an id that is not a UUID are refused as the record is read; an unknown sale and
    // another shop's sale name no sale of this shop.
    const theirs = await openTill(otherAdmin, otherCashier, otherCashierUser);
    const theirSale = await saleOf(theirs, 1, cartOf([OTHER_A, 1]));
    await otherCashier.sales.recordSale(theirSale);
    for (const refundsSaleId of [null, 'S1']) {
      const error = await failure(
        cashier.sales.recordSale(await rewrite(valid, { refundsSaleId })),
        'VALIDATION_ERROR',
      );
      expect(error.details, JSON.stringify(refundsSaleId)).toEqual({ field: 'refunds_sale_id' });
    }
    for (const refundsSaleId of [newId(), theirSale.id]) {
      const error = await failure(
        cashier.sales.recordSale(await rewrite(valid, { refundsSaleId })),
        'NOT_FOUND',
      );
      expect(error.details).toEqual({ saleId: refundsSaleId });
    }

    const cases: [Partial<SaleRecord>, Record<string, unknown>][] = [
      [{ lines: [water, { ...harissa, refundsLineNo: null }] }, { field: 'refunds_line_no' }],
      [{ lines: [water, { ...harissa, refundsLineNo: 1 }] }, { lineNo: 2 }],
      [{ lines: [water, { ...harissa, refundsLineNo: 3 }] }, { lineNo: 2 }],
      [{ lines: [water, { ...harissa, productId: WATER.id }] }, { lineNo: 2 }],
      [{ lines: [water, { ...harissa, unitPriceMillimes: mm(2_000) }] }, { lineNo: 2 }],
      [{ lines: [water, { ...harissa, lineDiscountMillimes: mm(1) }] }, { lineNo: 2 }],
      [{ lines: [water, { ...harissa, qty: 1 }] }, { lineNo: 2 }],
      [{ lines: [water, { ...harissa, lineTotalMillimes: mm(1) }] }, { lineNo: 2 }],
      [
        { discountMillimes: mm(1) },
        { subtotalMillimes: -3_300, discountMillimes: 0, totalMillimes: -3_300 },
      ],
    ];
    for (const [changes, details] of cases) {
      const error = await failure(
        cashier.sales.recordSale(await rewrite(valid, changes)),
        'VALIDATION_ERROR',
      );
      expect(error.details, JSON.stringify(changes)).toEqual(details);
    }
    await expect(cashier.sales.recordSale(valid)).resolves.toMatchObject({ status: 'created' });

    // A refund exists, but only a sale can be refunded.
    const ofRefund = await failure(
      cashier.sales.recordSale(
        await rewrite(valid, { id: newId(), seq: 3, refundsSaleId: valid.id }),
      ),
      'VALIDATION_ERROR',
    );
    expect(ofRefund.details).toEqual({ field: 'refunds_sale_id' });
  });

  it('leaves no trace of a refused record: no document, no stock movement, no receipt number', async () => {
    const { backend, admin, cashier, cashierUser } = await setup();
    const till = await openTill(admin, cashier, cashierUser);
    const valid = await saleOf(till, 1, cartOf([WATER, 1], [HARISSA, 2]));
    const before = {
      products: await cashier.catalog.listProducts(),
      movements: backend.inspect.stockMovements(),
      terminals: backend.inspect.terminals(),
    };

    // The second line fails after the first one was checked.
    await failure(
      cashier.sales.recordSale(
        await rewrite(valid, {
          lines: [valid.lines[0], { ...valid.lines[1], lineTotalMillimes: mm(1) }],
        }),
      ),
      'VALIDATION_ERROR',
    );
    // A payment short of the total fails after every line was checked.
    await failure(
      cashier.sales.recordSale(
        await rewrite(valid, {
          payment: { method: 'cash', tenderedMillimes: mm(1), changeMillimes: ZERO },
        }),
      ),
      'VALIDATION_ERROR',
    );

    expect({
      products: await cashier.catalog.listProducts(),
      movements: backend.inspect.stockMovements(),
      terminals: backend.inspect.terminals(),
    }).toEqual(before);
    await expect(cashier.sales.listSales({})).resolves.toEqual([]);
    await expect(cashier.sales.recordSale(valid)).resolves.toMatchObject({
      receiptNumber: 'T1-1',
    });
  });

  it("moves stock once per line, by the member who sent the record, on the backend's clock", async () => {
    const { backend, admin, adminUser, cashier, cashierUser } = await setup();
    const seededMovements = backend.inspect.stockMovements().length;
    const till = await openTill(admin, cashier, cashierUser);
    const sold = await saleOf(
      till,
      1,
      cartOf([YAOURT, 3], [HARISSA, 1]),
      { method: 'cash' },
      { createdAt: '2026-09-11T11:00:00+01:00' },
    );
    await cashier.sales.recordSale(sold);
    const refund = await refundOf(till, 2, await cashier.sales.getSale(sold.id), [
      { lineNo: 1, qty: 2 },
    ]);
    // The admin syncs the refund the cashier made.
    await admin.sales.recordSale(refund);

    const movement = { shopId: DEMO_SHOP_ID, note: '' };
    expect(backend.inspect.stockMovements().slice(seededMovements)).toEqual([
      {
        ...movement,
        id: seededMovements + 1,
        productId: YAOURT.id,
        delta: -3,
        reason: 'sale',
        saleId: sold.id,
        createdBy: cashierUser.id,
        createdAt: isoAt(3),
      },
      {
        ...movement,
        id: seededMovements + 2,
        productId: HARISSA.id,
        delta: -1,
        reason: 'sale',
        saleId: sold.id,
        createdBy: cashierUser.id,
        createdAt: isoAt(3),
      },
      {
        ...movement,
        id: seededMovements + 3,
        productId: YAOURT.id,
        delta: 2,
        reason: 'refund',
        saleId: refund.id,
        createdBy: adminUser.id,
        createdAt: isoAt(4),
      },
    ]);
    await expect(cashier.sales.getSale(sold.id)).resolves.toMatchObject({
      createdAt: CREATED_AT,
      receivedAt: isoAt(3),
    });
    const stock = (await cashier.catalog.listProducts())
      .filter((product) => product.id === YAOURT.id || product.id === HARISSA.id)
      .map((product) => product.stock);
    expect(stock).toEqual([7, 39]);
  });

  it("keeps shops apart: another shop's record ids, sessions, products and sales", async () => {
    const { admin, cashier, cashierUser, otherAdmin, otherCashier, otherCashierUser } =
      await setup();
    const till = await openTill(admin, cashier, cashierUser);
    const theirs = await openTill(otherAdmin, otherCashier, otherCashierUser);
    const sold = await saleOf(till, 1, cartOf([WATER, 1]));
    await cashier.sales.recordSale(sold);
    const theirCart = cartOf([OTHER_A, 1]);

    const sameId = await saleOf(theirs, 1, theirCart, { method: 'card' }, { id: sold.id });
    await failure(otherCashier.sales.recordSale(sameId), 'FORBIDDEN');
    await failure(
      otherAdmin.sales.voidReceipt({ record: sameId, errorCode: 'FORBIDDEN', reason: 'Test' }),
      'FORBIDDEN',
    );
    const session = await failure(
      otherCashier.sales.recordSale(
        await saleOf(theirs, 1, theirCart, { method: 'card' }, { sessionId: till.sessionId }),
      ),
      'FORBIDDEN',
    );
    expect(session.details).toEqual({ sessionId: till.sessionId });
    const product = await failure(
      otherCashier.sales.recordSale(await saleOf(theirs, 1, cartOf([WATER, 1]))),
      'NOT_FOUND',
    );
    expect(product.details).toEqual({ productId: WATER.id });

    await expect(otherCashier.sales.listSales({})).resolves.toEqual([]);
    await expect(otherCashier.sales.listSales({ terminalId: till.terminalId })).resolves.toEqual(
      [],
    );
    const sale = await failure(otherCashier.sales.getSale(sold.id), 'NOT_FOUND');
    expect(sale.details).toEqual({ saleId: sold.id });

    await expect(
      otherCashier.sales.recordSale(await saleOf(theirs, 1, theirCart)),
    ).resolves.toMatchObject({ receiptNumber: 'T1-1', status: 'created' });
    await expect(cashier.sales.listSales({})).resolves.toHaveLength(1);
  });

  it('voids only with a reason and needs no current registration; the void names only a session of its terminal', async () => {
    const { backend, admin, adminUser, cashier, cashierUser } = await setup();
    const till = await openTill(admin, cashier, cashierUser);
    const other = await openTill(admin, cashier, cashierUser, 'T2');
    const stuck = await saleOf(
      till,
      1,
      cartOf([WATER, 1]),
      { method: 'card' },
      { sessionId: other.sessionId },
    );
    await failure(cashier.sales.recordSale(stuck), 'FORBIDDEN');

    const input = { record: stuck, errorCode: 'FORBIDDEN', reason: '   ' };
    const reason = await failure(admin.sales.voidReceipt(input), 'VALIDATION_ERROR');
    expect(reason.details).toEqual({ field: 'reason' });
    await failure(
      admin.sales.voidReceipt({
        ...input,
        reason: 'Wrong session',
        record: await rewrite(stuck, { terminalCode: 'T9' }),
      }),
      'FORBIDDEN',
    );

    // Registered again before the void: voids do not check the registration.
    await admin.terminals.register('T1');
    await expect(
      admin.sales.voidReceipt({ ...input, reason: '  Wrong session ' }),
    ).resolves.toEqual({ saleId: stuck.id, receiptNumber: 'T1-1', status: 'voided' });
    expect(backend.inspect.receiptVoids()).toEqual([
      {
        id: stuck.id,
        shopId: DEMO_SHOP_ID,
        terminalId: till.terminalId,
        sessionId: null,
        seq: 1,
        receiptNumber: 'T1-1',
        payload: stuck,
        payloadHash: stuck.payloadHash,
        errorCode: 'FORBIDDEN',
        reason: 'Wrong session',
        voidedBy: adminUser.id,
        voidedAt: isoAt(5),
      },
    ]);

    // A session id that is not a UUID is voided without a session; this terminal's session is named.
    for (const [seq, sessionId] of [
      [2, 'S1'],
      [3, till.sessionId],
    ] as const) {
      const record = await saleOf(till, seq, cartOf([WATER, 1]), { method: 'card' }, { sessionId });
      await expect(
        admin.sales.voidReceipt({ record, errorCode: 'VALIDATION_ERROR', reason: 'Test' }),
      ).resolves.toMatchObject({ receiptNumber: `T1-${seq}`, status: 'voided' });
    }
    expect(backend.inspect.receiptVoids().map((receiptVoid) => receiptVoid.sessionId)).toEqual([
      null,
      null,
      till.sessionId,
    ]);
    await expect(cashier.sessions.zReport(other.sessionId)).resolves.toMatchObject({
      voidsCount: 0,
    });
    await expect(cashier.sessions.zReport(till.sessionId)).resolves.toMatchObject({
      voidsCount: 1,
    });
  });

  it('keeps record ids in the lowercase form the database returns', async () => {
    const { admin, cashier, cashierUser } = await setup();
    const till = await openTill(admin, cashier, cashierUser);
    const record = await saleOf(
      till,
      1,
      cartOf([WATER, 1]),
      { method: 'card' },
      { id: newId().toUpperCase(), sessionId: till.sessionId.toUpperCase() },
    );

    const stored = { saleId: record.id.toLowerCase(), receiptNumber: 'T1-1' };
    await expect(cashier.sales.recordSale(record)).resolves.toEqual({
      ...stored,
      status: 'created',
    });
    await expect(cashier.sales.recordSale(record)).resolves.toEqual({
      ...stored,
      status: 'replayed',
    });
    await expect(cashier.sales.getSale(record.id)).resolves.toMatchObject({
      id: stored.saleId,
      sessionId: till.sessionId,
    });
  });

  it('reads only well-formed ids and queries', async () => {
    const { cashier } = await setup();
    const sale = await failure(cashier.sales.getSale('T1-1'), 'VALIDATION_ERROR');
    expect(sale.details).toEqual({ field: 'id' });
    const terminal = await failure(
      cashier.sales.listSales({ terminalId: 'T1' }),
      'VALIDATION_ERROR',
    );
    expect(terminal.details).toEqual({ field: 'terminal_id' });
    await failure(cashier.sales.listSales({ limit: 0 }), 'VALIDATION_ERROR');
    const current = await failure(cashier.sessions.current('T1'), 'VALIDATION_ERROR');
    expect(current.details).toEqual({ field: 'terminal_id' });
    const report = await failure(cashier.sessions.zReport('S1'), 'VALIDATION_ERROR');
    expect(report.details).toEqual({ field: 'session_id' });
    await expect(cashier.sessions.current(newId())).resolves.toBeNull();
  });
});

describe('the credential-free demo', () => {
  it('lets the admin register T1, then the cashier open a session, sell, refund and close it', async () => {
    // Built as src/lib/backend.ts builds it, and signed in with the login page's demo buttons.
    const backend = createMemoryBackend();
    const [adminButton, cashierButton] = backend.demoAccounts;
    expect([adminButton.label, cashierButton.label]).toEqual(['Admin', 'Cashier']);
    const device = createTerminalStore(memoryStorage());

    // Settings, as the admin: register this device as T1.
    const admin = await backend.auth.signIn({
      email: adminButton.email,
      password: adminButton.password,
    });
    expect(admin).toMatchObject({ role: 'admin', shopId: DEMO_SHOP_ID });
    device.assertCanRegister();
    const registration = await backend.terminals.register('T1');
    expect(registration).toMatchObject({ code: 'T1', lastSeq: 0, epoch: 0, openSession: null });
    device.register({
      terminalId: registration.terminalId,
      code: registration.code,
      epoch: registration.epoch,
      lastSeq: registration.lastSeq,
      registeredAt: new Date().toISOString(),
    });
    await backend.auth.signOut();

    // The POS, as the cashier: no session yet, so open one with a float of 50 DT.
    const cashier = await backend.auth.signIn({
      email: cashierButton.email,
      password: cashierButton.password,
    });
    const stored = device.read();
    if (!stored) {
      return expect.unreachable('The device lost its registration');
    }
    const terminal = { terminalCode: stored.code, epoch: stored.epoch };
    await expect(backend.sessions.current(stored.terminalId)).resolves.toBeNull();
    const open = await buildOpenSessionRecord({
      id: newId(),
      terminal,
      actorUserId: cashier.id,
      openedAt: new Date().toISOString(),
      openingFloatMillimes: mm(50_000),
    });
    await expect(backend.sessions.open(open)).resolves.toMatchObject({
      status: 'created',
      session: { terminalCode: 'T1', openedBy: cashier.id, openingFloatMillimes: 50_000 },
    });

    /** Records the next receipt as the register does: pending first, committed once accepted. */
    async function recordNext(
      build: (envelope: RecordEnvelope) => Promise<SaleRecord>,
    ): Promise<SaleRecord> {
      const lastSeq = device.read()?.lastSeq ?? 0;
      const record = await build({
        id: newId(),
        seq: lastSeq + 1,
        sessionId: open.id,
        createdAt: new Date().toISOString(),
        terminal,
      });
      device.writePending({ type: 'sale', record });
      await expect(backend.sales.recordSale(record)).resolves.toEqual({
        saleId: record.id,
        receiptNumber: `T1-${record.seq}`,
        status: 'created',
      });
      device.commitSeq(record.seq);
      device.clearPending();
      return record;
    }

    // Cash: three yoghurts less 0,200 DT and a harissa, 5 % off the cart (0,398 DT, shared 275 and 123).
    const cart = setCartDiscount(
      setLineDiscount(cartOf([YAOURT, 3], [HARISSA, 1]), YAOURT.id, mm(200)),
      500,
    );
    const first = await recordNext((envelope) =>
      buildSaleRecord(envelope, cart, { method: 'cash', tenderedMillimes: mm(10_000) }),
    );
    expect(first).toMatchObject({ totalMillimes: 7_552, payment: { changeMillimes: 2_448 } });
    // Card: two bottles of water.
    await recordNext((envelope) =>
      buildSaleRecord(envelope, cartOf([WATER, 2]), { method: 'card' }),
    );
    // Refunds from the sale's detail: one yoghurt in cash, then the last two by card.
    const cashRefund = await recordNext(async (envelope) =>
      buildRefundRecord(
        envelope,
        await backend.sales.getSale(first.id),
        [{ lineNo: 1, qty: 1 }],
        'cash',
      ),
    );
    const cardRefund = await recordNext(async (envelope) =>
      buildRefundRecord(
        envelope,
        await backend.sales.getSale(first.id),
        [{ lineNo: 1, qty: 2 }],
        'card',
      ),
    );
    expect([cashRefund.totalMillimes, cardRefund.totalMillimes]).toEqual([-1_741, -3_484]);

    const sale = await backend.sales.getSale(first.id);
    expect(sale.lines.map((line) => [line.refundedQty, line.refundedMillimes])).toEqual([
      [3, 5_225],
      [0, 0],
    ]);
    const documents = await backend.sales.listSales({ terminalId: stored.terminalId });
    expect(documents.map((document) => document.receiptNumber)).toEqual([
      'T1-4',
      'T1-3',
      'T1-2',
      'T1-1',
    ]);

    // Close with the cash counted; the register's own report agrees with the backend's.
    const local = computeZReport({
      sessionId: open.id,
      openingFloatMillimes: open.openingFloatMillimes,
      documents,
      voidsCount: 0,
      countedCashMillimes: mm(55_800),
    });
    const closed = await backend.sessions.close(
      await buildCloseSessionRecord({
        id: newId(),
        sessionId: open.id,
        terminal,
        actorUserId: cashier.id,
        closedAt: new Date().toISOString(),
        closingCountedMillimes: mm(55_800),
        clientZReport: local,
      }),
    );
    expect(closed).toEqual({
      sessionId: open.id,
      status: 'created',
      zReport: {
        sessionId: open.id,
        openingFloatMillimes: 50_000,
        salesCount: 2,
        refundsCount: 2,
        grossMillimes: 9_252,
        refundsMillimes: 5_225,
        netMillimes: 4_027,
        byMethod: {
          cash: { salesMillimes: 7_552, refundsMillimes: 1_741, netMillimes: 5_811 },
          card: { salesMillimes: 1_700, refundsMillimes: 3_484, netMillimes: -1_784 },
        },
        expectedCashMillimes: 55_811,
        countedCashMillimes: 55_800,
        varianceMillimes: -11,
        voidsCount: 0,
      },
    });
    expect(sameZReport(closed.zReport, local)).toBe(true);
    await expect(backend.sessions.current(stored.terminalId)).resolves.toBeNull();

    const stock = (await backend.catalog.listProducts())
      .filter((product) => [WATER.id, YAOURT.id, HARISSA.id].includes(product.id))
      .map((product) => [product.name, product.stock]);
    expect(stock).toEqual([
      [WATER.name, 118],
      [YAOURT.name, 8],
      [HARISSA.name, 39],
    ]);
    expect(device.read()).toMatchObject({ lastSeq: 4 });
    expect(device.readPending()).toBeNull();
  });
});
