import { describe, expect, it } from 'vitest';
import { formatTND, mm, ZERO } from '@/lib/money';
import type { CloseSessionRecord, OpenSessionRecord, SaleRecord } from '@/ports';
import type { OutboxError, OutboxRecord, OutboxStatus } from '../types';
import { conflictRows } from './conflictView';

const HASH = 'b'.repeat(64);
const AT = '2026-09-12T09:00:00.000Z';
const WRITTEN_AT = 1_700_000_000_000;
const SESSION = 'session-1';

function sale(seq: number, kind: 'sale' | 'refund' = 'sale'): SaleRecord {
  return {
    id: `${kind}-${seq}`,
    kind,
    terminalCode: 'T1',
    epoch: 2,
    seq,
    sessionId: SESSION,
    createdAt: AT,
    tableId: null,
    lines: [
      {
        id: 'line-1',
        lineNo: 1,
        openOrderItemId: null,
        productId: 'p-harissa',
        productName: 'Harissa Cap Bon 380 g',
        qty: kind === 'refund' ? -1 : 1,
        unitPriceMillimes: mm(1350),
        lineDiscountMillimes: ZERO,
        lineDiscountReason: null,
        allocatedDiscountMillimes: ZERO,
        netMillimes: kind === 'refund' ? mm(-1350) : mm(1350),
        refundsSaleLineId: kind === 'refund' ? 'the-line-it-gives-back' : null,
      },
    ],
    cartDiscountMillimes: ZERO,
    totalMillimes: kind === 'refund' ? mm(-1350) : mm(1350),
    payment: {
      method: 'cash',
      tenderedMillimes: kind === 'refund' ? mm(-1350) : mm(1350),
      changeMillimes: ZERO,
    },
    refundsSaleId: kind === 'refund' ? 'sale-41' : null,
    payloadHash: HASH,
  };
}

function base(ordinal: number, status: OutboxStatus, lastError: OutboxError | null) {
  return {
    ordinal,
    terminalCode: 'T1',
    sessionId: SESSION,
    payloadHash: HASH,
    createdAt: WRITTEN_AT,
    attempts: status === 'conflict' ? 1 : 0,
    nextAttemptAt: WRITTEN_AT,
    status,
    lastError,
    result: null,
    ackedAt: status === 'acked' ? WRITTEN_AT : null,
  };
}

function saleRecord(
  ordinal: number,
  seq: number,
  status: OutboxStatus,
  lastError: OutboxError | null = null,
  kind: 'sale' | 'refund' = 'sale',
): OutboxRecord {
  const payload = sale(seq, kind);
  return { ...base(ordinal, status, lastError), id: payload.id, kind, seq, payload };
}

function openRecord(ordinal: number, status: OutboxStatus): OutboxRecord {
  const payload: OpenSessionRecord = {
    id: SESSION,
    terminalCode: 'T1',
    epoch: 2,
    actorUserId: 'user-1',
    openedAt: AT,
    openingFloatMillimes: mm(50_000),
    payloadHash: HASH,
  };
  return {
    ...base(ordinal, status, null),
    id: payload.id,
    kind: 'session_open',
    seq: null,
    payload,
  };
}

function closeRecord(
  ordinal: number,
  status: OutboxStatus,
  lastError: OutboxError | null = null,
): OutboxRecord {
  const payload: CloseSessionRecord = {
    id: 'close-1',
    sessionId: SESSION,
    terminalCode: 'T1',
    epoch: 2,
    actorUserId: 'user-1',
    closedAt: AT,
    closingCountedMillimes: mm(61_350),
    clientZReport: null,
    payloadHash: HASH,
  };
  return {
    ...base(ordinal, status, lastError),
    id: payload.id,
    kind: 'session_close',
    seq: null,
    payload,
  };
}

const GAP: OutboxError = {
  code: 'SEQUENCE_GAP',
  message: 'Expected receipt T1-40.',
  details: { expectedSeq: 40, receivedSeq: 42 },
};

describe('conflictRows', () => {
  it('has nothing to show while no record is in conflict', () => {
    expect(conflictRows([openRecord(1, 'acked'), saleRecord(2, 42, 'pending')])).toEqual([]);
  });

  it('lists the record the queue stopped at and everything written after it', () => {
    const rows = conflictRows([
      openRecord(1, 'acked'),
      saleRecord(2, 42, 'conflict', GAP),
      saleRecord(3, 43, 'pending'),
      closeRecord(4, 'pending'),
    ]);

    expect(rows.map((row) => [row.id, row.status])).toEqual([
      ['sale-42', 'conflict'],
      ['sale-43', 'waiting'],
      ['close-1', 'waiting'],
    ]);
    expect(rows[0]).toMatchObject({
      kindLabel: 'Sale',
      receipt: 'T1-42',
      sessionId: SESSION,
      writtenAt: WRITTEN_AT,
      errorCode: 'SEQUENCE_GAP',
      attempts: 1,
    });
    expect(rows[0].summary).toBe(`Sale T1-42: ${formatTND(mm(1350))} paid by cash`);
    expect(rows[2].summary).toContain('Closing the session on terminal T1');
    expect(rows[0].statusLabel).toBe('Needs attention');
    // The records behind it were never refused: they are simply waiting their turn.
    expect(rows[1].statusLabel).toBe('Waiting to send');
    expect(rows[1].message).toBe('Kept on this device until the server takes it.');
    expect(rows[2].receipt).toBeNull();
  });

  it('leaves out what the server already took, however it ended', () => {
    const rows = conflictRows([
      saleRecord(1, 41, 'voided'),
      saleRecord(2, 42, 'conflict', GAP),
      saleRecord(3, 43, 'acked'),
      saleRecord(4, 44, 'sending'),
    ]);

    expect(rows.map((row) => row.id)).toEqual(['sale-42', 'sale-44']);
  });

  it('offers the void only on a numbered record that was refused', () => {
    const rows = conflictRows([
      saleRecord(1, 42, 'conflict', GAP),
      closeRecord(2, 'pending'),
      saleRecord(3, 43, 'pending'),
    ]);

    expect(rows[0].voidable).toMatchObject({ seq: 42, kind: 'sale' });
    expect(rows[1].voidable).toBeNull();
    expect(rows[2].voidable).toBeNull();
  });

  it('offers no void where the server may be holding the record after all', () => {
    const lost: OutboxError = { code: 'UNKNOWN', message: 'Something went wrong.' };
    const rows = conflictRows([saleRecord(1, 42, 'conflict', lost)]);

    expect(rows[0].voidable).toBeNull();
  });

  it('describes a refund as the register describes it', () => {
    const rows = conflictRows([saleRecord(1, 44, 'conflict', GAP, 'refund')]);

    expect(rows[0].kindLabel).toBe('Refund');
    expect(rows[0].summary).toBe(`Refund T1-44: ${formatTND(mm(1350))} paid back by cash`);
  });
});

describe('the reason a conflict row carries', () => {
  it('says what the code means, not what the server wrote', () => {
    const [row] = conflictRows([saleRecord(1, 42, 'conflict', GAP)]);

    expect(row.errorCode).toBe('SEQUENCE_GAP');
    expect(row.message).toContain('receipt T1-40');
    expect(row.message).not.toBe(GAP.message);
  });

  it('names the terminal a newer registration replaced', () => {
    const superseded: OutboxError = {
      code: 'TERMINAL_SUPERSEDED',
      message: 'Registered again elsewhere.',
      details: { terminalCode: 'T1', currentEpoch: 3 },
    };
    const [row] = conflictRows([closeRecord(1, 'conflict', superseded)]);

    expect(row.message).toContain('Terminal T1 was registered again');
  });
});
