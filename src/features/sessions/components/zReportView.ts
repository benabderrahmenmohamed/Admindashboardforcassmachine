/**
 * What the Z-report screen shows, kept out of the components so it runs without a DOM: this
 * device's own calculation of the report, and every figure of the server's report next to it.
 */
import { computeZReport } from '@/features/sessions/zReport';
import { formatTND, type Millimes } from '@/lib/money';
import type { CashSession, Sale, ZReport } from '@/ports';

/** The most documents one listing can return (ListSalesQuery.limit). */
export const LOCAL_REPORT_LIMIT = 200;

/**
 * This device's Z-report of `session`, from the session's documents as listed, with the server's
 * formulas (computeZReport). Null when there is no complete list to count: it could not be read, or
 * it is as long as a listing gets and may be cut off. Voids are an admin's decision this device
 * does not see, so a void shows up as a discrepancy.
 */
export function localZReport(
  session: CashSession,
  sales: readonly Sale[] | undefined,
  countedCashMillimes: Millimes,
): ZReport | null {
  if (!sales || sales.length >= LOCAL_REPORT_LIMIT) {
    return null;
  }
  return computeZReport({
    sessionId: session.id,
    openingFloatMillimes: session.openingFloatMillimes,
    documents: sales
      .filter((sale) => sale.sessionId === session.id)
      .map((sale) => ({
        kind: sale.kind,
        paymentMethod: sale.paymentMethod,
        totalMillimes: sale.totalMillimes,
      })),
    voidsCount: 0,
    countedCashMillimes,
  });
}

type Figure = { readonly section: string; readonly label: string } & (
  | { readonly count: (report: ZReport) => number }
  | { readonly amount: (report: ZReport) => Millimes | null }
);

const FIGURES: readonly Figure[] = [
  { section: 'Session', label: 'Opening float', amount: (r) => r.openingFloatMillimes },
  { section: 'Session', label: 'Sales', count: (r) => r.salesCount },
  { section: 'Session', label: 'Refunds', count: (r) => r.refundsCount },
  { section: 'Session', label: 'Voided receipts', count: (r) => r.voidsCount },
  { section: 'Totals', label: 'Gross sales', amount: (r) => r.grossMillimes },
  { section: 'Totals', label: 'Refunded', amount: (r) => r.refundsMillimes },
  { section: 'Totals', label: 'Net', amount: (r) => r.netMillimes },
  { section: 'Cash', label: 'Cash sales', amount: (r) => r.byMethod.cash.salesMillimes },
  { section: 'Cash', label: 'Cash refunded', amount: (r) => r.byMethod.cash.refundsMillimes },
  { section: 'Cash', label: 'Cash net', amount: (r) => r.byMethod.cash.netMillimes },
  { section: 'Card', label: 'Card sales', amount: (r) => r.byMethod.card.salesMillimes },
  { section: 'Card', label: 'Card refunded', amount: (r) => r.byMethod.card.refundsMillimes },
  { section: 'Card', label: 'Card net', amount: (r) => r.byMethod.card.netMillimes },
  { section: 'Drawer', label: 'Expected cash', amount: (r) => r.expectedCashMillimes },
  { section: 'Drawer', label: 'Counted cash', amount: (r) => r.countedCashMillimes },
  { section: 'Drawer', label: 'Variance', amount: (r) => r.varianceMillimes },
];

const VARIANCE_LABEL = 'Variance';

function figureValue(figure: Figure, report: ZReport): number | null {
  return 'count' in figure ? figure.count(report) : figure.amount(report);
}

function formatFigure(figure: Figure, report: ZReport): string {
  if ('count' in figure) {
    return String(figure.count(report));
  }
  const amount = figure.amount(report);
  return amount === null ? 'Not counted' : formatTND(amount);
}

export interface ZReportRow {
  readonly section: string;
  readonly label: string;
  readonly value: string;
  /** This device's figure, only where it differs from the report's. */
  readonly localValue: string | null;
  readonly isVariance: boolean;
}

/** Every figure of `report` (the session id aside), in display order. */
export function zReportRows(report: ZReport, local: ZReport | null): ZReportRow[] {
  return FIGURES.map((figure) => ({
    section: figure.section,
    label: figure.label,
    value: formatFigure(figure, report),
    localValue:
      local !== null && figureValue(figure, local) !== figureValue(figure, report)
        ? formatFigure(figure, local)
        : null,
    isVariance: figure.label === VARIANCE_LABEL,
  }));
}

/** `short`: less cash than expected; `over`: more; `unknown`: nothing was counted. */
export type VarianceTone = 'short' | 'over' | 'even' | 'unknown';

export function varianceTone(varianceMillimes: Millimes | null): VarianceTone {
  if (varianceMillimes === null) {
    return 'unknown';
  }
  return varianceMillimes < 0 ? 'short' : varianceMillimes > 0 ? 'over' : 'even';
}
