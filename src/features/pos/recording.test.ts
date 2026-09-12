import { describe, expect, it } from 'vitest';
import { ITEM_ID, storedOrder, TABLE_ID, uuid } from '@/features/sync/__tests__/fixtures';
import { ORDER_KINDS, type OrderKind, type OutboxError } from '@/features/sync/types';
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
  NO_NAMES,
  receiptOf,
  recordedMessage,
  recordErrorMessage,
  syncStatusMessage,
  terminalContext,
  voidQuestion,
  type RecordNames,
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
      remainingMillimes: 1900,
    });

    const message = recordErrorMessage(error, refund);

    expect(message).toContain('Café express');
    expect(message).toContain('1 unit');
    expect(message).toContain(formatTND(mm(1900)));
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
    expect(describeRecord(sale)).toBe(`Sale T1-42: ${formatTND(mm(1900))} paid by cash`);
    expect(recordedMessage(sale)).toBe('Sale T1-42 recorded');
  });

  it('shows a refund as money handed back', () => {
    const refund = refundRecord(sale, { seq: 43 });
    expect(describeRecord(refund)).toBe(`Refund T1-43: ${formatTND(mm(1900))} paid back by cash`);
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

/** What a waiter's phone that had the room open knows: the fixtures' table, product and item. */
const ROOM: RecordNames = {
  tables: new Map([[TABLE_ID, 'Terrasse 1']]),
  products: new Map([[uuid(90_005), 'Café moulu 250 g']]),
  items: new Map([[ITEM_ID, { name: 'Café express', qty: 2, tableId: TABLE_ID }]]),
};

describe('describeRecord for an order record', () => {
  it.each<[OrderKind, string]>([
    ['order_item_add', 'Adding 2 × Café moulu 250 g to Terrasse 1'],
    ['order_item_remove', 'Taking 2 × Café express off Terrasse 1: Guest changed their mind'],
    ['order_send', 'Sending Terrasse 1 to the kitchen'],
    ['order_item_prepare', 'Marking 2 × Café express for Terrasse 1 prepared'],
    ['order_cancel', 'Cancelling the order on Terrasse 1: The guests left'],
  ])('names %s by its table, product and quantity', async (kind, text) => {
    expect(describeRecord(await storedOrder(kind, 1), ROOM)).toBe(text);
  });

  it.each<[OrderKind, string]>([
    ['order_item_add', 'Adding 2 × an item to a table'],
    ['order_item_remove', 'Taking an item off a table: Guest changed their mind'],
    ['order_send', 'Sending a table to the kitchen'],
    ['order_item_prepare', 'Marking an item prepared'],
    ['order_cancel', 'Cancelling the order on a table: The guests left'],
  ])('still says what %s does on a device that has no names cached', async (kind, text) => {
    expect(describeRecord(await storedOrder(kind, 1), NO_NAMES)).toBe(text);
  });

  it('keeps the note, and names the item by its snapshot once the product left the menu', async () => {
    const add = await storedOrder('order_item_add', 1);
    if (add.kind !== 'order_item_add') {
      throw new AppError('VALIDATION_ERROR', `Expected an add, got ${add.kind}`);
    }
    const noted = { ...add, payload: { ...add.payload, note: 'sans sucre' } };
    const archived: RecordNames = {
      ...ROOM,
      products: new Map(),
      items: new Map([[add.id, { name: 'Café du jour', qty: 2, tableId: TABLE_ID }]]),
    };

    expect(describeRecord(noted, archived)).toBe(
      'Adding 2 × Café du jour (sans sucre) to Terrasse 1',
    );
  });

  it('names what it can when only part of the room is cached', async () => {
    const removal = await storedOrder('order_item_remove', 1);
    const tablesOnly: RecordNames = { ...NO_NAMES, tables: ROOM.tables };
    const itemOnly: RecordNames = {
      ...NO_NAMES,
      items: new Map([[ITEM_ID, { name: 'Café express', qty: 1, tableId: null }]]),
    };

    expect(describeRecord(removal, tablesOnly)).toBe(
      'Taking an item off a table: Guest changed their mind',
    );
    expect(describeRecord(removal, itemOnly)).toBe(
      'Taking 1 × Café express off a table: Guest changed their mind',
    );
    expect(describeRecord(await storedOrder('order_item_prepare', 2), itemOnly)).toBe(
      'Marking 1 × Café express prepared',
    );
  });
});

describe('recordErrorMessage for an order record', () => {
  const TABLE_CODES = [
    'ORDER_CHANGED',
    'ORDER_CLOSED',
    'ITEM_NOT_FOUND',
    'TABLE_INACTIVE',
  ] as const;

  it('decides every table code by the code and the kind, never by the text', async () => {
    for (const kind of ORDER_KINDS) {
      const record = await storedOrder(kind, 1);
      for (const code of TABLE_CODES) {
        const message = recordErrorMessage(failure(code), record);
        expect(recordErrorMessage(new AppError(code, 'something else entirely'), record)).toBe(
          message,
        );
        // Every order record the table overtook can be discarded, so the message says what to do.
        expect(message).toMatch(/discard/i);
        expect(message).not.toContain('payment');
      }
    }
  });

  it('keeps the payment wording for a sale', () => {
    expect(recordErrorMessage(failure('ORDER_CHANGED'), sale)).toContain('take the payment afresh');
    expect(recordErrorMessage(failure('ORDER_CLOSED'), sale)).toContain(
      'nothing left on it to pay',
    );
    expect(recordErrorMessage(failure('ITEM_NOT_FOUND'), null)).toContain('pays for');
  });

  it('tells a waiter what happened to the table, for what the server raises', async () => {
    const message = async (kind: OrderKind, code: ErrorCode) =>
      recordErrorMessage(failure(code), await storedOrder(kind, 1));

    expect(await message('order_item_add', 'TABLE_INACTIVE')).toContain(
      'Put the item on the table the guests are at',
    );
    expect(await message('order_send', 'ORDER_CLOSED')).toContain('tell the kitchen yourself');
    expect(await message('order_item_remove', 'ORDER_CHANGED')).toContain(
      'ask the caisse to refund it',
    );
    expect(await message('order_item_remove', 'ORDER_CLOSED')).toContain('nothing to take off');
    expect(await message('order_item_remove', 'ITEM_NOT_FOUND')).toContain('nothing to take off');
    expect(await message('order_item_prepare', 'ORDER_CHANGED')).toContain(
      'nothing to mark prepared',
    );
    expect(await message('order_item_prepare', 'ITEM_NOT_FOUND')).toContain('nothing to prepare');
    expect(await message('order_cancel', 'ORDER_CHANGED')).toContain('Take the unpaid items off');
    expect(await message('order_cancel', 'ORDER_CLOSED')).toContain('nothing left to cancel');
  });
});
