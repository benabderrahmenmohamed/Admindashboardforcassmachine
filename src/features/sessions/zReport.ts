import { add, neg, sub, type Millimes } from '@/lib/money';
import type { PaymentMethod, RecordKind, ZReport } from '@/ports';

export interface ZReportDocument {
  readonly kind: RecordKind;
  readonly paymentMethod: PaymentMethod;
  /** Negative for refunds. */
  readonly totalMillimes: Millimes;
}

/**
 * The Z-report of a session from its documents, with the same formulas as the database
 * (private.compute_z_report): refunds are reported as positive amounts, expected cash is the float
 * plus cash sales minus cash refunds, and variance is counted minus expected.
 */
export function computeZReport(input: {
  readonly sessionId: string;
  readonly openingFloatMillimes: Millimes;
  readonly documents: readonly ZReportDocument[];
  readonly voidsCount: number;
  readonly countedCashMillimes: Millimes | null;
}): ZReport {
  const sum = (kind: RecordKind, method?: PaymentMethod) =>
    add(
      ...input.documents
        .filter(
          (doc) => doc.kind === kind && (method === undefined || doc.paymentMethod === method),
        )
        .map((doc) => doc.totalMillimes),
    );
  const gross = sum('sale');
  const refunds = neg(sum('refund'));
  const byMethod = (method: PaymentMethod) => {
    const sales = sum('sale', method);
    const methodRefunds = neg(sum('refund', method));
    return {
      salesMillimes: sales,
      refundsMillimes: methodRefunds,
      netMillimes: sub(sales, methodRefunds),
    };
  };
  const cash = byMethod('cash');
  const expectedCash = sub(
    add(input.openingFloatMillimes, cash.salesMillimes),
    cash.refundsMillimes,
  );
  return {
    sessionId: input.sessionId,
    openingFloatMillimes: input.openingFloatMillimes,
    salesCount: input.documents.filter((doc) => doc.kind === 'sale').length,
    refundsCount: input.documents.filter((doc) => doc.kind === 'refund').length,
    grossMillimes: gross,
    refundsMillimes: refunds,
    netMillimes: sub(gross, refunds),
    byMethod: { cash, card: byMethod('card') },
    expectedCashMillimes: expectedCash,
    countedCashMillimes: input.countedCashMillimes,
    varianceMillimes:
      input.countedCashMillimes === null ? null : sub(input.countedCashMillimes, expectedCash),
    voidsCount: input.voidsCount,
  };
}

/** True when two reports agree on every figure (the session id aside). A missing count only equals a missing count. */
export function sameZReport(a: ZReport, b: ZReport): boolean {
  const figures = (report: ZReport): readonly (number | null)[] => [
    report.openingFloatMillimes,
    report.salesCount,
    report.refundsCount,
    report.grossMillimes,
    report.refundsMillimes,
    report.netMillimes,
    report.byMethod.cash.salesMillimes,
    report.byMethod.cash.refundsMillimes,
    report.byMethod.cash.netMillimes,
    report.byMethod.card.salesMillimes,
    report.byMethod.card.refundsMillimes,
    report.byMethod.card.netMillimes,
    report.expectedCashMillimes,
    report.countedCashMillimes,
    report.varianceMillimes,
    report.voidsCount,
  ];
  const left = figures(a);
  const right = figures(b);
  return left.every((value, index) => value === right[index]);
}
