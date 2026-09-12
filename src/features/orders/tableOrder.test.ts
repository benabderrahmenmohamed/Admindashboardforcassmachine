import { describe, expect, it } from 'vitest';
import { mm } from '@/lib/money';
import { roomItem, roomOrder } from './__fixtures__/room';
import { NO_LOCAL } from './overlay';
import {
  activeItems,
  canRemove,
  itemStage,
  itemTotal,
  orderTotals,
  tableOrderView,
} from './tableOrder';

const sent = { sentAt: '2026-09-12T10:05:00.000Z' };
const pending = 'pending' as const;

describe('itemStage', () => {
  it('reads the stamps in the order they can only happen', () => {
    expect(itemStage(roomItem({ id: 'a' }))).toBe('unsent');
    expect(itemStage(roomItem({ id: 'b', ...sent }))).toBe('sent');
    expect(itemStage(roomItem({ id: 'c', ...sent, preparedAt: '2026-09-12T10:09:00.000Z' }))).toBe(
      'prepared',
    );
    expect(itemStage(roomItem({ id: 'd', ...sent, paidSaleId: 'sale-1' }))).toBe('paid');
  });

  it('calls an item removed after it was sent removed, not sent', () => {
    const voided = roomItem({ id: 'e', ...sent, removedAt: '2026-09-12T10:12:00.000Z' });

    expect(itemStage(voided)).toBe('removed');
  });

  it('reads the server’s stamps only: a change still on this device does not move a row', () => {
    const marked = roomItem({
      id: 'f',
      local: {
        ...NO_LOCAL,
        sending: pending,
        removing: { sync: pending, reason: 'x', cause: 'remove' },
      },
    });

    expect(itemStage(marked)).toBe('unsent');
  });
});

describe('canRemove', () => {
  it('lets a waiter take off something the kitchen already has', () => {
    expect(canRemove(roomItem({ id: 'a', ...sent }))).toBe(true);
  });

  it('refuses an item a sale has already taken', () => {
    expect(canRemove(roomItem({ id: 'a', paidSaleId: 'sale-1' }))).toBe(false);
  });

  it('refuses an item a sale on this device is paying, which the server would refuse to take off', () => {
    expect(canRemove(roomItem({ id: 'a', local: { ...NO_LOCAL, paying: 'pending' } }))).toBe(false);
  });

  it('refuses an item that is already off the table', () => {
    expect(canRemove(roomItem({ id: 'a', removedAt: '2026-09-12T10:12:00.000Z' }))).toBe(false);
  });

  it('refuses an item this device is already taking off', () => {
    expect(
      canRemove(
        roomItem({
          id: 'a',
          local: { ...NO_LOCAL, removing: { sync: pending, reason: 'x', cause: 'remove' } },
        }),
      ),
    ).toBe(false);
  });

  it('lets a waiter take off an item only this device has, by the id its add gave it', () => {
    expect(
      canRemove(roomItem({ id: 'a', fromServer: false, local: { ...NO_LOCAL, added: pending } })),
    ).toBe(true);
  });
});

describe('itemTotal', () => {
  it('multiplies the price snapshotted when the item was added', () => {
    expect(itemTotal(roomItem({ id: 'a', qty: 3, unitPriceMillimes: mm(2_500) }))).toBe(mm(7_500));
  });
});

describe('orderTotals of a table paid on this device', () => {
  // The money is in this till: a table paid while offline no longer owes it on this device.
  it('owes nothing for the rows a queued sale pays, and still counts them on the table', () => {
    const totals = orderTotals([
      roomItem({ id: 'a', local: { ...NO_LOCAL, paying: 'pending' } }),
      roomItem({ id: 'b' }),
    ]);

    expect(totals).toMatchObject({ activeCount: 2, unpaidCount: 1, dueMillimes: mm(2_500) });
  });
});

describe('orderTotals', () => {
  it('counts a row this device added like any other, at the menu price', () => {
    const totals = orderTotals([
      roomItem({ id: 'a' }),
      roomItem({ id: 'b', fromServer: false, qty: 2, local: { ...NO_LOCAL, added: pending } }),
    ]);

    expect(totals).toEqual({
      activeCount: 2,
      unpaidCount: 2,
      toSendCount: 2,
      dueMillimes: mm(7_500),
      unpricedCount: 0,
    });
  });

  it('keeps a row this device is taking off owed, and leaves it out of what is still to send', () => {
    const totals = orderTotals([
      roomItem({
        id: 'a',
        local: { ...NO_LOCAL, removing: { sync: pending, reason: 'x', cause: 'remove' } },
      }),
    ]);

    expect(totals).toMatchObject({ activeCount: 1, toSendCount: 0, dueMillimes: mm(2_500) });
  });

  it('leaves a row a send on this device covers out of what is still to send', () => {
    expect(
      orderTotals([roomItem({ id: 'a', local: { ...NO_LOCAL, sending: pending } })]).toSendCount,
    ).toBe(0);
  });

  it('counts a row whose price this device does not know apart instead of guessing it', () => {
    const totals = orderTotals([
      roomItem({ id: 'a' }),
      roomItem({ id: 'b', fromServer: false, priceKnown: false, unitPriceMillimes: mm(0) }),
    ]);

    expect(totals).toMatchObject({ dueMillimes: mm(2_500), unpricedCount: 1, unpaidCount: 2 });
  });

  it('owes nothing for a paid row or a removed one', () => {
    const totals = orderTotals([
      roomItem({ id: 'a', ...sent, paidSaleId: 'sale-1' }),
      roomItem({ id: 'b', removedAt: '2026-09-12T10:12:00.000Z' }),
    ]);

    expect(totals).toEqual({
      activeCount: 1,
      unpaidCount: 0,
      toSendCount: 0,
      dueMillimes: mm(0),
      unpricedCount: 0,
    });
  });
});

describe('tableOrderView', () => {
  it('reads a free table as an empty order', () => {
    const view = tableOrderView(null);

    expect(view.isEmpty).toBe(true);
    expect(view.canSend).toBe(false);
    expect(view.dueMillimes).toBe(mm(0));
    expect(view.orderId).toBeNull();
    expect(view.changes).toEqual({ pending: 0, conflicts: 0 });
  });

  it('splits the table into what the kitchen has and what it does not', () => {
    const view = tableOrderView(
      roomOrder([
        roomItem({ id: 'a' }),
        roomItem({ id: 'b', ...sent }),
        roomItem({ id: 'c', qty: 2 }),
      ]),
    );

    expect(view.unsent.map((line) => line.id)).toEqual(['a', 'c']);
    expect(view.sent.map((line) => line.id)).toEqual(['b']);
    expect(view.canSend).toBe(true);
    expect(view.toSendCount).toBe(2);
  });

  it('counts a prepared item as one the kitchen has, not as one to send again', () => {
    const view = tableOrderView(
      roomOrder([roomItem({ id: 'a', ...sent, preparedAt: '2026-09-12T10:09:00.000Z' })]),
    );

    expect(view.sent.map((line) => line.id)).toEqual(['a']);
    expect(view.canSend).toBe(false);
  });

  it('owes what is active and unpaid, and nothing for what was removed or paid', () => {
    const view = tableOrderView(
      roomOrder([
        roomItem({ id: 'a', qty: 2 }),
        roomItem({ id: 'b', ...sent }),
        roomItem({ id: 'c', ...sent, removedAt: '2026-09-12T10:12:00.000Z' }),
        roomItem({ id: 'd', ...sent, paidSaleId: 'sale-1' }),
      ]),
    );

    expect(view.dueMillimes).toBe(mm(7_500));
    expect(view.unsentTotalMillimes).toBe(mm(5_000));
    expect(view.removed.map((line) => line.id)).toEqual(['c']);
    expect(view.paid.map((line) => line.id)).toEqual(['d']);
  });

  it('keeps a row being sent in the group it is in, with nothing left to send', () => {
    const view = tableOrderView(
      roomOrder([roomItem({ id: 'a', local: { ...NO_LOCAL, sending: pending } })]),
    );

    expect(view.unsent.map((line) => line.id)).toEqual(['a']);
    expect(view.canSend).toBe(false);
  });

  it('passes the table’s waiting changes and a waiting cancel through', () => {
    const view = tableOrderView(
      roomOrder([roomItem({ id: 'a' })], {
        changes: { pending: 2, conflicts: 1 },
        cancelling: { sync: pending, reason: 'The guests left' },
      }),
    );

    expect(view.changes).toEqual({ pending: 2, conflicts: 1 });
    expect(view.cancelling).toEqual({ sync: 'pending', reason: 'The guests left' });
  });

  it('is not empty once a row exists, even when every row is off the table', () => {
    const view = tableOrderView(
      roomOrder([roomItem({ id: 'a', removedAt: '2026-09-12T10:12:00.000Z' })]),
    );

    expect(view.isEmpty).toBe(false);
    expect(view.dueMillimes).toBe(mm(0));
  });
});

describe('activeItems', () => {
  it('keeps the order rows arrived in and drops the removed ones', () => {
    const items = activeItems(
      roomOrder([
        roomItem({ id: 'a' }),
        roomItem({ id: 'b', removedAt: '2026-09-12T10:12:00.000Z' }),
        roomItem({ id: 'c' }),
      ]),
    );

    expect(items.map((line) => line.id)).toEqual(['a', 'c']);
  });
});
