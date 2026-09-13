import { describe, expect, it } from 'vitest';
import { isAppError } from '@/lib/errors';
import { canonicalJson, payloadHash } from '@/lib/payloadHash';
import {
  buildOrderCancelRecord,
  buildOrderItemAddRecord,
  buildOrderItemPrepareRecord,
  buildOrderItemRemoveRecord,
  buildOrderSendRecord,
  type OrderEnvelope,
} from './records';

const envelope: OrderEnvelope = {
  id: '11111111-1111-4111-8111-111111111111',
  actorUserId: 'waiter-1',
  deviceId: 'device-a',
  createdAt: '2026-09-12T10:00:00.000Z',
};

const add = { tableId: 'table-1', productId: 'product-1', qty: 2, note: 'sans sucre' };

async function codeOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    return isAppError(error) ? error.code : 'not an AppError';
  }
  return 'no error';
}

describe('buildOrderItemAddRecord', () => {
  it('hashes the payload so a replay of the same add is recognised', async () => {
    const record = await buildOrderItemAddRecord(envelope, add);

    const { payloadHash: hash, ...rest } = record;
    expect(hash).toBe(await payloadHash(rest));
    expect(record.qty).toBe(2);
  });

  it('gives two devices adding the same thing different records', async () => {
    const one = await buildOrderItemAddRecord(envelope, add);
    const two = await buildOrderItemAddRecord(
      { ...envelope, id: '22222222-2222-4222-8222-222222222222', deviceId: 'device-b' },
      add,
    );

    expect(one.payloadHash).not.toBe(two.payloadHash);
  });

  it('trims the note, so the same order typed with a stray space hashes the same', async () => {
    const record = await buildOrderItemAddRecord(envelope, { ...add, note: '  sans sucre  ' });
    const plain = await buildOrderItemAddRecord(envelope, add);

    expect(record.note).toBe('sans sucre');
    expect(record.payloadHash).toBe(plain.payloadHash);
  });

  it('keeps an empty note rather than dropping the key, so the hash is stable', async () => {
    const record = await buildOrderItemAddRecord(envelope, { ...add, note: '' });

    expect(record.note).toBe('');
    expect(canonicalJson(record)).toContain('"note":""');
  });

  it('refuses less than one unit', async () => {
    expect(await codeOf(() => buildOrderItemAddRecord(envelope, { ...add, qty: 0 }))).toBe(
      'VALIDATION_ERROR',
    );
  });

  it('refuses a record id that is not a uuid', async () => {
    expect(await codeOf(() => buildOrderItemAddRecord({ ...envelope, id: 'add-1' }, add))).toBe(
      'VALIDATION_ERROR',
    );
  });
});

describe('buildOrderItemRemoveRecord', () => {
  it('carries the reason the report of removed items is made of', async () => {
    const record = await buildOrderItemRemoveRecord(envelope, {
      itemId: 'item-1',
      reason: 'guest changed their mind',
    });

    expect(record.reason).toBe('guest changed their mind');
  });

  it('names who took it off, under the hash, so whoever sends it later cannot change whose it is', async () => {
    const removal = { itemId: 'item-1', reason: 'guest changed their mind' };
    const mine = await buildOrderItemRemoveRecord(envelope, removal);
    const theirs = await buildOrderItemRemoveRecord(
      { ...envelope, actorUserId: 'waiter-2' },
      removal,
    );

    expect(mine.actorUserId).toBe('waiter-1');
    const { payloadHash: hash, ...rest } = mine;
    expect(hash).toBe(await payloadHash(rest));
    expect(theirs.payloadHash).not.toBe(mine.payloadHash);
  });

  it('refuses a removal that names nobody as its author', async () => {
    expect(
      await codeOf(() =>
        buildOrderItemRemoveRecord(
          { ...envelope, actorUserId: '' },
          { itemId: 'item-1', reason: 'guest changed their mind' },
        ),
      ),
    ).toBe('VALIDATION_ERROR');
  });

  it('refuses a removal with no reason', async () => {
    expect(
      await codeOf(() => buildOrderItemRemoveRecord(envelope, { itemId: 'item-1', reason: '   ' })),
    ).toBe('VALIDATION_ERROR');
  });
});

describe('buildOrderSendRecord', () => {
  it('names the table, because the server stamps every unsent item on it', async () => {
    const record = await buildOrderSendRecord(envelope, { tableId: 'table-1' });

    expect(record.tableId).toBe('table-1');
    expect(record.payloadHash).toHaveLength(64);
  });
});

describe('buildOrderItemPrepareRecord', () => {
  it('names one item', async () => {
    const record = await buildOrderItemPrepareRecord(envelope, { itemId: 'item-1' });

    expect(record.itemId).toBe('item-1');
  });
});

describe('buildOrderCancelRecord', () => {
  it('refuses a cancellation with no reason', async () => {
    expect(
      await codeOf(() => buildOrderCancelRecord(envelope, { tableId: 'table-1', reason: '' })),
    ).toBe('VALIDATION_ERROR');
  });

  it('keeps the reason on a cancellation', async () => {
    const record = await buildOrderCancelRecord(envelope, {
      tableId: 'table-1',
      reason: 'guests left',
    });

    expect(record.reason).toBe('guests left');
  });
});
