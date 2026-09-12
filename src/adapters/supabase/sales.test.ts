import { describe, expect, it } from 'vitest';
import { mm } from '@/lib/money';
import type { SaleRecord } from '@/ports';
import { failureOf, fakeSupabase, json, raised, type FakeReply } from './fakeSupabase';
import { createSupabaseSales } from './sales';

const SALE_COLUMNS =
  'id,kind,seq,receipt_number,terminal_id,session_id,refunds_sale_id,payment_method,subtotal_millimes,discount_millimes,total_millimes,tendered_millimes,change_millimes,created_at,received_at,terminals(code),sale_lines(line_no,product_id,product_name,qty,unit_price_millimes,line_discount_millimes,cart_discount_share_millimes,line_total_millimes,refunds_line_no)';

const RECORD_ID = '0b7c6f1e-3d2a-4c5b-8e9f-1a2b3c4d5e6f';
const HASH = 'ab'.repeat(32);

const record: SaleRecord = {
  id: RECORD_ID,
  kind: 'sale',
  terminalCode: 'T1',
  epoch: 2,
  seq: 42,
  sessionId: 'session-1',
  createdAt: '2026-09-11T09:30:00.000Z',
  lines: [
    {
      lineNo: 1,
      productId: 'p-water',
      productName: 'Eau minérale 1,5 L',
      qty: 2,
      unitPriceMillimes: mm(850),
      lineDiscountMillimes: mm(0),
      cartDiscountShareMillimes: mm(0),
      lineTotalMillimes: mm(1700),
      refundsLineNo: null,
    },
    {
      lineNo: 2,
      productId: 'p-harissa',
      productName: 'Harissa 380 g',
      qty: 1,
      unitPriceMillimes: mm(2450),
      lineDiscountMillimes: mm(50),
      cartDiscountShareMillimes: mm(0),
      lineTotalMillimes: mm(2400),
      refundsLineNo: null,
    },
  ],
  subtotalMillimes: mm(4100),
  discountMillimes: mm(0),
  totalMillimes: mm(4100),
  payment: { method: 'cash', tenderedMillimes: mm(5000), changeMillimes: mm(900) },
  refundsSaleId: null,
  payloadHash: HASH,
};

/** `record` as record_sale receives it. Written out, so a renaming mistake shows here. */
const recordJson = {
  id: RECORD_ID,
  kind: 'sale',
  terminal_code: 'T1',
  epoch: 2,
  seq: 42,
  session_id: 'session-1',
  created_at: '2026-09-11T09:30:00.000Z',
  lines: [
    {
      line_no: 1,
      product_id: 'p-water',
      product_name: 'Eau minérale 1,5 L',
      qty: 2,
      unit_price_millimes: 850,
      line_discount_millimes: 0,
      cart_discount_share_millimes: 0,
      line_total_millimes: 1700,
      refunds_line_no: null,
    },
    {
      line_no: 2,
      product_id: 'p-harissa',
      product_name: 'Harissa 380 g',
      qty: 1,
      unit_price_millimes: 2450,
      line_discount_millimes: 50,
      cart_discount_share_millimes: 0,
      line_total_millimes: 2400,
      refunds_line_no: null,
    },
  ],
  subtotal_millimes: 4100,
  discount_millimes: 0,
  total_millimes: 4100,
  payment: { method: 'cash', tendered_millimes: 5000, change_millimes: 900 },
  refunds_sale_id: null,
  payload_hash: HASH,
};

function saleLineRow(line: {
  line_no: number;
  product_id: string;
  qty: number;
  unit_price_millimes: number;
  line_total_millimes: number;
  refunds_line_no?: number;
}) {
  return {
    product_name: line.product_id === 'p-water' ? 'Eau minérale 1,5 L' : 'Harissa 380 g',
    line_discount_millimes: 0,
    cart_discount_share_millimes: 0,
    refunds_line_no: null,
    ...line,
  };
}

/** Sale T1-7: 2 waters and 2 harissas, lines stored out of order. */
const saleRow = {
  id: 'sale-1',
  kind: 'sale',
  seq: 7,
  receipt_number: 'T1-7',
  terminal_id: 'term-1',
  session_id: 'session-1',
  refunds_sale_id: null,
  payment_method: 'cash',
  subtotal_millimes: 6600,
  discount_millimes: 0,
  total_millimes: 6600,
  tendered_millimes: 10000,
  change_millimes: 3400,
  created_at: '2026-09-11T09:00:00.000Z',
  received_at: '2026-09-11T09:00:01.25+00:00',
  terminals: { code: 'T1' },
  sale_lines: [
    saleLineRow({
      line_no: 2,
      product_id: 'p-harissa',
      qty: 2,
      unit_price_millimes: 2450,
      line_total_millimes: 4900,
    }),
    saleLineRow({
      line_no: 1,
      product_id: 'p-water',
      qty: 2,
      unit_price_millimes: 850,
      line_total_millimes: 1700,
    }),
  ],
};

/** Refund T1-8 of one harissa of sale T1-7. */
const refundRow = {
  ...saleRow,
  id: 'refund-2',
  kind: 'refund',
  seq: 8,
  receipt_number: 'T1-8',
  refunds_sale_id: 'sale-1',
  subtotal_millimes: -2450,
  total_millimes: -2450,
  tendered_millimes: -2450,
  change_millimes: 0,
  created_at: '2026-09-11T10:00:00.000Z',
  received_at: '2026-09-11T10:00:00.5+00:00',
  sale_lines: [
    saleLineRow({
      line_no: 1,
      product_id: 'p-harissa',
      qty: -1,
      unit_price_millimes: 2450,
      line_total_millimes: -2450,
      refunds_line_no: 2,
    }),
  ],
};

/** A fake whose GET /rest/v1/sales answers the refund lookup with `refunds`, anything else with `listed`. */
function salesServer(listed: unknown[], refunds: unknown[] = []) {
  const { client, calls } = fakeSupabase((call): FakeReply => {
    if (call.method !== 'GET' || call.path !== '/rest/v1/sales') {
      return json({ message: `Unexpected ${call.method} ${call.path}` }, 404);
    }
    return json(call.query.has('refunds_sale_id') ? refunds : listed);
  });
  return { calls, sales: createSupabaseSales(client) };
}

describe('supabase sales', () => {
  it('records a sale with every key in snake_case and every value and the hash untouched', async () => {
    const { client, calls } = fakeSupabase(() =>
      json({ sale_id: RECORD_ID, receipt_number: 'T1-42', status: 'created' }),
    );

    const result = await createSupabaseSales(client).recordSale(record);

    expect(calls[0].path).toBe('/rest/v1/rpc/record_sale');
    expect(calls[0].body).toEqual({ p: recordJson });
    expect(result).toEqual({ saleId: RECORD_ID, receiptNumber: 'T1-42', status: 'created' });
  });

  it.each(['replayed', 'voided'] as const)('returns a %s outcome as it comes', async (status) => {
    const { client } = fakeSupabase(() =>
      json({ sale_id: RECORD_ID, receipt_number: 'T1-42', status }),
    );

    await expect(createSupabaseSales(client).recordSale(record)).resolves.toMatchObject({
      status,
    });
  });

  it('passes SEQUENCE_GAP on with the expected sequence in camelCase', async () => {
    const { client } = fakeSupabase(() =>
      raised(
        'SEQUENCE_GAP',
        409,
        { expected_seq: 41, received_seq: 42 },
        'Expected receipt T1-41.',
      ),
    );

    const error = await failureOf(createSupabaseSales(client).recordSale(record));

    expect(error).toMatchObject({
      code: 'SEQUENCE_GAP',
      message: 'Expected receipt T1-41.',
      details: { expectedSeq: 41, receivedSeq: 42 },
    });
  });

  it('passes the last-units VALIDATION_ERROR on with what is left of the line', async () => {
    const { client } = fakeSupabase(() =>
      raised('VALIDATION_ERROR', 422, { line_no: 1, remaining_qty: 1, remaining_millimes: 833 }),
    );

    const error = await failureOf(createSupabaseSales(client).recordSale(record));

    expect(error).toMatchObject({
      code: 'VALIDATION_ERROR',
      details: { lineNo: 1, remainingQty: 1, remainingMillimes: 833 },
    });
  });

  it('rejects a record the port schema refuses, sending nothing', async () => {
    const { client, calls } = fakeSupabase(() => json({}));

    const error = await failureOf(createSupabaseSales(client).recordSale({ ...record, seq: 0 }));

    expect(error.code).toBe('VALIDATION_ERROR');
    expect(calls).toEqual([]);
  });

  it('lists sales newest first, lines in order, with what refunds from anywhere took back', async () => {
    const { calls, sales } = salesServer(
      [refundRow, saleRow],
      [
        // An earlier refund from another terminal took one harissa and both waters.
        {
          refunds_sale_id: 'sale-1',
          sale_lines: [
            { refunds_line_no: 2, qty: -1, line_total_millimes: -2450 },
            { refunds_line_no: 1, qty: -2, line_total_millimes: -1700 },
          ],
        },
        {
          refunds_sale_id: 'sale-1',
          sale_lines: [{ refunds_line_no: 2, qty: -1, line_total_millimes: -2450 }],
        },
      ],
    );

    const listed = await sales.listSales({ terminalId: 'term-1', limit: 20 });

    expect(calls[0].query.get('select')).toBe(SALE_COLUMNS);
    expect(calls[0].query.get('terminal_id')).toBe('eq.term-1');
    expect(calls[0].query.has('session_id')).toBe(false);
    expect(calls[0].query.get('order')).toBe('received_at.desc,seq.desc');
    expect(calls[0].query.get('limit')).toBe('20');
    expect(calls[1].query.get('select')).toBe(
      'refunds_sale_id,sale_lines(refunds_line_no,qty,line_total_millimes)',
    );
    expect(calls[1].query.get('refunds_sale_id')).toBe('in.(sale-1)');
    expect(listed).toEqual([
      {
        id: 'refund-2',
        kind: 'refund',
        receiptNumber: 'T1-8',
        seq: 8,
        terminalId: 'term-1',
        terminalCode: 'T1',
        sessionId: 'session-1',
        refundsSaleId: 'sale-1',
        paymentMethod: 'cash',
        subtotalMillimes: -2450,
        discountMillimes: 0,
        totalMillimes: -2450,
        tenderedMillimes: -2450,
        changeMillimes: 0,
        createdAt: '2026-09-11T10:00:00.000Z',
        receivedAt: '2026-09-11T10:00:00.5+00:00',
        lines: [
          {
            lineNo: 1,
            productId: 'p-harissa',
            productName: 'Harissa 380 g',
            qty: -1,
            unitPriceMillimes: 2450,
            lineDiscountMillimes: 0,
            cartDiscountShareMillimes: 0,
            lineTotalMillimes: -2450,
            refundsLineNo: 2,
            refundedQty: 0,
            refundedMillimes: 0,
          },
        ],
      },
      {
        id: 'sale-1',
        kind: 'sale',
        receiptNumber: 'T1-7',
        seq: 7,
        terminalId: 'term-1',
        terminalCode: 'T1',
        sessionId: 'session-1',
        refundsSaleId: null,
        paymentMethod: 'cash',
        subtotalMillimes: 6600,
        discountMillimes: 0,
        totalMillimes: 6600,
        tenderedMillimes: 10000,
        changeMillimes: 3400,
        createdAt: '2026-09-11T09:00:00.000Z',
        receivedAt: '2026-09-11T09:00:01.25+00:00',
        lines: [
          {
            lineNo: 1,
            productId: 'p-water',
            productName: 'Eau minérale 1,5 L',
            qty: 2,
            unitPriceMillimes: 850,
            lineDiscountMillimes: 0,
            cartDiscountShareMillimes: 0,
            lineTotalMillimes: 1700,
            refundsLineNo: null,
            refundedQty: 2,
            refundedMillimes: 1700,
          },
          {
            lineNo: 2,
            productId: 'p-harissa',
            productName: 'Harissa 380 g',
            qty: 2,
            unitPriceMillimes: 2450,
            lineDiscountMillimes: 0,
            cartDiscountShareMillimes: 0,
            lineTotalMillimes: 4900,
            refundsLineNo: null,
            refundedQty: 2,
            refundedMillimes: 4900,
          },
        ],
      },
    ]);
  });

  it('filters by session and sends no refund lookup when nothing was sold', async () => {
    const { calls, sales } = salesServer([]);

    await expect(sales.listSales({ sessionId: 'session-1' })).resolves.toEqual([]);

    expect(calls).toHaveLength(1);
    expect(calls[0].query.get('session_id')).toBe('eq.session-1');
    expect(calls[0].query.has('limit')).toBe(false);
  });

  it('looks refunds up 50 sale ids at a time', async () => {
    const rows = Array.from({ length: 120 }, (_, index) => ({
      ...saleRow,
      id: `sale-${index}`,
      seq: index + 1,
      receipt_number: `T1-${index + 1}`,
    }));
    const { calls, sales } = salesServer(rows);

    const listed = await sales.listSales({});

    const lookups = calls.filter((call) => call.query.has('refunds_sale_id'));
    const batches = lookups.map((call) =>
      (call.query.get('refunds_sale_id') ?? '').replace(/^in\.\(|\)$/g, '').split(','),
    );
    expect(batches.map((ids) => ids.length)).toEqual([50, 50, 20]);
    expect(batches.flat()).toEqual(rows.map((row) => row.id));
    expect(listed).toHaveLength(120);
  });

  it('reads one sale by id', async () => {
    const { calls, sales } = salesServer([saleRow]);

    const sale = await sales.getSale('sale-1');

    expect(calls[0].query.get('id')).toBe('eq.sale-1');
    expect(sale.lines.map((line) => [line.lineNo, line.refundedQty])).toEqual([
      [1, 0],
      [2, 0],
    ]);
  });

  it('reports an unknown sale as NOT_FOUND with its id', async () => {
    const { calls, sales } = salesServer([]);

    const error = await failureOf(sales.getSale('sale-x'));

    expect(error).toMatchObject({ code: 'NOT_FOUND', details: { saleId: 'sale-x' } });
    expect(calls).toHaveLength(1);
  });

  it('voids a receipt with the queued record and the reason in snake_case', async () => {
    const { client, calls } = fakeSupabase(() =>
      json({ sale_id: RECORD_ID, receipt_number: 'T1-42', status: 'recorded' }),
    );

    const result = await createSupabaseSales(client).voidReceipt({
      record,
      errorCode: 'VALIDATION_ERROR',
      reason: 'Refund above what was left',
    });

    expect(calls[0].path).toBe('/rest/v1/rpc/void_receipt');
    expect(calls[0].body).toEqual({
      p: {
        record: recordJson,
        error_code: 'VALIDATION_ERROR',
        reason: 'Refund above what was left',
      },
    });
    expect(result).toEqual({ saleId: RECORD_ID, receiptNumber: 'T1-42', status: 'recorded' });
  });
});
