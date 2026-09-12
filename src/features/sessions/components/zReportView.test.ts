import { describe, expect, it } from 'vitest';
import {
  openRecord,
  saleLine,
  saleRecord,
  SESSION_ID,
  uuid,
} from '@/features/pos/__fixtures__/records';
import { computeZReport, sameZReport, type ZReportDocument } from '@/features/sessions/zReport';
import type { OutboxRecord } from '@/features/sync/types';
import { formatTND, mm } from '@/lib/money';
import type { CashSession, ZReport } from '@/ports';
import { localZReport, varianceTone, zReportRows } from './zReportView';

const session: CashSession = {
  id: SESSION_ID,
  terminalId: 'terminal-1',
  terminalCode: 'T1',
  openedBy: 'cashier-1',
  openedAt: '2026-09-11T09:00:00.000Z',
  openingFloatMillimes: mm(50_000),
  closedAt: null,
  closedBy: null,
  closingCountedMillimes: null,
  forceCloseReason: null,
  zReport: null,
};

/** One line worth `total` millimes: negative on a refund, which also has a negative quantity. */
function line(total: number) {
  return saleLine({
    qty: total < 0 ? -1 : 1,
    unitPriceMillimes: mm(Math.abs(total)),
    lineTotalMillimes: mm(total),
    refundsLineNo: total < 0 ? 1 : null,
  });
}

const documents: ZReportDocument[] = [
  { kind: 'sale', paymentMethod: 'cash', totalMillimes: mm(12_500) },
  { kind: 'sale', paymentMethod: 'card', totalMillimes: mm(8000) },
  { kind: 'refund', paymentMethod: 'cash', totalMillimes: mm(-2000) },
  { kind: 'refund', paymentMethod: 'card', totalMillimes: mm(-1000) },
];

/** The same four documents as this device's queue holds them, behind the record that opened them. */
const records: OutboxRecord[] = [
  openRecord({ ordinal: 1, status: 'acked' }),
  saleRecord({ seq: 1, ordinal: 2, status: 'acked', method: 'cash', lines: [line(12_500)] }),
  saleRecord({ seq: 2, ordinal: 3, status: 'acked', method: 'card', lines: [line(8000)] }),
  saleRecord({ seq: 3, ordinal: 4, kind: 'refund', method: 'cash', lines: [line(-2000)] }),
  saleRecord({ seq: 4, ordinal: 5, kind: 'refund', method: 'card', lines: [line(-1000)] }),
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
  it("counts the records this device wrote with the server's formulas", () => {
    const local = localZReport(session, records, mm(60_000));

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
    const other = saleRecord({ seq: 9, ordinal: 6, sessionId: uuid(9), lines: [line(99_000)] });
    expect(localZReport(session, [...records, other], mm(60_000))).toEqual(report());
  });

  it('needs no network: a queue full of unsent records counts the same', () => {
    const unsent = records.map((record) => ({ ...record, status: 'pending' as const }));
    expect(localZReport(session, unsent, mm(60_000))).toEqual(report());
  });

  it('makes no report for a session this device did not open', () => {
    // A device registered mid-session adopts the open session but never saw what came before.
    expect(localZReport(session, records.slice(1), mm(60_000))).toBeNull();
    expect(localZReport(session, [], mm(60_000))).toBeNull();
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
      localZReport(session, records.slice(0, 4), mm(60_000)) ?? report(),
      localZReport(session, records, mm(61_000)) ?? report(),
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
