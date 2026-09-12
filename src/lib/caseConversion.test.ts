import { describe, expect, it } from 'vitest';
import { camelToSnake, keysToCamel, keysToSnake, snakeToCamel } from './caseConversion';

// Black-box tests of the wire key conversion: ports use camelCase, RPC parameters, results and
// error details use snake_case, and adapters rename keys at any depth and change nothing else.

/** Keys used by the ports and the error contract, with their wire spelling. */
const KEYS: [string, string][] = [
  ['id', 'id'],
  ['qty', 'qty'],
  ['lineNo', 'line_no'],
  ['payloadHash', 'payload_hash'],
  ['terminalCode', 'terminal_code'],
  ['unitPriceMillimes', 'unit_price_millimes'],
  ['cartDiscountShareMillimes', 'cart_discount_share_millimes'],
  ['refundsLineNo', 'refunds_line_no'],
  ['refundsSaleId', 'refunds_sale_id'],
  ['clientZReport', 'client_z_report'],
  ['zReport', 'z_report'],
  ['byMethod', 'by_method'],
  ['expectedSeq', 'expected_seq'],
  ['receivedSeq', 'received_seq'],
  ['openSessionId', 'open_session_id'],
  ['currentEpoch', 'current_epoch'],
  ['remainingQty', 'remaining_qty'],
  ['remainingMillimes', 'remaining_millimes'],
  ['actorUserId', 'actor_user_id'],
  ['lastSeq', 'last_seq'],
];

/** Every key of every plain object inside `value`, depth first. */
function keysOf(value: unknown): string[] {
  if (Array.isArray(value)) {
    return (value as unknown[]).flatMap((item) => keysOf(item));
  }
  if (typeof value === 'object' && value !== null) {
    return Object.entries(value as Record<string, unknown>).flatMap(([key, item]) => [
      key,
      ...keysOf(item),
    ]);
  }
  return [];
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    Object.values(value as Record<string, unknown>).forEach((item) => {
      deepFreeze(item);
    });
    Object.freeze(value);
  }
  return value;
}

const saleRecord = {
  id: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
  kind: 'refund',
  terminalCode: 'T1',
  epoch: 1,
  seq: 43,
  sessionId: 'a3b1c2d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d',
  createdAt: '2026-09-11T09:20:00.000Z',
  lines: [
    {
      lineNo: 1,
      productId: '9b2d7c4e-1f3a-4b5c-8d6e-7f8a9b0c1d2e',
      productName: 'Café moulu 250 g',
      qty: -1,
      unitPriceMillimes: 8_750,
      lineDiscountMillimes: 0,
      cartDiscountShareMillimes: 0,
      lineTotalMillimes: -8_750,
      refundsLineNo: 1,
    },
  ],
  subtotalMillimes: -8_750,
  discountMillimes: 0,
  totalMillimes: -8_750,
  payment: { method: 'card', tenderedMillimes: -8_750, changeMillimes: 0 },
  refundsSaleId: 'c9bf9e57-1685-4c89-bafb-ff5af830be8a',
  payloadHash: '56ba2db5f02169304d79b591651656f4d78c1c3ca5ac356aa1cd9bd9f5b3af02',
};

const zReport = {
  sessionId: 'a3b1c2d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d',
  openingFloatMillimes: 50_000,
  salesCount: 2,
  refundsCount: 1,
  grossMillimes: 20_000,
  refundsMillimes: 8_750,
  netMillimes: 11_250,
  byMethod: {
    cash: { salesMillimes: 11_250, refundsMillimes: 0, netMillimes: 11_250 },
    card: { salesMillimes: 8_750, refundsMillimes: 8_750, netMillimes: 0 },
  },
  expectedCashMillimes: 61_250,
  countedCashMillimes: null,
  varianceMillimes: null,
  voidsCount: 0,
};

describe('camelToSnake and snakeToCamel', () => {
  it.each(KEYS)('turn %s into %s and back', (camel, snake) => {
    expect(camelToSnake(camel)).toBe(snake);
    expect(snakeToCamel(snake)).toBe(camel);
  });

  it('leave keys that are already in the target case alone', () => {
    for (const [camel, snake] of KEYS) {
      expect(camelToSnake(snake)).toBe(snake);
      expect(snakeToCamel(camel)).toBe(camel);
    }
  });
});

describe('keysToSnake', () => {
  it('renames keys at every depth: nested objects, arrays of objects and arrays of arrays', () => {
    const value = {
      saleId: 's1',
      lines: [
        { lineNo: 1, refundsLineNo: null },
        { lineNo: 2, refundsLineNo: 1 },
      ],
      payment: { tenderedMillimes: 20_000, changeMillimes: 1_150 },
      clientZReport: { byMethod: { cash: { salesMillimes: 1 } } },
      matrix: [[{ innerKey: [{ deepestKey: true }] }], []],
    };

    expect(keysToSnake(value)).toEqual({
      sale_id: 's1',
      lines: [
        { line_no: 1, refunds_line_no: null },
        { line_no: 2, refunds_line_no: 1 },
      ],
      payment: { tendered_millimes: 20_000, change_millimes: 1_150 },
      client_z_report: { by_method: { cash: { sales_millimes: 1 } } },
      matrix: [[{ inner_key: [{ deepest_key: true }] }], []],
    });
  });

  it('leaves every value untouched, including text that looks like a key', () => {
    const value = {
      productName: 'lineNo',
      tags: ['unitPriceMillimes', 'line_no'],
      receiptNumber: 'T1-42',
      zero: 0,
      negative: -5,
      largest: Number.MAX_SAFE_INTEGER,
      flag: false,
      nothing: null,
    };

    expect(keysToSnake(value)).toEqual({
      product_name: 'lineNo',
      tags: ['unitPriceMillimes', 'line_no'],
      receipt_number: 'T1-42',
      zero: 0,
      negative: -5,
      largest: Number.MAX_SAFE_INTEGER,
      flag: false,
      nothing: null,
    });
  });

  it('keeps a key whose value is undefined, renamed', () => {
    const converted = keysToSnake({ closedAt: undefined });

    expect(Object.keys(converted as object)).toEqual(['closed_at']);
    expect(converted).toHaveProperty('closed_at', undefined);
  });

  it('passes anything that is not a plain object or array through as it is', () => {
    const date = new Date('2026-09-11T08:00:00.000Z');

    expect(keysToSnake({ openedAt: date })).toEqual({ opened_at: date });
    expect((keysToSnake([date]) as unknown[])[0]).toBe(date);
    for (const value of [42, 'lineNo', '', null, undefined, true]) {
      expect(keysToSnake(value)).toBe(value);
    }
  });

  it('does not change its input', () => {
    const record = deepFreeze(structuredClone(saleRecord));

    const converted = keysToSnake(record);

    expect(record).toEqual(saleRecord);
    expect(converted).not.toBe(record);
  });
});

describe('keysToCamel', () => {
  it.each<[object, object]>([
    [
      { expected_seq: 42, received_seq: 43 },
      { expectedSeq: 42, receivedSeq: 43 },
    ],
    [
      { line_no: 2, remaining_qty: 1, remaining_millimes: 334 },
      { lineNo: 2, remainingQty: 1, remainingMillimes: 334 },
    ],
    [
      { terminal_code: 'T1', current_epoch: 3 },
      { terminalCode: 'T1', currentEpoch: 3 },
    ],
    [{ open_session_id: 'a3b1' }, { openSessionId: 'a3b1' }],
  ])('reads the error details %j', (details, expected) => {
    expect(keysToCamel(details)).toEqual(expected);
  });

  it('reads an RPC result at every depth, values untouched', () => {
    const result = {
      session_id: 'a3b1c2d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d',
      status: 'created',
      z_report: keysToSnake(zReport),
    };

    expect(keysToCamel(result)).toEqual({
      sessionId: 'a3b1c2d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d',
      status: 'created',
      zReport,
    });
  });

  it('does not change its input', () => {
    const wire = deepFreeze({ by_method: { cash: { sales_millimes: 1 } }, list: [{ line_no: 1 }] });

    expect(keysToCamel(wire)).toEqual({
      byMethod: { cash: { salesMillimes: 1 } },
      list: [{ lineNo: 1 }],
    });
    expect(wire).toEqual({ by_method: { cash: { sales_millimes: 1 } }, list: [{ line_no: 1 }] });
  });
});

describe('the wire round trip', () => {
  it('sends a record in snake_case with its hash unchanged and reads it back exactly', () => {
    const wire = keysToSnake(saleRecord);

    expect(wire).toMatchObject({
      payload_hash: saleRecord.payloadHash,
      terminal_code: 'T1',
      refunds_sale_id: saleRecord.refundsSaleId,
      lines: [{ line_no: 1, unit_price_millimes: 8_750, refunds_line_no: 1, qty: -1 }],
      payment: { method: 'card', tendered_millimes: -8_750, change_millimes: 0 },
    });
    expect(keysOf(wire).every((key) => /^[a-z][a-z0-9_]*$/.test(key))).toBe(true);
    expect(keysToCamel(wire)).toEqual(saleRecord);
  });

  it('brings back every key of the port records, whatever its depth', () => {
    const records = [
      saleRecord,
      zReport,
      {
        id: 'c9bf9e57-1685-4c89-bafb-ff5af830be8a',
        sessionId: zReport.sessionId,
        closingCountedMillimes: 61_000,
        clientZReport: zReport,
      },
      { terminalId: 't1', code: 'T1', lastSeq: 42, epoch: 1, openSession: { closedBy: null } },
      { lines: [{ ...saleRecord.lines[0], refundedQty: 1, refundedMillimes: 8_750 }] },
    ];
    const keys = new Set(records.flatMap((record) => keysOf(record)));

    for (const key of keys) {
      expect(snakeToCamel(camelToSnake(key)), key).toBe(key);
    }
    for (const record of records) {
      expect(keysToCamel(keysToSnake(record))).toEqual(record);
    }
  });
});
