import { describe, expect, it } from 'vitest';
import { addItem, emptyCart, setCartDiscount } from '@/features/pos/cart';
import { buildRefundRecord, buildSaleRecord, receiptNumber } from '@/features/sales/records';
import { add, mm, neg, ZERO } from '@/lib/money';
import type { Sale, SaleRecord } from '@/ports';
import {
  allRemaining,
  canRefund,
  refundableLines,
  refundPreview,
  setRefundQty,
  type RefundPreview,
} from './refundSelection';

const SALE_ID = '00000000-0000-4000-8000-000000000001';
const REFUND_ID = '00000000-0000-4000-8000-000000000002';
const AT = '2026-09-11T09:00:00.000Z';
const envelope = {
  sessionId: 'session-1',
  createdAt: AT,
  terminal: { terminalCode: 'T1', epoch: 0 },
};

const harissa = { id: 'p-harissa', name: 'Harissa Cap Bon 380 g', priceMillimes: mm(1350) };
const water = { id: 'p-eau', name: 'Eau Safia 1,5 L', priceMillimes: mm(650) };

function view(record: SaleRecord): Sale {
  return {
    id: record.id,
    kind: record.kind,
    receiptNumber: receiptNumber(record.terminalCode, record.seq),
    seq: record.seq,
    terminalId: 'terminal-1',
    terminalCode: record.terminalCode,
    sessionId: record.sessionId,
    refundsSaleId: record.refundsSaleId,
    paymentMethod: record.payment.method,
    subtotalMillimes: record.subtotalMillimes,
    discountMillimes: record.discountMillimes,
    totalMillimes: record.totalMillimes,
    tenderedMillimes: record.payment.tenderedMillimes,
    changeMillimes: record.payment.changeMillimes,
    createdAt: record.createdAt,
    receivedAt: record.createdAt,
    lines: record.lines.map((line) => ({ ...line, refundedQty: 0, refundedMillimes: ZERO })),
  };
}

/**
 * 3 × 1,350 and 1 × 650 with a 7 % cart discount: the harissa line totals 3,766 millimes, which does
 * not split evenly into three units.
 */
async function discountedSale(): Promise<Sale> {
  const cart = setCartDiscount(addItem(addItem(emptyCart, harissa, 3), water), 700);
  const record = await buildSaleRecord({ ...envelope, id: SALE_ID, seq: 42 }, cart, {
    method: 'cash',
  });
  return view(record);
}

/** The sale as the server lists it after `preview` was recorded. */
function afterRefund(sale: Sale, preview: RefundPreview): Sale {
  return {
    ...sale,
    lines: sale.lines.map((line) => {
      const refunded = preview.lines.find((candidate) => candidate.lineNo === line.lineNo);
      return refunded
        ? {
            ...line,
            refundedQty: line.refundedQty + refunded.qty,
            refundedMillimes: add(line.refundedMillimes, refunded.amountMillimes),
          }
        : line;
    }),
  };
}

describe('refundableLines and canRefund', () => {
  it('lists what is left of each line', async () => {
    const sale = await discountedSale();
    expect(
      refundableLines(sale).map(({ line, remainingQty, remainingMillimes }) => [
        line.lineNo,
        remainingQty,
        remainingMillimes,
      ]),
    ).toEqual([
      [1, 3, 3766],
      [2, 1, 605],
    ]);
    expect(canRefund(sale)).toBe(true);
  });

  it('has nothing left once every unit is refunded, and nothing on a refund document', async () => {
    const sale = await discountedSale();
    const refunded = afterRefund(sale, refundPreview(sale, allRemaining(sale)));
    expect(refundableLines(refunded).map((entry) => entry.remainingQty)).toEqual([0, 0]);
    expect(refundableLines(refunded).map((entry) => entry.remainingMillimes)).toEqual([0, 0]);
    expect(canRefund(refunded)).toBe(false);

    const refundDocument: Sale = { ...sale, kind: 'refund', refundsSaleId: SALE_ID };
    expect(refundableLines(refundDocument)).toEqual([]);
    expect(canRefund(refundDocument)).toBe(false);
  });
});

describe('setRefundQty and allRemaining', () => {
  it('keeps a line between zero and what is left of it', async () => {
    const sale = await discountedSale();
    const none = new Map<number, number>();
    expect(setRefundQty(sale, none, 1, 2).get(1)).toBe(2);
    expect(setRefundQty(sale, none, 1, 9).get(1)).toBe(3);
    expect(setRefundQty(sale, none, 1, -1).get(1)).toBe(0);
    expect(setRefundQty(sale, none, 1, 1.5).get(1)).toBe(0);
    expect(setRefundQty(sale, none, 7, 1)).toBe(none);

    const partly = afterRefund(sale, refundPreview(sale, new Map([[1, 2]])));
    expect(setRefundQty(partly, none, 1, 3).get(1)).toBe(1);
  });

  it('does not change the quantities it is given', async () => {
    const sale = await discountedSale();
    const quantities = new Map([[2, 1]]);
    setRefundQty(sale, quantities, 1, 2);
    expect([...quantities]).toEqual([[2, 1]]);
  });

  it('selects every unit left, skipping lines already refunded', async () => {
    const sale = await discountedSale();
    expect([...allRemaining(sale)]).toEqual([
      [1, 3],
      [2, 1],
    ]);
    const waterRefunded = afterRefund(sale, refundPreview(sale, new Map([[2, 1]])));
    expect([...allRemaining(waterRefunded)]).toEqual([[1, 3]]);
  });
});

describe('refundPreview', () => {
  it('refunds a line unit by unit in parts that add up to exactly its total', async () => {
    let sale = await discountedSale();
    const parts: number[] = [];
    for (let unit = 0; unit < 3; unit += 1) {
      const preview = refundPreview(sale, new Map([[1, 1]]));
      parts.push(preview.totalMillimes);
      sale = afterRefund(sale, preview);
    }
    expect(parts).toEqual([1255, 1255, 1256]);
    expect(add(...parts.map((part) => mm(part)))).toBe(3766);
    expect(canRefund(sale)).toBe(true);
    expect(refundPreview(sale, new Map([[1, 1]])).lines).toEqual([]);
  });

  it('leaves out lines with nothing chosen and never takes more than is left', async () => {
    const sale = await discountedSale();
    const preview = refundPreview(
      sale,
      new Map([
        [1, 0],
        [2, 5],
      ]),
    );
    expect(preview.selections).toEqual([{ lineNo: 2, qty: 1 }]);
    expect(preview.lines).toEqual([
      { lineNo: 2, productName: 'Eau Safia 1,5 L', qty: 1, amountMillimes: 605 },
    ]);
    expect(preview.totalMillimes).toBe(605);
    expect(refundPreview(sale, new Map()).totalMillimes).toBe(0);
  });

  it('shows the amounts the refund record will carry', async () => {
    const sale = afterRefund(
      await discountedSale(),
      refundPreview(await discountedSale(), new Map([[1, 1]])),
    );
    const preview = refundPreview(
      sale,
      new Map([
        [1, 2],
        [2, 1],
      ]),
    );

    const record = await buildRefundRecord(
      { ...envelope, id: REFUND_ID, seq: 43 },
      sale,
      preview.selections,
      'card',
    );

    expect(record.lines.map((line) => neg(line.lineTotalMillimes))).toEqual(
      preview.lines.map((line) => line.amountMillimes),
    );
    expect(record.totalMillimes).toBe(neg(preview.totalMillimes));
  });
});
