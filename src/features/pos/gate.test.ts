import { describe, expect, it } from 'vitest';
import type { PendingRecord, StoredTerminal } from '@/features/terminal/terminalStore';
import { AppError } from '@/lib/errors';
import { mm } from '@/lib/money';
import type { CashSession } from '@/ports';
import { posGate, type PosGateInput } from './gate';

const terminal: StoredTerminal = {
  terminalId: 'terminal-1',
  code: 'T1',
  epoch: 2,
  lastSeq: 41,
  registeredAt: '2026-09-11T08:00:00.000Z',
};

const session: CashSession = {
  id: 'session-1',
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

const pending: PendingRecord = {
  type: 'session_open',
  record: {
    id: '00000000-0000-4000-8000-000000000001',
    terminalCode: 'T1',
    epoch: 2,
    actorUserId: 'cashier-1',
    openedAt: '2026-09-11T08:05:00.000Z',
    openingFloatMillimes: mm(50_000),
    payloadHash: 'a'.repeat(64),
  },
};

function input(overrides: Partial<PosGateInput> = {}): PosGateInput {
  return {
    terminal,
    pending: null,
    firstSendId: null,
    session,
    sessionError: null,
    ...overrides,
  };
}

describe('posGate', () => {
  it('sells when the terminal has an open session', () => {
    expect(posGate(input())).toEqual({ kind: 'open', terminal, session });
  });

  it('blocks a device that is not registered as a terminal', () => {
    expect(posGate(input({ terminal: null }))).toEqual({ kind: 'unregistered' });
    expect(posGate(input({ terminal: null, session: undefined }))).toEqual({
      kind: 'unregistered',
    });
  });

  it('offers an unsent record before the registration and the session', () => {
    expect(posGate(input({ pending }))).toEqual({ kind: 'pending', pending });
    expect(posGate(input({ pending, session: null }))).toEqual({ kind: 'pending', pending });
    expect(posGate(input({ pending, terminal: null, session: undefined }))).toEqual({
      kind: 'pending',
      pending,
    });
  });

  it('keeps the writing screen up while a new record is on its first send', () => {
    expect(posGate(input({ pending, firstSendId: pending.record.id }))).toEqual({
      kind: 'open',
      terminal,
      session,
    });
    expect(
      posGate(input({ pending, firstSendId: pending.record.id, session: null })),
    ).toMatchObject({ kind: 'closed' });
  });

  it('shows the unsent record once its first send is over, or when another record is sending', () => {
    expect(posGate(input({ pending, firstSendId: null }))).toMatchObject({ kind: 'pending' });
    expect(
      posGate(input({ pending, firstSendId: '00000000-0000-4000-8000-000000000009' })),
    ).toMatchObject({ kind: 'pending' });
  });

  it('waits for the session, and reports a session that could not be read', () => {
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
});
