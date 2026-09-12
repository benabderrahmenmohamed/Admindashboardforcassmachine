import { describe, expect, it } from 'vitest';
import {
  closeRecord,
  meta,
  openRecord,
  refundRecord,
  saleLine,
  saleRecord,
} from '@/features/pos/__fixtures__/records';
import type { NumberedRecord } from '@/features/pos/queue';
import { mm, ZERO } from '@/lib/money';
import type { Sale } from '@/ports';
import { findRow, localSaleView, mergeSales, withLocalRefunds } from './salesList';

const terminal = meta();

/** The same document once the server has stored it, with the time it received it. */
function stored(record: NumberedRecord): Sale {
  return { ...localSaleView(terminal, record), receivedAt: '2026-09-11T09:00:02.000Z' };
}

describe('localSaleView', () => {
  it('reads a record as the ledger will hold it, with the number it was written under', () => {
    const record = saleRecord({ seq: 42, method: 'cash', lines: [saleLine({ qty: 2 })] });

    expect(localSaleView(terminal, record)).toMatchObject({
      id: record.payload.id,
      kind: 'sale',
      receiptNumber: 'T1-42',
      seq: 42,
      terminalId: 'terminal-1',
      terminalCode: 'T1',
      paymentMethod: 'cash',
      totalMillimes: mm(1900),
      lines: [{ lineNo: 1, qty: 2, refundedQty: 0, refundedMillimes: ZERO }],
    });
  });
});

describe('mergeSales', () => {
  it('shows what the server holds and what is still on this device, newest receipt first', () => {
    const synced = saleRecord({ seq: 41, ordinal: 1, status: 'acked' });
    const waiting = saleRecord({ seq: 42, ordinal: 2, status: 'pending' });
    const refused = saleRecord({ seq: 43, ordinal: 3, status: 'conflict' });

    const rows = mergeSales(terminal, [stored(synced)], [synced, waiting, refused]);

    expect(rows.map((row) => [row.sale.receiptNumber, row.syncStatus])).toEqual([
      ['T1-43', 'conflict'],
      ['T1-42', 'pending'],
      ['T1-41', 'synced'],
    ]);
    // The server's row is the one kept, so it is not listed twice.
    expect(rows.filter((row) => row.sale.seq === 41)).toHaveLength(1);
    expect(rows[2].record).toBeNull();
    expect(rows[1].record).toBe(waiting);
  });

  it("lists only this device's queue while the server cannot be reached", () => {
    const waiting = saleRecord({ seq: 42, ordinal: 1 });
    const rows = mergeSales(terminal, [], [openRecord({ ordinal: 0 }), waiting]);

    expect(rows).toHaveLength(1);
    expect(rows[0].sale.receiptNumber).toBe('T1-42');
  });

  it('leaves out records written under another registration', () => {
    const elsewhere = saleRecord({ seq: 7, ordinal: 1, terminalCode: 'T2' });
    expect(mergeSales(terminal, [], [elsewhere])).toEqual([]);
  });

  it('ignores session records, which carry no receipt', () => {
    expect(
      mergeSales(terminal, [], [openRecord({ ordinal: 1 }), closeRecord({ ordinal: 2 })]),
    ).toEqual([]);
  });

  it('takes a refund that is still on this device off the sale it refunds', () => {
    const sale = saleRecord({
      seq: 41,
      ordinal: 1,
      status: 'acked',
      lines: [saleLine({ qty: 2 })],
    });
    const refund = refundRecord(sale, { seq: 42, ordinal: 2, qty: 1 });

    const rows = mergeSales(terminal, [stored(sale)], [sale, refund]);
    const refunded = rows.find((row) => row.sale.seq === 41);

    // Without this the same unit could be refunded twice offline, and the second refund refused.
    expect(refunded?.sale.lines[0]).toMatchObject({
      qty: 2,
      refundedQty: 1,
      refundedMillimes: mm(950),
    });
  });

  it('counts nothing back from a refund an admin voided', () => {
    const sale = saleRecord({
      seq: 41,
      ordinal: 1,
      status: 'acked',
      lines: [saleLine({ qty: 2 })],
    });
    const refund = refundRecord(sale, { seq: 42, ordinal: 2, qty: 1, status: 'voided' });

    const rows = mergeSales(terminal, [stored(sale)], [sale, refund]);

    expect(rows.find((row) => row.sale.seq === 41)?.sale.lines[0].refundedQty).toBe(0);
  });

  it('stops counting a refund locally once the server lists it', () => {
    const sale = saleRecord({
      seq: 41,
      ordinal: 1,
      status: 'acked',
      lines: [saleLine({ qty: 2 })],
    });
    const refund = refundRecord(sale, { seq: 42, ordinal: 2, qty: 1, status: 'acked' });
    const serverSale: Sale = {
      ...stored(sale),
      lines: [{ ...stored(sale).lines[0], refundedQty: 1, refundedMillimes: mm(950) }],
    };

    const rows = mergeSales(terminal, [serverSale, stored(refund)], [sale, refund]);

    expect(rows.find((row) => row.sale.seq === 41)?.sale.lines[0]).toMatchObject({
      refundedQty: 1,
      refundedMillimes: mm(950),
    });
  });
});

describe('withLocalRefunds and findRow', () => {
  it('leaves a sale alone when nothing refunds it', () => {
    const sale = localSaleView(terminal, saleRecord({ seq: 41 }));
    expect(withLocalRefunds(sale, [])).toBe(sale);
  });

  it('finds a row by the id of the document, and nothing for an unknown one', () => {
    const record = saleRecord({ seq: 41, ordinal: 1 });
    const rows = mergeSales(terminal, [], [record]);

    expect(findRow(rows, record.payload.id)?.sale.seq).toBe(41);
    expect(findRow(rows, 'no-such-sale')).toBeNull();
  });
});
