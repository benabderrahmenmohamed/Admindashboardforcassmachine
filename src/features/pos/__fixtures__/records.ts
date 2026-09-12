/**
 * Outbox records and a registration for tests: the shapes the register reads off the queue, built
 * by hand so no backend, database or hashing is needed to make one.
 */
import type { OutboxError, OutboxMeta, OutboxResult, OutboxStatus } from '@/features/sync/types';
import { add, mm, ZERO } from '@/lib/money';
import type { PaymentMethod, SaleLine, ZReport } from '@/ports';
import type { NumberedRecord, SessionCloseRecord, SessionOpenRecord } from '../queue';

export const SESSION_ID = '11111111-1111-4111-8111-111111111111';
export const CASHIER_ID = '22222222-2222-4222-8222-222222222222';
export const AT = '2026-09-11T09:00:00.000Z';
const HASH = 'f'.repeat(64);

export function uuid(index: number): string {
  return `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
}

export function meta(overrides: Partial<OutboxMeta> = {}): OutboxMeta {
  return {
    terminalId: 'terminal-1',
    code: 'T1',
    epoch: 2,
    lastSeq: 41,
    nextOrdinal: 7,
    registeredAt: Date.parse(AT),
    ...overrides,
  };
}

export function saleLine(overrides: Partial<SaleLine> = {}): SaleLine {
  return {
    id: 'line-1',
    lineNo: 1,
    openOrderItemId: null,
    productId: 'p-express',
    productName: 'Café express',
    qty: 1,
    unitPriceMillimes: mm(1900),
    lineDiscountMillimes: ZERO,
    lineDiscountReason: null,
    allocatedDiscountMillimes: ZERO,
    netMillimes: mm(1900),
    refundsSaleLineId: null,
    ...overrides,
  };
}

interface Common {
  readonly id?: string;
  readonly ordinal?: number;
  readonly status?: OutboxStatus;
  readonly terminalCode?: string;
  readonly lastError?: OutboxError | null;
  readonly result?: OutboxResult | null;
}

function shell(common: Common, fallbackId: string) {
  const status = common.status ?? 'pending';
  return {
    id: common.id ?? fallbackId,
    ordinal: common.ordinal ?? 1,
    terminalCode: common.terminalCode ?? 'T1',
    payloadHash: HASH,
    createdAt: Date.parse(AT),
    attempts: 0,
    nextAttemptAt: Date.parse(AT),
    status,
    lastError: common.lastError ?? null,
    result: common.result ?? null,
    ackedAt: status === 'acked' ? Date.parse(AT) : null,
  };
}

export function saleRecord(
  input: Common & {
    readonly seq: number;
    readonly kind?: 'sale' | 'refund';
    readonly sessionId?: string;
    readonly method?: PaymentMethod;
    readonly lines?: readonly SaleLine[];
    readonly refundsSaleId?: string | null;
    readonly tableId?: string | null;
  },
): NumberedRecord {
  const base = shell(input, uuid(input.seq));
  const kind = input.kind ?? 'sale';
  const lines = input.lines ?? [saleLine()];
  const total = add(...lines.map((line) => line.netMillimes));
  return {
    ...base,
    kind,
    seq: input.seq,
    sessionId: input.sessionId ?? SESSION_ID,
    payload: {
      id: base.id,
      kind,
      terminalCode: base.terminalCode,
      epoch: 2,
      seq: input.seq,
      sessionId: input.sessionId ?? SESSION_ID,
      tableId: input.tableId ?? null,
      createdAt: AT,
      lines: [...lines],
      cartDiscountMillimes: ZERO,
      totalMillimes: total,
      payment: {
        method: input.method ?? 'cash',
        tenderedMillimes: total,
        changeMillimes: ZERO,
      },
      refundsSaleId: input.refundsSaleId ?? null,
      payloadHash: HASH,
    },
  };
}

/** A refund of `sale`, paying back `qty` units of its first line. */
export function refundRecord(
  sale: NumberedRecord,
  input: Common & { readonly seq: number; readonly qty?: number },
): NumberedRecord {
  const original = sale.payload.lines[0];
  const qty = input.qty ?? original.qty;
  const amount = mm(-Math.round((original.netMillimes * qty) / original.qty));
  return saleRecord({
    ...input,
    kind: 'refund',
    sessionId: sale.sessionId,
    refundsSaleId: sale.payload.id,
    lines: [
      saleLine({
        id: `line-refund-${input.seq}`,
        qty: -qty,
        unitPriceMillimes: original.unitPriceMillimes,
        netMillimes: amount,
        // The line it gives back, by the row id the device that sold it gave that line.
        refundsSaleLineId: original.id,
      }),
    ],
  });
}

export function openRecord(
  input: Common & { readonly sessionId?: string; readonly floatMillimes?: number } = {},
): SessionOpenRecord {
  const id = input.sessionId ?? SESSION_ID;
  const base = shell({ ...input, id }, id);
  return {
    ...base,
    kind: 'session_open',
    seq: null,
    sessionId: base.id,
    payload: {
      id: base.id,
      terminalCode: base.terminalCode,
      epoch: 2,
      actorUserId: CASHIER_ID,
      openedAt: AT,
      openingFloatMillimes: mm(input.floatMillimes ?? 50_000),
      payloadHash: HASH,
    },
  };
}

export function closeRecord(
  input: Common & {
    readonly sessionId?: string;
    readonly countedMillimes?: number;
    readonly clientZReport?: ZReport | null;
  } = {},
): SessionCloseRecord {
  const base = shell(input, uuid(900));
  const sessionId = input.sessionId ?? SESSION_ID;
  return {
    ...base,
    kind: 'session_close',
    seq: null,
    sessionId,
    payload: {
      id: base.id,
      sessionId,
      terminalCode: base.terminalCode,
      epoch: 2,
      actorUserId: CASHIER_ID,
      closedAt: AT,
      closingCountedMillimes: mm(input.countedMillimes ?? 60_000),
      clientZReport: input.clientZReport ?? null,
      payloadHash: HASH,
    },
  };
}
