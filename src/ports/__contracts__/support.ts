import { expect } from 'vitest';
import { addItem, emptyCart, setCartDiscount, type Cart } from '@/features/pos/cart';
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
  OpenSessionRecord,
  PaymentMethod,
  Product,
  ProductUpdateInput,
  Sale,
  SaleLine,
  SaleRecord,
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
    stockDelta,
  };
}

/** The stock of a listed product. */
export async function stockOf(fixture: ContractFixture, productId: string): Promise<number> {
  const products = await fixture.cashier.catalog.listProducts();
  const product = products.find((candidate) => candidate.id === productId);
  if (!product) {
    return expect.unreachable(`Product ${productId} is not listed`);
  }
  return product.stock;
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
}

function envelopeFor(till: Till, seq: number, options: RecordOptions): RecordEnvelope {
  return {
    id: options.id ?? newId(),
    seq,
    sessionId: options.sessionId ?? till.sessionId,
    createdAt: timestamp(),
    terminal: options.terminal ?? till.terminal,
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
  const total = add(...lines.map((line) => line.lineTotalMillimes));
  return rewrite(refund, {
    id: newId(),
    seq,
    lines: [...lines],
    subtotalMillimes: total,
    discountMillimes: ZERO,
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
