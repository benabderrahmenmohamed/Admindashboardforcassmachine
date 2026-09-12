import { describe, expect, it } from 'vitest';
import { mm } from '@/lib/money';
import type { SaleRecord } from '@/ports';
import type { PendingRecord, StoredTerminal } from '../terminalStore';
import {
  describePendingRecord,
  registerBlockedReason,
  registerConfirmMessage,
  registerTerminalFormSchema,
  registrationSummary,
} from './registration';

const HASH = 'a'.repeat(64);

const terminal: StoredTerminal = {
  terminalId: 'terminal-1',
  code: 'T1',
  epoch: 3,
  lastSeq: 42,
  registeredAt: '2026-09-11T08:00:00.000Z',
};

const sale: SaleRecord = {
  id: '6f1c2a7e-2f7b-4b7a-9c61-0d7e3b1f5a10',
  kind: 'sale',
  terminalCode: 'T1',
  epoch: 3,
  seq: 43,
  sessionId: 'session-1',
  createdAt: '2026-09-11T09:00:00.000Z',
  lines: [
    {
      lineNo: 1,
      productId: 'prod-lait',
      productName: 'Lait demi-écrémé 1 L',
      qty: 1,
      unitPriceMillimes: mm(1_350),
      lineDiscountMillimes: mm(0),
      cartDiscountShareMillimes: mm(0),
      lineTotalMillimes: mm(1_350),
      refundsLineNo: null,
    },
  ],
  subtotalMillimes: mm(1_350),
  discountMillimes: mm(0),
  totalMillimes: mm(1_350),
  payment: { method: 'cash', tenderedMillimes: mm(2_000), changeMillimes: mm(650) },
  refundsSaleId: null,
  payloadHash: HASH,
};

const pendingSale: PendingRecord = { type: 'sale', record: sale };

const pendingOpen: PendingRecord = {
  type: 'session_open',
  record: {
    id: '0b0f4b53-8f3e-4d8e-8d4a-3c2b1a0f9e8d',
    terminalCode: 'T1',
    epoch: 3,
    actorUserId: 'user-cashier',
    openedAt: '2026-09-11T08:30:00.000Z',
    openingFloatMillimes: mm(50_000),
    payloadHash: HASH,
  },
};

const pendingClose: PendingRecord = {
  type: 'session_close',
  record: {
    id: '5d9e7c1b-3a2f-4e6d-9b8c-7a6f5e4d3c2b',
    sessionId: 'session-1',
    terminalCode: 'T1',
    epoch: 3,
    actorUserId: 'user-cashier',
    closedAt: '2026-09-11T18:00:00.000Z',
    closingCountedMillimes: mm(51_350),
    clientZReport: null,
    payloadHash: HASH,
  },
};

describe('registerTerminalFormSchema', () => {
  it.each([
    { typed: 'T1', code: 'T1' },
    { typed: ' t1 ', code: 'T1' },
    { typed: 'pos02', code: 'POS02' },
    { typed: '12345678', code: '12345678' },
  ])('reads $typed as $code', ({ typed, code }) => {
    expect(registerTerminalFormSchema.parse({ code: typed })).toEqual({ code });
  });

  it.each(['', '   ', 'T-1', 'T 1', 'ABCDEFGHI', 'TÉ'])('rejects %j', (typed) => {
    const result = registerTerminalFormSchema.safeParse({ code: typed });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.message)).toEqual([
      'Use 1 to 8 letters or digits',
    ]);
  });
});

describe('registrationSummary', () => {
  it('is null for a device that is not registered', () => {
    expect(registrationSummary(null)).toBeNull();
  });

  it('lists the code, the epoch and the last receipt number', () => {
    expect(registrationSummary(terminal)).toEqual({ code: 'T1', epoch: 3, lastReceipt: 'T1-42' });
  });

  it('has no last receipt before the terminal numbers its first one', () => {
    expect(registrationSummary({ ...terminal, lastSeq: 0 })?.lastReceipt).toBeNull();
  });
});

describe('describePendingRecord', () => {
  it.each([
    { name: 'a sale', pending: pendingSale, text: 'sale T1-43' },
    {
      name: 'a refund',
      pending: {
        type: 'sale',
        record: { ...sale, kind: 'refund', seq: 44, terminalCode: 'POS2' },
      } satisfies PendingRecord,
      text: 'refund POS2-44',
    },
    { name: 'a session opening', pending: pendingOpen, text: 'session opening' },
    { name: 'a session close', pending: pendingClose, text: 'session close' },
  ])('names $name', ({ pending, text }) => {
    expect(describePendingRecord(pending)).toBe(text);
  });
});

describe('registerBlockedReason', () => {
  it('lets a device without an unsent record register', () => {
    expect(registerBlockedReason(null)).toBeNull();
  });

  it('refuses while a record waits to be sent, and says which one and why', () => {
    expect(registerBlockedReason(pendingSale)).toBe(
      'This device has an unsent sale T1-43. Registering now would strand it under the old ' +
        'registration: a cashier has to send it from the POS on this device first.',
    );
    expect(registerBlockedReason(pendingClose)).toContain('unsent session close');
  });
});

describe('registerConfirmMessage', () => {
  const replaced =
    'Any other device registered as T1 will have to be registered again before it can record sales.';

  it('asks before a first registration', () => {
    expect(registerConfirmMessage('T1', null)).toBe(
      `Register this device as terminal T1? ${replaced}`,
    );
  });

  it('asks the same before registering the same code again', () => {
    expect(registerConfirmMessage('T1', terminal)).toBe(
      `Register this device as terminal T1? ${replaced}`,
    );
  });

  it('names the current code when the device changes terminal', () => {
    expect(registerConfirmMessage('T2', terminal)).toBe(
      'This device is terminal T1. Register it as T2 instead? Any other device registered as T2 ' +
        'will have to be registered again before it can record sales.',
    );
  });
});
