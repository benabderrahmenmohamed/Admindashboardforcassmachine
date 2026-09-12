import { describe, expect, it } from 'vitest';
import type { OutboxError } from '@/features/sync/types';
import { AppError, ERROR_CODES, type ErrorCode } from '@/lib/errors';
import { formatTND, mm } from '@/lib/money';
import {
  closeRecord,
  meta,
  openRecord,
  refundRecord,
  saleLine,
  saleRecord,
} from './__fixtures__/records';
import {
  canVoid,
  describeRecord,
  isRefusal,
  receiptOf,
  recordedMessage,
  recordErrorMessage,
  syncStatusMessage,
  terminalContext,
  voidQuestion,
} from './recording';

function failure(code: ErrorCode, details?: Record<string, unknown>): OutboxError {
  return new AppError(code, `${code} happened`, { details });
}

const sale = saleRecord({ seq: 42 });

describe('terminalContext and receiptOf', () => {
  it("writes a record under this device's registration, with the number it was allocated", () => {
    expect(terminalContext(meta({ code: 'POS2', epoch: 5 }))).toEqual({
      terminalCode: 'POS2',
      epoch: 5,
    });
    expect(receiptOf(sale)).toBe('T1-42');
  });
});

describe('recordErrorMessage', () => {
  it('has a message for every code, decided by the code and not the message text', () => {
    for (const code of ERROR_CODES) {
      const first = recordErrorMessage(failure(code), null);
      expect(first.length).toBeGreaterThan(0);
      if (code !== 'VALIDATION_ERROR' && code !== 'CONFIG_ERROR' && code !== 'UNKNOWN') {
        expect(recordErrorMessage(new AppError(code, 'other text'), null)).toBe(first);
      }
    }
  });

  it('tells a superseded device that it must be registered again', () => {
    const error = failure('TERMINAL_SUPERSEDED', { terminalCode: 'T1', currentEpoch: 3 });
    expect(recordErrorMessage(error, sale)).toMatch(/Terminal T1 .*registered again/);
  });

  it('names the receipt number the server expects, and whether registering again helps', () => {
    const behind = failure('SEQUENCE_GAP', { expectedSeq: 44, receivedSeq: 42 });
    // A device ahead of the server, as after the demo backend was reset.
    const ahead = failure('SEQUENCE_GAP', { expectedSeq: 1, receivedSeq: 42 });

    expect(recordErrorMessage(behind, sale)).toContain('T1-44');
    expect(recordErrorMessage(behind, sale)).toContain('register this device again');
    expect(recordErrorMessage(ahead, sale)).toContain('T1-1');
    expect(recordErrorMessage(ahead, sale)).not.toContain('Ask an admin to register');
  });

  it('takes the number the record holds when the server does not name it', () => {
    const error = failure('SEQUENCE_GAP', { expectedSeq: 44 });
    expect(recordErrorMessage(error, sale)).toContain('behind the server');
  });

  it('says what is left of a refunded line, by product name', () => {
    const refund = refundRecord(sale, { seq: 43 });
    const error = failure('VALIDATION_ERROR', {
      lineNo: 1,
      remainingQty: 1,
      remainingMillimes: 1350,
    });

    const message = recordErrorMessage(error, refund);

    expect(message).toContain('Harissa Cap Bon 380 g');
    expect(message).toContain('1 unit');
    expect(message).toContain(formatTND(mm(1350)));
  });

  it('picks the reason a FORBIDDEN or NOT_FOUND names', () => {
    expect(recordErrorMessage(failure('FORBIDDEN', { terminalCode: 'T9' }), sale)).toContain('T9');
    expect(recordErrorMessage(failure('FORBIDDEN', { sessionId: 's' }), sale)).toContain(
      'another terminal',
    );
    expect(recordErrorMessage(failure('NOT_FOUND', { productId: 'p' }), sale)).toContain('product');
    expect(recordErrorMessage(failure('NOT_FOUND', { saleId: 's' }), sale)).toContain('refunded');
  });
});

describe('canVoid', () => {
  it('offers a void only for a numbered record the server refused', () => {
    const refused = ERROR_CODES.filter((code) =>
      canVoid(saleRecord({ seq: 42, status: 'conflict', lastError: failure(code) })),
    );

    expect(refused).toEqual(ERROR_CODES.filter(isRefusal));
    expect(refused).toContain('SEQUENCE_GAP');
    expect(refused).not.toContain('NETWORK_ERROR');
  });

  it('does not offer one for a session record, or before the server has answered', () => {
    const error = failure('SESSION_ALREADY_OPEN');
    expect(canVoid(openRecord({ status: 'conflict', lastError: error }))).toBe(false);
    expect(
      canVoid(saleRecord({ seq: 42, status: 'pending', lastError: failure('NETWORK_ERROR') })),
    ).toBe(false);
    expect(canVoid(saleRecord({ seq: 42, status: 'conflict' }))).toBe(false);
  });
});

describe('describeRecord and recordedMessage', () => {
  it('names a sale by its receipt, its amount and how it was paid', () => {
    expect(describeRecord(sale)).toBe(`Sale T1-42: ${formatTND(mm(1350))} paid by cash`);
    expect(recordedMessage(sale)).toBe('Sale T1-42 recorded');
  });

  it('shows a refund as money handed back', () => {
    const refund = refundRecord(sale, { seq: 43 });
    expect(describeRecord(refund)).toBe(`Refund T1-43: ${formatTND(mm(1350))} paid back by cash`);
    expect(recordedMessage(refund)).toBe('Refund T1-43 recorded');
  });

  it('names a card sale by its method', () => {
    const card = saleRecord({ seq: 44, method: 'card', lines: [saleLine({ qty: 2 })] });
    expect(describeRecord(card)).toContain('paid by card');
  });

  it('describes opening and closing a session without a receipt number', () => {
    expect(describeRecord(openRecord())).toContain(formatTND(mm(50_000)));
    expect(describeRecord(openRecord())).not.toContain('T1-');
    expect(describeRecord(closeRecord())).toContain(formatTND(mm(60_000)));
    expect(recordedMessage(openRecord())).toBe('Session opened');
    expect(recordedMessage(closeRecord())).toBe('Session closed');
  });
});

describe('syncStatusMessage', () => {
  it('says where a record stands, with the error when there is one', () => {
    expect(syncStatusMessage(saleRecord({ seq: 42, status: 'acked' }))).toContain('server has');
    expect(syncStatusMessage(saleRecord({ seq: 42, status: 'pending' }))).toContain(
      'Kept on this device',
    );
    expect(
      syncStatusMessage(
        saleRecord({ seq: 42, status: 'pending', lastError: failure('NETWORK_ERROR') }),
      ),
    ).toContain('could not be reached');
    expect(
      syncStatusMessage(
        saleRecord({ seq: 42, status: 'conflict', lastError: failure('SESSION_CLOSED') }),
      ),
    ).toContain('session was closed');
    expect(syncStatusMessage(saleRecord({ seq: 42, status: 'voided' }))).toContain('voided');
  });
});

describe('voidQuestion', () => {
  it('names the receipt that is being given up on', () => {
    expect(voidQuestion(sale)).toContain('T1-42');
  });
});
