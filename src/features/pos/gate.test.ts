import { describe, expect, it } from 'vitest';
import { AppError } from '@/lib/errors';
import { mm } from '@/lib/money';
import type { CashSession } from '@/ports';
import { closeRecord, meta, openRecord, saleRecord, SESSION_ID } from './__fixtures__/records';
import { posGate, type PosGateInput } from './gate';

const terminal = meta();

const session: CashSession = {
  id: SESSION_ID,
  terminalId: 'terminal-1',
  terminalCode: 'T1',
  openedBy: 'cashier-1',
  openedAt: '2026-09-11T08:05:00.000Z',
  openingFloatMillimes: mm(50_000),
  closedAt: null,
  closedBy: null,
  closingCountedMillimes: null,
  forceCloseReason: null,
  zReport: null,
};

function input(overrides: Partial<PosGateInput> = {}): PosGateInput {
  return {
    secureContext: true,
    terminal,
    lock: 'held',
    records: [],
    session,
    sessionError: null,
    ...overrides,
  };
}

describe('posGate', () => {
  it('sells when the terminal has an open session and this tab holds it', () => {
    expect(posGate(input())).toEqual({ kind: 'open', terminal, session, isLocal: false });
  });

  it('refuses a page that is not served securely, before anything else', () => {
    expect(posGate(input({ secureContext: false, terminal: null, lock: 'taken' }))).toEqual({
      kind: 'insecure',
    });
  });

  it('waits while this device is being read, then asks for a registration', () => {
    expect(posGate(input({ terminal: undefined }))).toEqual({ kind: 'loading' });
    expect(posGate(input({ terminal: null, lock: 'taken' }))).toEqual({ kind: 'unregistered' });
  });

  it('refuses to sell without the terminal lock, and says which case it is', () => {
    expect(posGate(input({ lock: 'pending' }))).toEqual({ kind: 'loading' });
    expect(posGate(input({ lock: 'taken' }))).toEqual({ kind: 'locked', reason: 'taken' });
    expect(posGate(input({ lock: 'unavailable' }))).toEqual({
      kind: 'locked',
      reason: 'unavailable',
    });
  });

  it('keeps selling while records are only waiting to be sent', () => {
    const records = [
      saleRecord({ seq: 42, ordinal: 1, status: 'pending' }),
      saleRecord({ seq: 43, ordinal: 2, status: 'sending' }),
    ];
    expect(posGate(input({ records }))).toMatchObject({ kind: 'open' });
  });

  it('stops at a record the server refused, before the session is even looked at', () => {
    const blocked = saleRecord({ seq: 42, ordinal: 1, status: 'conflict' });
    const records = [blocked, saleRecord({ seq: 43, ordinal: 2 })];

    expect(posGate(input({ records }))).toEqual({ kind: 'blocked', record: blocked });
    expect(posGate(input({ records, session: undefined }))).toEqual({
      kind: 'blocked',
      record: blocked,
    });
  });

  it('sells in a session this device opened, with no answer from the server at all', () => {
    const records = [openRecord({ ordinal: 1 })];
    const offline = posGate(
      input({ records, session: undefined, sessionError: new AppError('NETWORK_ERROR', 'off') }),
    );

    expect(offline).toMatchObject({ kind: 'open', isLocal: true });
    expect(offline).toHaveProperty('session.id', SESSION_ID);
  });

  it('is closed once this device writes the close, whatever the server still says', () => {
    const records = [openRecord({ ordinal: 1, status: 'acked' }), closeRecord({ ordinal: 2 })];
    expect(posGate(input({ records }))).toEqual({ kind: 'closed', terminal });
  });

  it('waits for the session, and reports one that could not be read', () => {
    expect(posGate(input({ session: undefined }))).toEqual({ kind: 'loading' });
    const error = new AppError('NETWORK_ERROR', 'offline');
    expect(posGate(input({ session: undefined, sessionError: error }))).toEqual({
      kind: 'error',
      error,
    });
  });

  it('keeps the last session on screen while it is read again', () => {
    const error = new AppError('SERVER_ERROR', 'boom');
    expect(posGate(input({ sessionError: error }))).toMatchObject({ kind: 'open' });
  });

  it('asks for a session when the terminal has none open', () => {
    expect(posGate(input({ session: null }))).toEqual({ kind: 'closed', terminal });
    const closed: CashSession = {
      ...session,
      closedAt: '2026-09-11T18:00:00.000Z',
      closedBy: 'cashier-1',
      closingCountedMillimes: mm(60_000),
    };
    expect(posGate(input({ session: closed }))).toEqual({ kind: 'closed', terminal });
  });

  it('adopts the open session of a terminal this device was just registered as', () => {
    expect(posGate(input({ records: [] }))).toMatchObject({ kind: 'open', isLocal: false });
  });
});
