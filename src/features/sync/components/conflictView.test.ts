import { describe, expect, it } from 'vitest';
import type { RecordNames } from '@/features/pos/recording';
import { formatTND, mm, ZERO } from '@/lib/money';
import type { CloseSessionRecord, OpenSessionRecord, SaleRecord } from '@/ports';
import { storedOrder, TABLE_ID } from '../__tests__/fixtures';
import type { OutboxError, OutboxRecord, OutboxStatus } from '../types';
import {
  conflictRows,
  deadLetterHeadline,
  deadLetterRows,
  discardedByLabel,
  type Viewer,
} from './conflictView';

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
    discard: null,
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

const CLOSED: OutboxError = { code: 'ORDER_CLOSED', message: 'This table has no open order.' };

/** A waiter's phone that had the room open: the fixtures' table has a name. */
const ROOM: RecordNames = {
  tables: new Map([[TABLE_ID, 'Terrasse 1']]),
  products: new Map(),
  items: new Map(),
};

const WAITER: Viewer = { id: 'user-waiter', name: 'Demo Waiter' };

describe('what a person may do with the record the queue stopped at', () => {
  it('offers the discard for an order record, and only for the one the queue stopped at', async () => {
    const rows = conflictRows(
      [
        await storedOrder('order_send', 1, { status: 'conflict', lastError: CLOSED }),
        await storedOrder('order_item_add', 2),
      ],
      ROOM,
    );

    expect(rows.map((row) => [row.kindLabel, row.discardable, row.whyNoDiscard])).toEqual([
      ['Sent to the kitchen', true, null],
      ['Item added', false, null],
    ]);
    expect(rows[0]).toMatchObject({
      summary: 'Sending Terrasse 1 to the kitchen',
      sessionId: null,
      receipt: null,
      voidable: null,
      errorCode: 'ORDER_CLOSED',
    });
    expect(rows[0].message).toContain('the kitchen was never told');
  });

  it.each([
    ['sale', () => saleRecord(1, 42, 'conflict', GAP), 'A sale cannot be discarded'],
    ['refund', () => saleRecord(1, 42, 'conflict', GAP, 'refund'), 'A refund cannot be discarded'],
    ['session close', () => closeRecord(1, 'conflict', GAP), 'A session close cannot be discarded'],
  ] as const)(
    'never offers the discard for a %s, and says why in one sentence',
    (_, record, why) => {
      const [row] = conflictRows([record()]);

      expect(row.discardable).toBe(false);
      expect(row.whyNoDiscard).toMatch(new RegExp(`^${why}: [^.]+\\.$`));
    },
  );

  it('has nothing to explain on a ledger record that is only waiting its turn', () => {
    const rows = conflictRows([saleRecord(1, 42, 'conflict', GAP), saleRecord(2, 43, 'pending')]);

    expect(rows[1]).toMatchObject({ discardable: false, whyNoDiscard: null });
  });
});

describe('deadLetterRows', () => {
  it('lists what was discarded, why, by whom, when, and what the server refused it with', async () => {
    const rows = deadLetterRows(
      [
        await storedOrder('order_item_add', 1, { status: 'acked' }),
        await storedOrder('order_send', 2, {
          status: 'discarded',
          lastError: CLOSED,
          discard: {
            reason: 'The caisse closed the table first',
            discardedBy: WAITER.id,
            discardedByName: WAITER.name,
            discardedAt: WRITTEN_AT + 5_000,
          },
        }),
        await storedOrder('order_item_add', 3, { status: 'conflict', lastError: CLOSED }),
      ],
      WAITER,
      ROOM,
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kindLabel: 'Sent to the kitchen',
      summary: 'Sending Terrasse 1 to the kitchen',
      reason: 'The caisse closed the table first',
      discardedBy: 'Demo Waiter (you)',
      discardedAt: WRITTEN_AT + 5_000,
      errorCode: 'ORDER_CLOSED',
    });
  });

  it('puts the latest discard first', async () => {
    const discardedAt = (at: number) => ({
      status: 'discarded' as const,
      lastError: CLOSED,
      discard: {
        reason: `At ${at}`,
        discardedBy: WAITER.id,
        discardedByName: null,
        discardedAt: at,
      },
    });
    const rows = deadLetterRows(
      [
        await storedOrder('order_send', 1, discardedAt(100)),
        await storedOrder('order_send', 2, discardedAt(300)),
        await storedOrder('order_send', 3, discardedAt(200)),
      ],
      WAITER,
    );

    expect(rows.map((row) => row.reason)).toEqual(['At 300', 'At 200', 'At 100']);
    // Without names cached, the record is still described in plain words.
    expect(rows[0].summary).toBe('Sending a table to the kitchen');
  });
});

describe('discardedByLabel', () => {
  const OTHER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2';
  const by = (discardedBy: string | null, discardedByName: string | null) => ({
    discardedBy,
    discardedByName,
  });

  // The phone an admin reads the list on has no staff list: the name stored with the discard is the
  // only way to say who someone else was.
  it('names whoever discarded it by the name kept with the discard', () => {
    expect(discardedByLabel(by(OTHER, 'Sonia'), WAITER)).toBe('Sonia');
    expect(discardedByLabel(by(WAITER.id, 'Demo Waiter'), WAITER)).toBe('Demo Waiter (you)');
  });

  it('falls back to the reader, or the start of the account id, when no name was kept', () => {
    expect(discardedByLabel(by(WAITER.id, null), WAITER)).toBe('Demo Waiter (you)');
    expect(discardedByLabel(by(WAITER.id, null), { id: WAITER.id, name: '' })).toBe('You');
    expect(discardedByLabel(by(OTHER, null), WAITER)).toBe('Another account (aaaaaaaa)');
    expect(discardedByLabel(by(OTHER, ''), WAITER)).toBe('Another account (aaaaaaaa)');
    expect(discardedByLabel(by(null, null), WAITER)).toBe('Nobody signed in');
  });
});

describe('deadLetterHeadline', () => {
  it('counts the list for the admin', () => {
    expect(deadLetterHeadline(1)).toBe('1 order record was discarded on this device');
    expect(deadLetterHeadline(3)).toBe('3 order records were discarded on this device');
  });
});
