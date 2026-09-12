import { expect } from 'vitest';
import {
  addItem,
  cartOf as cartOfLines,
  emptyCart,
  setCartDiscount,
  type Cart,
} from '@/features/caisse/cart';
import {
  buildRefundRecord,
  buildSaleRecord,
  type RecordEnvelope,
  type RefundSelection,
} from '@/features/sales/records';
import { buildCloseSessionRecord, buildOpenSessionRecord } from '@/features/sessions/records';
import type { TerminalContext } from '@/features/terminal/types';
import { isAppError, type AppError, type ErrorCode } from '@/lib/errors';
import { add, mm, ZERO, type Millimes } from '@/lib/money';
import { withPayloadHash } from '@/lib/payloadHash';
import type {
  CloseSessionRecord,
  DiningTable,
  OpenOrderItem,
  OpenSessionRecord,
  PaymentMethod,
  Product,
  ProductUpdateInput,
  Sale,
  SaleLine,
  SaleRecord,
  StockAdjustment,
  ZReport,
} from '@/ports';
import type { ContractFixture } from './fixture';

export function newId(): string {
  return crypto.randomUUID();
}

export function timestamp(): string {
  return new Date().toISOString();
}

/** Fails the test unless `promise` rejects with an AppError of `code`, and returns that error. */
export async function failure(promise: Promise<unknown>, code: ErrorCode): Promise<AppError> {
  const outcome = await promise.then(
    (value: unknown) => ({ settled: 'resolved' as const, value }),
    (error: unknown) => ({ settled: 'rejected' as const, error }),
  );
  if (outcome.settled === 'resolved') {
    return expect.unreachable(
      `Expected ${code}, but the call succeeded with ${JSON.stringify(outcome.value)}`,
    );
  }
  if (!isAppError(outcome.error)) {
    return expect.unreachable(`Expected an AppError ${code}, got ${String(outcome.error)}`);
  }
  expect(outcome.error.code, outcome.error.message).toBe(code);
  return outcome.error;
}

// Catalog

/** Creates a product as the admin, under a name no other run uses. */
export function createProduct(
  fixture: ContractFixture,
  label: string,
  priceMillimes: number,
  openingStock = 50,
): Promise<Product> {
  return fixture.admin.catalog.createProduct({
    name: `Contract ${label} ${newId().slice(0, 8)}`,
    priceMillimes: mm(priceMillimes),
    categoryId: null,
    barcode: '',
    description: '',
    imageUrl: '',
    isAvailable: true,
    // Tracked, so the stock assertions of these suites mean something; most café items are not.
    trackStock: true,
    openingStock,
  });
}

/** The update the product form sends for `product` unchanged, with `stockDelta`. */
export function editOf(product: Product, stockDelta: number): ProductUpdateInput {
  return {
    name: product.name,
    priceMillimes: product.priceMillimes,
    categoryId: product.categoryId,
    barcode: product.barcode,
    description: product.description,
    imageUrl: product.imageUrl,
    isAvailable: product.isAvailable,
    trackStock: product.trackStock,
    stockDelta,
  };
}

/** A listed product, as anyone in the shop sees it. */
export async function listed(fixture: ContractFixture, productId: string): Promise<Product> {
  const products = await fixture.cashier.catalog.listProducts();
  const product = products.find((candidate) => candidate.id === productId);
  if (!product) {
    return expect.unreachable(`Product ${productId} is not listed`);
  }
  return product;
}

/** The stock of a listed product. */
export async function stockOf(fixture: ContractFixture, productId: string): Promise<number> {
  return (await listed(fixture, productId)).stockQty;
}

/** A hand count as the admin writes it: a record like any other, so a retry cannot count twice. */
export function stockAdjustment(
  productId: string,
  qtyDelta: number,
  reason = 'Counted on the shelf',
): Promise<StockAdjustment> {
  return withPayloadHash({ id: newId(), productId, qtyDelta, reason });
}

// Terminals and sessions

export interface RegisteredTerminal {
  readonly terminalId: string;
  /** The code and epoch its records carry. */
  readonly terminal: TerminalContext;
}

/** A registered terminal with an open session: what the register holds while it sells. */
export interface Till extends RegisteredTerminal {
  readonly sessionId: string;
  readonly openingFloatMillimes: Millimes;
}

export function contextOf(registration: {
  readonly code: string;
  readonly epoch: number;
}): TerminalContext {
  return { terminalCode: registration.code, epoch: registration.epoch };
}

/** Registers `code` (default: a new code) as the admin. */
export async function registerTerminal(
  fixture: ContractFixture,
  code = fixture.newTerminalCode(),
): Promise<RegisteredTerminal> {
  const registration = await fixture.admin.terminals.register(code);
  return { terminalId: registration.terminalId, terminal: contextOf(registration) };
}

export function openRecord(
  terminal: TerminalContext,
  actorUserId: string,
  openingFloatMillimes: Millimes,
  id = newId(),
): Promise<OpenSessionRecord> {
  return buildOpenSessionRecord({
    id,
    terminal,
    actorUserId,
    openedAt: timestamp(),
    openingFloatMillimes,
  });
}

export function closeRecord(
  terminal: TerminalContext,
  sessionId: string,
  actorUserId: string,
  closingCountedMillimes: Millimes,
  options: { readonly id?: string; readonly clientZReport?: ZReport } = {},
): Promise<CloseSessionRecord> {
  return buildCloseSessionRecord({
    id: options.id ?? newId(),
    sessionId,
    terminal,
    actorUserId,
    closedAt: timestamp(),
    closingCountedMillimes,
    clientZReport: options.clientZReport ?? null,
  });
}

/** Registers a new terminal and opens a session on it as the cashier. */
export async function openTill(
  fixture: ContractFixture,
  openingFloatMillimes: Millimes = mm(20_000),
): Promise<Till> {
  const registered = await registerTerminal(fixture);
  const record = await openRecord(
    registered.terminal,
    fixture.cashierUser.id,
    openingFloatMillimes,
  );
  const opened = await fixture.cashier.sessions.open(record);
  expect(opened.status).toBe('created');
  return { ...registered, sessionId: opened.sessionId, openingFloatMillimes };
}

// Sales and refunds

export function receipt(till: RegisteredTerminal, seq: number): string {
  return `${till.terminal.terminalCode}-${seq}`;
}

/** A cart of `qty` units of each product, with a cart discount in basis points. */
export function cartOf(
  items: readonly (readonly [Product, number])[],
  discountBasisPoints = 0,
): Cart {
  const cart = items.reduce<Cart>(
    (current, [product, qty]) => addItem(current, product, qty),
    emptyCart,
  );
  return setCartDiscount(cart, discountBasisPoints);
}

export interface RecordOptions {
  /** Default: a new id. */
  readonly id?: string;
  /** Default: the till's registration. */
  readonly terminal?: TerminalContext;
  /** Default: the till's session. */
  readonly sessionId?: string;
  /** Default: none — a counter sale, which sat on no table. */
  readonly tableId?: string;
}

function envelopeFor(till: Till, seq: number, options: RecordOptions): RecordEnvelope {
  return {
    id: options.id ?? newId(),
    seq,
    sessionId: options.sessionId ?? till.sessionId,
    createdAt: timestamp(),
    terminal: options.terminal ?? till.terminal,
    tableId: options.tableId ?? null,
  };
}

export type Tender = Parameters<typeof buildSaleRecord>[2];

/** Sale number `seq` of `till`, built as the register builds it. */
export function saleRecord(
  till: Till,
  seq: number,
  cart: Cart,
  payment: Tender = { method: 'cash' },
  options: RecordOptions = {},
): Promise<SaleRecord> {
  return buildSaleRecord(envelopeFor(till, seq, options), cart, payment);
}

/** Refund number `seq` of `till` for units of `sale`, built as the register builds it. */
export function refundRecord(
  till: Till,
  seq: number,
  sale: Sale,
  selections: readonly RefundSelection[],
  method: PaymentMethod = 'cash',
  options: RecordOptions = {},
): Promise<SaleRecord> {
  return buildRefundRecord(envelopeFor(till, seq, options), sale, selections, method);
}

/** `record` with `changes`, hashed again as a device would hash what it wrote. */
export function rewrite(record: SaleRecord, changes: Partial<SaleRecord>): Promise<SaleRecord> {
  return withPayloadHash({ ...record, ...changes });
}

/** A new refund record like `refund`, numbered `seq`, with `lines` and totals and payment to match. */
export function refundWith(
  refund: SaleRecord,
  seq: number,
  lines: readonly SaleLine[],
): Promise<SaleRecord> {
  const total = add(...lines.map((line) => line.netMillimes));
  return rewrite(refund, {
    id: newId(),
    seq,
    lines: [...lines],
    cartDiscountMillimes: ZERO,
    totalMillimes: total,
    payment: { method: refund.payment.method, tenderedMillimes: total, changeMillimes: ZERO },
  });
}

/** Records `record` as the cashier and expects it to be created under its receipt number. */
export async function recordCreated(fixture: ContractFixture, record: SaleRecord): Promise<void> {
  await expect(fixture.cashier.sales.recordSale(record)).resolves.toEqual({
    saleId: record.id,
    receiptNumber: `${record.terminalCode}-${record.seq}`,
    status: 'created',
  });
}

/** [refundedQty, refundedMillimes] of every line of `sale`. */
export function refunded(sale: Sale): number[][] {
  return sale.lines.map((line) => [line.refundedQty, line.refundedMillimes]);
}

// Tables and open orders

/** A device id for a phone or a till in a test; two of them are two devices on one table. */
export function deviceId(label = 'a'): string {
  return `device-contract-${label}`;
}

/**
 * An order record as a device writes it: the fields of its kind inside the envelope every kind
 * carries. The hash is over the whole record, so a replay is recognised by id and hash alike.
 */
export function orderRecord<Fields extends object>(
  fields: Fields,
  options: { readonly id?: string; readonly deviceId?: string; readonly createdAt?: string } = {},
): Promise<Fields & { id: string; deviceId: string; createdAt: string; payloadHash: string }> {
  return withPayloadHash({
    id: options.id ?? newId(),
    deviceId: options.deviceId ?? deviceId(),
    createdAt: options.createdAt ?? timestamp(),
    ...fields,
  });
}

/** Adds `qty` of `product` to `table` as the waiter, and answers the item that landed there. */
export async function addToTable(
  fixture: ContractFixture,
  table: DiningTable,
  product: Product,
  qty = 1,
  note = '',
): Promise<OpenOrderItem> {
  const added = await fixture.waiter.orders.addItem(
    await orderRecord({ tableId: table.id, productId: product.id, qty, note }),
  );
  expect(added.status).toBe('created');
  const order = await fixture.waiter.orders.openOrder(table.id);
  const item = order?.items.find((candidate) => candidate.id === added.itemId);
  if (!item) {
    return expect.unreachable(`The item ${added.itemId} is not on table ${table.name}`);
  }
  return item;
}

/**
 * Payment number `seq` for `items` of one table: each line pays one item, at the quantity and the
 * price snapshotted when it was added, with no discount. Cash, tendered to the millime.
 *
 * It goes through the register's own builder, so what the suites record is what a caisse records:
 * the table on the record and the order item on every line are what turn a payment into "these rows
 * of that table are paid" rather than "some products were sold".
 */
export function tablePaymentRecord(
  till: Till,
  seq: number,
  table: DiningTable,
  items: readonly OpenOrderItem[],
  options: RecordOptions & { readonly method?: PaymentMethod } = {},
): Promise<SaleRecord> {
  const cart = cartOfLines(
    items.map((item) => ({
      productId: item.productId,
      name: item.nameSnapshot,
      unitPriceMillimes: item.unitPriceMillimes,
      qty: item.qty,
      lineDiscountMillimes: ZERO,
      orderItemId: item.id,
    })),
  );
  return buildSaleRecord({ ...envelopeFor(till, seq, options), tableId: table.id }, cart, {
    method: options.method ?? 'cash',
  });
}
