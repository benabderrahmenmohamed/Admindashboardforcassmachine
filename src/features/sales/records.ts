import { changeDue, totals, type Cart } from '@/features/pos/cart';
import type { TerminalContext } from '@/features/terminal/types';
import { AppError } from '@/lib/errors';
import { add, mm, neg, ZERO, type Millimes } from '@/lib/money';
import { withPayloadHash } from '@/lib/payloadHash';
import { parseOrInvalid } from '@/lib/validation';
import {
  saleRecordSchema,
  type PaymentMethod,
  type Sale,
  type SaleLine,
  type SaleRecord,
} from '@/ports';

/** Fields every numbered record needs from the device. */
export interface RecordEnvelope {
  readonly id: string;
  readonly seq: number;
  readonly sessionId: string;
  readonly createdAt: string;
  readonly terminal: TerminalContext;
}

export function receiptNumber(terminalCode: string, seq: number): string {
  return `${terminalCode}-${seq}`;
}

function invalid(message: string, details?: Record<string, unknown>): AppError {
  return new AppError('VALIDATION_ERROR', message, { details });
}

/**
 * A sale record from the cart. Cash uses `tenderedMillimes` (the total when omitted) and computes
 * change; card is always exactly the total.
 */
export async function buildSaleRecord(
  envelope: RecordEnvelope,
  cart: Cart,
  payment: { readonly method: PaymentMethod; readonly tenderedMillimes?: Millimes },
): Promise<SaleRecord> {
  if (cart.lines.length === 0) {
    throw invalid('The cart is empty');
  }
  const cartTotals = totals(cart);
  const lines: SaleLine[] = cart.lines.map((line, index) => ({
    lineNo: index + 1,
    productId: line.productId,
    productName: line.name,
    qty: line.qty,
    unitPriceMillimes: line.unitPriceMillimes,
    lineDiscountMillimes: cartTotals.lines[index].lineDiscountMillimes,
    cartDiscountShareMillimes: cartTotals.lines[index].cartDiscountShareMillimes,
    lineTotalMillimes: cartTotals.lines[index].totalMillimes,
    refundsLineNo: null,
  }));
  const total = cartTotals.totalMillimes;
  const tendered = payment.method === 'cash' ? (payment.tenderedMillimes ?? total) : total;
  const record = await withPayloadHash({
    id: envelope.id,
    kind: 'sale' as const,
    terminalCode: envelope.terminal.terminalCode,
    epoch: envelope.terminal.epoch,
    seq: envelope.seq,
    sessionId: envelope.sessionId,
    createdAt: envelope.createdAt,
    lines,
    subtotalMillimes: cartTotals.subtotalMillimes,
    discountMillimes: cartTotals.discountMillimes,
    totalMillimes: total,
    payment: {
      method: payment.method,
      tenderedMillimes: tendered,
      changeMillimes: payment.method === 'cash' ? changeDue(total, tendered) : ZERO,
    },
    refundsSaleId: null,
  });
  return parseOrInvalid(saleRecordSchema, record, 'the sale');
}

/**
 * The amount for refunding `refunding` of a line's `units`, after `alreadyRefunded` were refunded:
 * C(already + refunding) − C(already) with C(x) = floor(net × x / units). However a line is refunded
 * in parts, the parts add up to exactly its net amount.
 */
export function refundShare(
  netMillimes: Millimes,
  units: number,
  alreadyRefunded: number,
  refunding: number,
): Millimes {
  if (
    !Number.isSafeInteger(units) ||
    !Number.isSafeInteger(alreadyRefunded) ||
    !Number.isSafeInteger(refunding) ||
    units < 1 ||
    alreadyRefunded < 0 ||
    refunding < 1 ||
    alreadyRefunded + refunding > units ||
    netMillimes < 0
  ) {
    throw invalid('A refund must take between one unit and what is left of the line', {
      units,
      alreadyRefunded,
      refunding,
    });
  }
  const cumulative = (count: number) => (BigInt(netMillimes) * BigInt(count)) / BigInt(units);
  return mm(Number(cumulative(alreadyRefunded + refunding) - cumulative(alreadyRefunded)));
}

export interface RefundSelection {
  /** The line number on the original sale. */
  readonly lineNo: number;
  readonly qty: number;
}

/** A refund record for chosen units of `sale`. Refunds pay out exactly their total. */
export async function buildRefundRecord(
  envelope: RecordEnvelope,
  sale: Sale,
  selections: readonly RefundSelection[],
  method: PaymentMethod,
): Promise<SaleRecord> {
  if (sale.kind !== 'sale') {
    throw invalid('Only a sale can be refunded');
  }
  const chosen = selections.filter((selection) => selection.qty > 0);
  if (chosen.length === 0) {
    throw invalid('Choose at least one unit to refund');
  }
  const seen = new Set<number>();
  const lines: SaleLine[] = chosen.map((selection, index) => {
    if (seen.has(selection.lineNo)) {
      throw invalid('Each line can be refunded once per refund', { lineNo: selection.lineNo });
    }
    seen.add(selection.lineNo);
    const original = sale.lines.find((line) => line.lineNo === selection.lineNo);
    if (!original) {
      throw invalid('That line is not on the sale', { lineNo: selection.lineNo });
    }
    const amount = refundShare(
      original.lineTotalMillimes,
      original.qty,
      original.refundedQty,
      selection.qty,
    );
    return {
      lineNo: index + 1,
      productId: original.productId,
      productName: original.productName,
      qty: -selection.qty,
      unitPriceMillimes: original.unitPriceMillimes,
      lineDiscountMillimes: ZERO,
      cartDiscountShareMillimes: ZERO,
      lineTotalMillimes: neg(amount),
      refundsLineNo: original.lineNo,
    };
  });
  const total = add(...lines.map((line) => line.lineTotalMillimes));
  const record = await withPayloadHash({
    id: envelope.id,
    kind: 'refund' as const,
    terminalCode: envelope.terminal.terminalCode,
    epoch: envelope.terminal.epoch,
    seq: envelope.seq,
    sessionId: envelope.sessionId,
    createdAt: envelope.createdAt,
    lines,
    subtotalMillimes: total,
    discountMillimes: ZERO,
    totalMillimes: total,
    payment: { method, tenderedMillimes: total, changeMillimes: ZERO },
    refundsSaleId: sale.id,
  });
  return parseOrInvalid(saleRecordSchema, record, 'the refund');
}
