import { describe, expect, it } from 'vitest';
import { computeZReport, sameZReport } from '@/features/sessions/zReport';
import { formatTND, mm, ZERO } from '@/lib/money';
import type { CashSession, PaymentMethod, RecordKind, Sale, ZReport } from '@/ports';
import { LOCAL_REPORT_LIMIT, localZReport, varianceTone, zReportRows } from './zReportView';

const SESSION_ID = 'session-1';
const AT = '2026-09-11T09:00:00.000Z';

const session: CashSession = {
  id: SESSION_ID,
  terminalId: 'terminal-1',
  terminalCode: 'T1',
  openedBy: 'cashier-1',
  openedAt: AT,
  openingFloatMillimes: mm(50_000),
  closedAt: null,
  closedBy: null,
  closingCountedMillimes: null,
  forceCloseReason: null,
  zReport: null,
};

function doc(
  seq: number,
  kind: RecordKind,
  paymentMethod: PaymentMethod,
  total: number,
  sessionId = SESSION_ID,
): Sale {
  const totalMillimes = mm(total);
  return {
    id: `sale-${seq}`,
    kind,
    receiptNumber: `T1-${seq}`,
    seq,
    terminalId: 'terminal-1',
    terminalCode: 'T1',
    sessionId,
    refundsSaleId: kind === 'refund' ? 'sale-1' : null,
    paymentMethod,
    subtotalMillimes: totalMillimes,
    discountMillimes: ZERO,
    totalMillimes,
    tenderedMillimes: totalMillimes,
    changeMillimes: ZERO,
    createdAt: AT,
    receivedAt: AT,
    lines: [
      {
        lineNo: 1,
        productId: 'p-1',
        productName: 'Product',
        qty: kind === 'sale' ? 1 : -1,
        unitPriceMillimes: mm(Math.abs(total)),
        lineDiscountMillimes: ZERO,
        cartDiscountShareMillimes: ZERO,
        lineTotalMillimes: totalMillimes,
        refundsLineNo: kind === 'refund' ? 1 : null,
        refundedQty: 0,
        refundedMillimes: ZERO,
      },
    ],
  };
}

const documents = [
  doc(4, 'refund', 'card', -1000),
  doc(3, 'refund', 'cash', -2000),
  doc(2, 'sale', 'card', 8000),
  doc(1, 'sale', 'cash', 12_500),
];

const LABELS = [
  'Opening float',
  'Sales',
  'Refunds',
  'Voided receipts',
  'Gross sales',
  'Refunded',
  'Net',
  'Cash sales',
  'Cash refunded',
  'Cash net',
  'Card sales',
  'Card refunded',
  'Card net',
  'Expected cash',
  'Counted cash',
  'Variance',
];

function report(overrides: Partial<ZReport> = {}): ZReport {
  return {
    ...computeZReport({
      sessionId: SESSION_ID,
      openingFloatMillimes: mm(50_000),
      documents,
      voidsCount: 0,
      countedCashMillimes: mm(60_000),
    }),
    ...overrides,
  };
}

describe('localZReport', () => {
  it("counts the session's documents with the server's formulas", () => {
    const local = localZReport(session, documents, mm(60_000));

    expect(local).toEqual(report());
    expect(local).toMatchObject({
      salesCount: 2,
      refundsCount: 2,
      grossMillimes: 20_500,
      refundsMillimes: 3000,
      netMillimes: 17_500,
      expectedCashMillimes: 60_500,
      countedCashMillimes: 60_000,
      varianceMillimes: -500,
      voidsCount: 0,
    });
  });

  it('ignores documents of other sessions', () => {
    const listed = [...documents, doc(9, 'sale', 'cash', 99_000, 'session-0')];
    expect(localZReport(session, listed, mm(60_000))).toEqual(report());
  });

  it('makes no report without a complete list', () => {
    expect(localZReport(session, undefined, mm(60_000))).toBeNull();
    const full = Array.from({ length: LOCAL_REPORT_LIMIT }, (_, index) =>
      doc(index + 1, 'sale', 'cash', 1000),
    );
    expect(localZReport(session, full, mm(60_000))).toBeNull();
    expect(localZReport(session, full.slice(1), mm(60_000))).not.toBeNull();
  });
});

describe('zReportRows', () => {
  it('shows every figure of the report, formatted', () => {
    const rows = zReportRows(report(), null);

    expect(rows.map((row) => row.label)).toEqual(LABELS);
    expect(rows.find((row) => row.label === 'Sales')?.value).toBe('2');
    expect(rows.find((row) => row.label === 'Expected cash')?.value).toBe(formatTND(mm(60_500)));
    expect(rows.find((row) => row.label === 'Variance')?.value).toBe(formatTND(mm(-500)));
    expect(rows.filter((row) => row.isVariance).map((row) => row.label)).toEqual(['Variance']);
    expect(rows.every((row) => row.localValue === null)).toBe(true);
  });

  it('says when nothing was counted', () => {
    const rows = zReportRows(report({ countedCashMillimes: null, varianceMillimes: null }), null);
    expect(rows.find((row) => row.label === 'Counted cash')?.value).toBe('Not counted');
    expect(rows.find((row) => row.label === 'Variance')?.value).toBe('Not counted');
  });

  it("puts this device's figure next to each one that differs", () => {
    const server = report({ voidsCount: 1 });
    const rows = zReportRows(server, report());

    expect(rows.filter((row) => row.localValue !== null)).toEqual([
      {
        section: 'Session',
        label: 'Voided receipts',
        value: '1',
        localValue: '0',
        isVariance: false,
      },
    ]);
  });

  it('marks a difference exactly when sameZReport sees one', () => {
    const local = report();
    const variants = [
      report(),
      report({ sessionId: 'another-id' }),
      report({ voidsCount: 2 }),
      localZReport(session, documents.slice(1), mm(60_000)) ?? report(),
      localZReport(session, documents, mm(61_000)) ?? report(),
    ];
    for (const server of variants) {
      const differs = zReportRows(server, local).some((row) => row.localValue !== null);
      expect(differs).toBe(!sameZReport(server, local));
    }
  });
});

describe('varianceTone', () => {
  it('tells short, over and even apart', () => {
    expect(varianceTone(mm(-1))).toBe('short');
    expect(varianceTone(mm(1))).toBe('over');
    expect(varianceTone(mm(0))).toBe('even');
    expect(varianceTone(null)).toBe('unknown');
  });
});
