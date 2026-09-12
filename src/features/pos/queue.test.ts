import { describe, expect, it } from 'vitest';
import { mm } from '@/lib/money';
import {
  closeRecord,
  meta,
  openRecord,
  saleRecord,
  SESSION_ID,
  uuid,
} from './__fixtures__/records';
import {
  closedHere,
  findRecord,
  isNumbered,
  isSessionClose,
  isUnfinished,
  localSession,
  openedHere,
  queueState,
  sessionDocuments,
  syncStatus,
  waitingBehind,
} from './queue';

const terminal = meta();

describe('syncStatus', () => {
  it('maps every status a record can be in', () => {
    expect(syncStatus(saleRecord({ seq: 1, status: 'pending' }))).toBe('pending');
    expect(syncStatus(saleRecord({ seq: 1, status: 'sending' }))).toBe('pending');
    expect(syncStatus(saleRecord({ seq: 1, status: 'acked' }))).toBe('synced');
    expect(syncStatus(saleRecord({ seq: 1, status: 'conflict' }))).toBe('conflict');
    expect(syncStatus(saleRecord({ seq: 1, status: 'voided' }))).toBe('voided');
  });

  it('tells which records still have somewhere to go', () => {
    const unfinished = (['pending', 'sending', 'conflict', 'acked', 'voided'] as const).filter(
      (status) => isUnfinished(saleRecord({ seq: 1, status })),
    );
    expect(unfinished).toEqual(['pending', 'sending', 'conflict']);
  });
});

describe('queueState', () => {
  it('counts what is waiting and stops at the earliest record in conflict', () => {
    const records = [
      saleRecord({ seq: 41, ordinal: 1, status: 'acked' }),
      saleRecord({ seq: 42, ordinal: 2, status: 'conflict' }),
      saleRecord({ seq: 43, ordinal: 3, status: 'pending' }),
      saleRecord({ seq: 44, ordinal: 4, status: 'sending' }),
    ];

    expect(queueState(records)).toEqual({
      pending: 2,
      conflicts: 1,
      blocked: records[1],
    });
    expect(waitingBehind(records, records[1])).toEqual([records[2], records[3]]);
  });

  it('is idle when every record has been taken', () => {
    const records = [saleRecord({ seq: 41, ordinal: 1, status: 'acked' })];
    expect(queueState(records)).toEqual({ pending: 0, conflicts: 0, blocked: null });
  });
});

describe('localSession', () => {
  it('is the session this device opened and has not closed', () => {
    const records = [openRecord({ ordinal: 1 }), saleRecord({ seq: 42, ordinal: 2 })];

    expect(localSession(terminal, records)).toEqual({
      id: SESSION_ID,
      terminalId: 'terminal-1',
      terminalCode: 'T1',
      openedBy: '22222222-2222-4222-8222-222222222222',
      openedAt: '2026-09-11T09:00:00.000Z',
      openingFloatMillimes: mm(50_000),
      closedAt: null,
      closedBy: null,
      closingCountedMillimes: null,
      forceCloseReason: null,
      zReport: null,
    });
  });

  it('stays open while the record that opened it is only queued', () => {
    for (const status of ['pending', 'sending', 'acked'] as const) {
      expect(localSession(terminal, [openRecord({ ordinal: 1, status })])).not.toBeNull();
    }
  });

  it('is over as soon as the close is written, long before the server takes it', () => {
    const records = [openRecord({ ordinal: 1, status: 'acked' }), closeRecord({ ordinal: 2 })];

    expect(localSession(terminal, records)).toBeNull();
    expect(closedHere(records, SESSION_ID)).toBe(true);
    expect(openedHere(records, SESSION_ID)).toBe(true);
  });

  it('moves on to the session opened after the last one was closed', () => {
    const next = uuid(77);
    const records = [
      openRecord({ ordinal: 1, status: 'acked' }),
      closeRecord({ ordinal: 2, status: 'acked' }),
      openRecord({ ordinal: 3, sessionId: next }),
    ];

    expect(localSession(terminal, records)?.id).toBe(next);
    expect(closedHere(records, next)).toBe(false);
  });

  it('ignores a voided record and one written under another terminal code', () => {
    expect(localSession(terminal, [openRecord({ ordinal: 1, status: 'voided' })])).toBeNull();
    expect(localSession(terminal, [openRecord({ ordinal: 1, terminalCode: 'T2' })])).toBeNull();
    expect(closedHere([closeRecord({ status: 'voided' })], SESSION_ID)).toBe(false);
    expect(openedHere([openRecord({ status: 'voided' })], SESSION_ID)).toBe(false);
  });

  it('has no session of its own on a device that has written nothing', () => {
    expect(localSession(terminal, [])).toBeNull();
    expect(openedHere([], SESSION_ID)).toBe(false);
  });
});

describe('sessionDocuments', () => {
  it('counts what this device wrote in the session, sent or not', () => {
    const other = uuid(99);
    const records = [
      openRecord({ ordinal: 1, status: 'acked' }),
      saleRecord({ seq: 42, ordinal: 2, status: 'acked', method: 'card' }),
      saleRecord({ seq: 43, ordinal: 3, status: 'pending' }),
      saleRecord({ seq: 44, ordinal: 4, sessionId: other }),
      closeRecord({ ordinal: 5 }),
    ];

    expect(sessionDocuments(records, SESSION_ID)).toEqual([
      { kind: 'sale', paymentMethod: 'card', totalMillimes: mm(1350) },
      { kind: 'sale', paymentMethod: 'cash', totalMillimes: mm(1350) },
    ]);
  });

  it('leaves out records the server refused and records an admin voided', () => {
    const records = [
      saleRecord({ seq: 42, ordinal: 1, status: 'conflict' }),
      saleRecord({ seq: 43, ordinal: 2, status: 'voided' }),
    ];

    expect(sessionDocuments(records, SESSION_ID)).toEqual([]);
  });
});

describe('finding records', () => {
  it('tells the kinds apart and looks one up by id', () => {
    const sale = saleRecord({ seq: 42, ordinal: 1 });
    const close = closeRecord({ ordinal: 2 });
    const records = [sale, close];

    expect(isNumbered(sale)).toBe(true);
    expect(isNumbered(close)).toBe(false);
    expect(isSessionClose(close)).toBe(true);
    expect(isSessionClose(sale)).toBe(false);
    expect(findRecord(records, close.id)).toBe(close);
    expect(findRecord(records, null)).toBeNull();
    expect(findRecord(records, 'no-such-record')).toBeNull();
  });
});
