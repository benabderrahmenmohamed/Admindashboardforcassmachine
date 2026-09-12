import { describe, expect, it } from 'vitest';
import { mm } from '@/lib/money';
import type { OpenOrder, OpenOrderItem } from '@/ports';
import { activeItems, canRemove, itemStage, itemTotal, tableOrderView } from './tableOrder';

function item(overrides: Partial<OpenOrderItem> & { id: string }): OpenOrderItem {
  return {
    orderId: 'order-1',
    productId: 'product-1',
    nameSnapshot: 'Express',
    unitPriceMillimes: mm(2_500),
    qty: 1,
    note: '',
    addedBy: 'waiter-1',
    addedAt: '2026-09-12T10:00:00.000Z',
    sentAt: null,
    preparedAt: null,
    removedAt: null,
    removedBy: null,
    removedReason: null,
    paidSaleId: null,
    ...overrides,
  };
}

function order(...items: OpenOrderItem[]): OpenOrder {
  return {
    id: 'order-1',
    tableId: 'table-1',
    status: 'open',
    openedAt: '2026-09-12T10:00:00.000Z',
    closedAt: null,
    items,
  };
}

const sent = { sentAt: '2026-09-12T10:05:00.000Z' };

describe('itemStage', () => {
  it('reads the stamps in the order they can only happen', () => {
    expect(itemStage(item({ id: 'a' }))).toBe('unsent');
    expect(itemStage(item({ id: 'b', ...sent }))).toBe('sent');
    expect(itemStage(item({ id: 'c', ...sent, preparedAt: '2026-09-12T10:09:00.000Z' }))).toBe(
      'prepared',
    );
    expect(itemStage(item({ id: 'd', ...sent, paidSaleId: 'sale-1' }))).toBe('paid');
  });

  it('calls an item removed after it was sent removed, not sent', () => {
    const voided = item({ id: 'e', ...sent, removedAt: '2026-09-12T10:12:00.000Z' });

    expect(itemStage(voided)).toBe('removed');
  });
});

describe('canRemove', () => {
  it('lets a waiter take off something the kitchen already has', () => {
    expect(canRemove(item({ id: 'a', ...sent }))).toBe(true);
  });

  it('refuses an item a sale has already taken', () => {
    expect(canRemove(item({ id: 'a', paidSaleId: 'sale-1' }))).toBe(false);
  });

  it('refuses an item that is already off the table', () => {
    expect(canRemove(item({ id: 'a', removedAt: '2026-09-12T10:12:00.000Z' }))).toBe(false);
  });
});

describe('itemTotal', () => {
  it('multiplies the price snapshotted when the item was added', () => {
    expect(itemTotal(item({ id: 'a', qty: 3, unitPriceMillimes: mm(2_500) }))).toBe(mm(7_500));
  });
});

describe('tableOrderView', () => {
  it('reads a free table as an empty order', () => {
    const view = tableOrderView(null);

    expect(view.isEmpty).toBe(true);
    expect(view.canSend).toBe(false);
    expect(view.dueMillimes).toBe(mm(0));
    expect(view.orderId).toBeNull();
  });

  it('splits the table into what the kitchen has and what it does not', () => {
    const view = tableOrderView(
      order(item({ id: 'a' }), item({ id: 'b', ...sent }), item({ id: 'c', qty: 2 })),
    );

    expect(view.unsent.map((line) => line.id)).toEqual(['a', 'c']);
    expect(view.sent.map((line) => line.id)).toEqual(['b']);
    expect(view.canSend).toBe(true);
  });

  it('counts a prepared item as one the kitchen has, not as one to send again', () => {
    const view = tableOrderView(
      order(item({ id: 'a', ...sent, preparedAt: '2026-09-12T10:09:00.000Z' })),
    );

    expect(view.sent.map((line) => line.id)).toEqual(['a']);
    expect(view.canSend).toBe(false);
  });

  it('owes what is active and unpaid, and nothing for what was removed or paid', () => {
    const view = tableOrderView(
      order(
        item({ id: 'a', qty: 2 }),
        item({ id: 'b', ...sent }),
        item({ id: 'c', ...sent, removedAt: '2026-09-12T10:12:00.000Z' }),
        item({ id: 'd', ...sent, paidSaleId: 'sale-1' }),
      ),
    );

    expect(view.dueMillimes).toBe(mm(7_500));
    expect(view.unsentTotalMillimes).toBe(mm(5_000));
    expect(view.removed.map((line) => line.id)).toEqual(['c']);
    expect(view.paid.map((line) => line.id)).toEqual(['d']);
  });

  it('is not empty once a row exists, even when every row is off the table', () => {
    const view = tableOrderView(order(item({ id: 'a', removedAt: '2026-09-12T10:12:00.000Z' })));

    expect(view.isEmpty).toBe(false);
    expect(view.dueMillimes).toBe(mm(0));
  });
});

describe('activeItems', () => {
  it('keeps the order rows arrived in and drops the removed ones', () => {
    const items = activeItems(
      order(
        item({ id: 'a' }),
        item({ id: 'b', removedAt: '2026-09-12T10:12:00.000Z' }),
        item({ id: 'c' }),
      ),
    );

    expect(items.map((line) => line.id)).toEqual(['a', 'c']);
  });
});
