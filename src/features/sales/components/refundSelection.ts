/**
 * Choosing what to refund from a sale, kept out of the components so it runs without a DOM. The
 * amounts shown are the ones buildRefundRecord records, so the cashier sees the exact refund.
 */
import { refundShare, type RefundSelection } from '@/features/sales/records';
import { add, sub, type Millimes } from '@/lib/money';
import type { Sale, SaleLineView } from '@/ports';

/** Units to refund, by line number on the original sale. Lines not in the map refund nothing. */
export type RefundQuantities = ReadonlyMap<number, number>;

export interface RefundableLine {
  readonly line: SaleLineView;
  /** Units of the line not refunded yet. */
  readonly remainingQty: number;
  /** What is left of the line's amount after earlier refunds. */
  readonly remainingMillimes: Millimes;
}

/** A sale's lines with what is left to refund on each. A refund document has nothing to refund. */
export function refundableLines(sale: Sale): RefundableLine[] {
  if (sale.kind !== 'sale') {
    return [];
  }
  return sale.lines.map((line) => ({
    line,
    remainingQty: Math.max(0, line.qty - line.refundedQty),
    remainingMillimes: sub(line.netMillimes, line.refundedMillimes),
  }));
}

/** True while at least one unit of the sale is left to refund. */
export function canRefund(sale: Sale): boolean {
  return refundableLines(sale).some((entry) => entry.remainingQty > 0);
}

/**
 * Sets the units to refund on line `lineNo`, kept between zero and what is left of the line. A
 * quantity that is not a whole number counts as zero; an unknown line changes nothing.
 */
export function setRefundQty(
  sale: Sale,
  quantities: RefundQuantities,
  lineNo: number,
  qty: number,
): RefundQuantities {
  const entry = refundableLines(sale).find((candidate) => candidate.line.lineNo === lineNo);
  if (!entry) {
    return quantities;
  }
  const whole = Number.isSafeInteger(qty) ? qty : 0;
  const next = new Map(quantities);
  next.set(lineNo, Math.min(Math.max(whole, 0), entry.remainingQty));
  return next;
}

/** Everything that is left of the sale. */
export function allRemaining(sale: Sale): RefundQuantities {
  return new Map(
    refundableLines(sale)
      .filter((entry) => entry.remainingQty > 0)
      .map((entry) => [entry.line.lineNo, entry.remainingQty] as const),
  );
}

export interface RefundPreviewLine {
  readonly lineNo: number;
  readonly productName: string;
  readonly qty: number;
  /** What this line pays back, as a positive amount. */
  readonly amountMillimes: Millimes;
}

export interface RefundPreview {
  /** What to pass to buildRefundRecord, in sale line order, without zero quantities. */
  readonly selections: RefundSelection[];
  readonly lines: RefundPreviewLine[];
  /** The refund's total as a positive amount (the record holds it negated). */
  readonly totalMillimes: Millimes;
}

/** The refund that `quantities` describe, with the amounts it will record. */
export function refundPreview(sale: Sale, quantities: RefundQuantities): RefundPreview {
  const lines = refundableLines(sale).flatMap(({ line, remainingQty }): RefundPreviewLine[] => {
    const qty = Math.min(quantities.get(line.lineNo) ?? 0, remainingQty);
    if (qty < 1) {
      return [];
    }
    return [
      {
        lineNo: line.lineNo,
        productName: line.productName,
        qty,
        amountMillimes: refundShare(line.netMillimes, line.qty, line.refundedQty, qty),
      },
    ];
  });
  return {
    selections: lines.map(({ lineNo, qty }) => ({ lineNo, qty })),
    lines,
    totalMillimes: add(...lines.map((line) => line.amountMillimes)),
  };
}
