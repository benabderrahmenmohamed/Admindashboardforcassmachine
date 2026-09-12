import { describe, expect, it } from 'vitest';
import { keysToSnake } from '@/lib/caseConversion';
import { AppError } from '@/lib/errors';
import { mm } from '@/lib/money';
import { payloadHash } from '@/lib/payloadHash';
import { closeSessionRecordSchema, openSessionRecordSchema } from '@/ports';
import { buildCloseSessionRecord, buildOpenSessionRecord } from './records';
import { computeZReport } from './zReport';

// Black-box tests of the session records a terminal writes: the fields it sends, the hash of
// exactly those fields, and the keys open_session and close_session read from the payload.

const SESSION_ID = 'a3b1c2d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
const CASHIER_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const CLOSE_ID = 'c9bf9e57-1685-4c89-bafb-ff5af830be8a';

/** The same fields as the open-session vector in src/lib/payloadHash.test.ts. */
const OPEN_HASH = 'ba8d211d41c6559c460680954985fe82d6323e4e0e97b3e4b6d3004e26184a2c';

const openInput = {
  id: SESSION_ID,
  terminal: { terminalCode: 'T1', epoch: 2 },
  actorUserId: CASHIER_ID,
  openedAt: '2026-09-11T08:00:00.000Z',
  openingFloatMillimes: mm(50_000),
};

const clientZReport = computeZReport({
  sessionId: SESSION_ID,
  openingFloatMillimes: mm(50_000),
  documents: [
    { kind: 'sale', paymentMethod: 'cash', totalMillimes: mm(12_500) },
    { kind: 'refund', paymentMethod: 'cash', totalMillimes: mm(-1_250) },
  ],
  voidsCount: 0,
  countedCashMillimes: mm(61_000),
});

const closeInput = {
  id: CLOSE_ID,
  sessionId: SESSION_ID,
  terminal: { terminalCode: 'T1', epoch: 2 },
  actorUserId: CASHIER_ID,
  closedAt: '2026-09-11T18:30:00.000Z',
  closingCountedMillimes: mm(61_000),
  clientZReport,
};

/** The close record's fields, without the hash. */
const closeFields = {
  id: CLOSE_ID,
  sessionId: SESSION_ID,
  terminalCode: 'T1',
  epoch: 2,
  actorUserId: CASHIER_ID,
  closedAt: '2026-09-11T18:30:00.000Z',
  closingCountedMillimes: 61_000,
  clientZReport,
};

describe('buildOpenSessionRecord', () => {
  it('copies the fields and adds the hash of exactly those fields', async () => {
    const record = await buildOpenSessionRecord(openInput);

    expect(record).toEqual({
      id: SESSION_ID,
      terminalCode: 'T1',
      epoch: 2,
      actorUserId: CASHIER_ID,
      openedAt: '2026-09-11T08:00:00.000Z',
      openingFloatMillimes: 50_000,
      payloadHash: OPEN_HASH,
    });
    expect(await payloadHash(record)).toBe(record.payloadHash);
    expect(openSessionRecordSchema.parse(record)).toEqual(record);
  });

  it('sends exactly the keys open_session reads', async () => {
    const wire = keysToSnake(await buildOpenSessionRecord(openInput)) as object;

    expect(Object.keys(wire).sort()).toEqual([
      'actor_user_id',
      'epoch',
      'id',
      'opened_at',
      'opening_float_millimes',
      'payload_hash',
      'terminal_code',
    ]);
  });

  it('gives the same hash for the same input and a new one when the registration changes', async () => {
    const first = await buildOpenSessionRecord(openInput);
    const again = await buildOpenSessionRecord({
      ...openInput,
      terminal: { ...openInput.terminal },
    });
    const newEpoch = await buildOpenSessionRecord({
      ...openInput,
      terminal: { terminalCode: 'T1', epoch: 3 },
    });
    const newFloat = await buildOpenSessionRecord({
      ...openInput,
      openingFloatMillimes: mm(50_001),
    });

    expect(again.payloadHash).toBe(first.payloadHash);
    expect(newEpoch.payloadHash).not.toBe(first.payloadHash);
    expect(newFloat.payloadHash).not.toBe(first.payloadHash);
  });

  it('accepts a float of zero', async () => {
    const record = await buildOpenSessionRecord({ ...openInput, openingFloatMillimes: mm(0) });

    expect(record.openingFloatMillimes).toBe(0);
  });

  it('refuses a negative float', async () => {
    await expect(
      buildOpenSessionRecord({ ...openInput, openingFloatMillimes: mm(-1) }),
    ).rejects.toThrow();
  });

  it('refuses a negative float with VALIDATION_ERROR', async () => {
    const error = await buildOpenSessionRecord({ ...openInput, openingFloatMillimes: mm(-1) }).then(
      () => undefined,
      (reason: unknown) => reason,
    );

    expect(error).toBeInstanceOf(AppError);
    expect(error).toHaveProperty('code', 'VALIDATION_ERROR');
  });
});

describe('buildCloseSessionRecord', () => {
  it('copies the fields, keeps the local Z-report and adds the hash of exactly those fields', async () => {
    const record = await buildCloseSessionRecord(closeInput);

    expect(record).toEqual({ ...closeFields, payloadHash: await payloadHash(closeFields) });
    expect(record.clientZReport).toEqual(clientZReport);
    expect(closeSessionRecordSchema.parse(record)).toEqual(record);
  });

  it('hashes a missing local report as null, not as a left-out property', async () => {
    const record = await buildCloseSessionRecord({ ...closeInput, clientZReport: null });
    const withoutReport: Record<string, unknown> = { ...closeFields };
    delete withoutReport.clientZReport;

    expect(record.clientZReport).toBeNull();
    expect(record.payloadHash).toBe(await payloadHash({ ...closeFields, clientZReport: null }));
    expect(record.payloadHash).not.toBe(await payloadHash(withoutReport));
  });

  it('sends exactly the keys close_session reads, with the local report in snake_case', async () => {
    const wire = keysToSnake(await buildCloseSessionRecord(closeInput)) as object;

    expect(Object.keys(wire).sort()).toEqual([
      'actor_user_id',
      'client_z_report',
      'closed_at',
      'closing_counted_millimes',
      'epoch',
      'id',
      'payload_hash',
      'session_id',
      'terminal_code',
    ]);
    expect(wire).toMatchObject({
      client_z_report: {
        session_id: SESSION_ID,
        by_method: { cash: { sales_millimes: 12_500, refunds_millimes: 1_250 } },
        expected_cash_millimes: 61_250,
        variance_millimes: -250,
      },
    });
  });

  it('gives a new hash for another count, another report or another close request', async () => {
    const first = await buildCloseSessionRecord(closeInput);
    const hashes = await Promise.all(
      [
        { ...closeInput, closingCountedMillimes: mm(61_001) },
        { ...closeInput, clientZReport: { ...clientZReport, voidsCount: 1 } },
        { ...closeInput, id: '0b4a3c6e-8d2f-4f1a-9c3b-5e7d9a1b2c3d' },
      ].map(async (input) => (await buildCloseSessionRecord(input)).payloadHash),
    );

    expect(new Set([first.payloadHash, ...hashes]).size).toBe(4);
    expect((await buildCloseSessionRecord(closeInput)).payloadHash).toBe(first.payloadHash);
  });

  it('accepts a count of zero', async () => {
    const record = await buildCloseSessionRecord({ ...closeInput, closingCountedMillimes: mm(0) });

    expect(record.closingCountedMillimes).toBe(0);
  });

  it('refuses negative counted cash', async () => {
    await expect(
      buildCloseSessionRecord({ ...closeInput, closingCountedMillimes: mm(-1) }),
    ).rejects.toThrow();
  });

  it('refuses negative counted cash with VALIDATION_ERROR', async () => {
    const error = await buildCloseSessionRecord({
      ...closeInput,
      closingCountedMillimes: mm(-1),
    }).then(
      () => undefined,
      (reason: unknown) => reason,
    );

    expect(error).toBeInstanceOf(AppError);
    expect(error).toHaveProperty('code', 'VALIDATION_ERROR');
  });
});
