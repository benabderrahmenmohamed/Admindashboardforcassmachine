import { describe, expect, it } from 'vitest';
import { roomItem, roomOrder } from '@/features/orders/__fixtures__/room';
import { NO_LOCAL, type RoomItem, type RoomOrder } from '@/features/orders/overlay';
import { mm } from '@/lib/money';
import { offerLine, setCartDiscount, totals } from './cart';
import {
  buildPaymentCart,
  cartForSelection,
  heldItems,
  holdReason,
  noSelection,
  paymentPlan,
  payableItems,
  pruneSelection,
  readDiscountPercent,
  selectAll,
  selectedItems,
  toggleItem,
  type LineDiscount,
} from './payment';

function item(overrides: Partial<RoomItem> & { id: string }): RoomItem {
  return roomItem({ sentAt: '2026-09-12T10:05:00.000Z', ...overrides });
}

function order(...items: RoomItem[]): RoomOrder {
  return roomOrder(items);
}

/** A row only this device has: its add has not reached the server. */
const addedHere = { fromServer: false, local: { ...NO_LOCAL, added: 'pending' as const } };

function takenOffHere(cause: 'remove' | 'cancel'): Partial<RoomItem> {
  return { local: { ...NO_LOCAL, removing: { sync: 'pending', reason: 'Gone', cause } } };
}

describe('payableItems', () => {
  it('offers what is on the table, sent or not', () => {
    const items = payableItems(order(item({ id: 'a', sentAt: null }), item({ id: 'b' })));

    expect(items.map((line) => line.id)).toEqual(['a', 'b']);
  });

  it('leaves out what a sale already took and what was taken off the table', () => {
    const items = payableItems(
      order(
        item({ id: 'a' }),
        item({ id: 'b', paidSaleId: 'sale-1' }),
        item({ id: 'c', removedAt: '2026-09-12T10:12:00.000Z' }),
      ),
    );

    expect(items.map((line) => line.id)).toEqual(['a']);
  });

  it('offers nothing on a free table', () => {
    expect(payableItems(null)).toEqual([]);
  });

  it('never offers a row the server does not have, or one this device is taking off', () => {
    const items = payableItems(
      order(
        item({ id: 'a' }),
        item({ id: 'b', ...addedHere }),
        // Acked, but not read back: the name and price are the menu's, not the server's snapshot.
        item({ id: 'c', fromServer: false }),
        item({ id: 'd', ...takenOffHere('remove') }),
        item({ id: 'e', ...takenOffHere('cancel') }),
      ),
    );

    expect(items.map((line) => line.id)).toEqual(['a']);
  });

  it('offers a row a send or a prepare on this device is waiting on: neither changes what a sale checks', () => {
    const items = payableItems(
      order(
        item({ id: 'a', sentAt: null, local: { ...NO_LOCAL, sending: 'pending' } }),
        item({ id: 'b', local: { ...NO_LOCAL, preparing: 'conflict' } }),
      ),
    );

    expect(items.map((line) => line.id)).toEqual(['a', 'b']);
  });
});

describe('heldItems and holdReason', () => {
  it('lists the owed rows that cannot be paid yet, each with why', () => {
    const table = order(
      item({ id: 'a' }),
      item({ id: 'b', ...addedHere }),
      item({ id: 'c', ...takenOffHere('remove') }),
      item({ id: 'd', ...takenOffHere('cancel') }),
      item({ id: 'e', ...addedHere, removedAt: '2026-09-12T10:12:00.000Z' }),
      // Paid on this device while offline: the same guest is not asked for the money twice.
      item({ id: 'f', local: { ...NO_LOCAL, paying: 'pending' } }),
    );

    expect(heldItems(table).map((line) => [line.id, holdReason(line)])).toEqual([
      ['b', 'not-on-server'],
      ['c', 'coming-off'],
      ['d', 'cancelling'],
      ['f', 'paying'],
    ]);
    expect(payableItems(table).map((line) => line.id)).toEqual(['a']);
    expect(holdReason(item({ id: 'a' }))).toBeNull();
  });

  it('holds nothing on a free table', () => {
    expect(heldItems(null)).toEqual([]);
  });
});

describe('choosing rows', () => {
  it('ticks and unticks one row at a time', () => {
    const once = toggleItem(noSelection, 'a');
    expect([...once]).toEqual(['a']);
    expect([...toggleItem(once, 'a')]).toEqual([]);
  });

  it('never changes the selection it is given', () => {
    const before = selectAll([item({ id: 'a' })]);

    toggleItem(before, 'b');

    expect([...before]).toEqual(['a']);
  });

  it('keeps the rows in the order they are on the table, not the order they were ticked', () => {
    const items = [item({ id: 'a' }), item({ id: 'b' }), item({ id: 'c' })];
    const selection = toggleItem(toggleItem(noSelection, 'c'), 'a');

    expect(selectedItems(items, selection).map((line) => line.id)).toEqual(['a', 'c']);
  });

  it('drops a ticked row that somebody else has paid or removed meanwhile', () => {
    const before = selectAll([item({ id: 'a' }), item({ id: 'b' })]);

    const after = pruneSelection(payableItems(order(item({ id: 'a' }))), before);

    expect([...after]).toEqual(['a']);
  });
});

describe('cartForSelection', () => {
  it('makes one line per row, at the price the row was ordered at', () => {
    const items = [
      item({ id: 'a', unitPriceMillimes: mm(2_500) }),
      item({ id: 'b', unitPriceMillimes: mm(3_000), qty: 2 }),
    ];

    const cart = cartForSelection(items, selectAll(items));

    expect(cart.lines.map((line) => [line.orderItemId, line.qty, line.unitPriceMillimes])).toEqual([
      ['a', 1, 2_500],
      ['b', 2, 3_000],
    ]);
    expect(totals(cart).totalMillimes).toBe(8_500);
  });

  it('keeps a later price change off a row that was ordered earlier', () => {
    const items = [item({ id: 'a', unitPriceMillimes: mm(2_500) })];

    expect(cartForSelection(items, selectAll(items)).lines[0].unitPriceMillimes).toBe(2_500);
  });

  it('is empty when nothing is ticked', () => {
    expect(cartForSelection([item({ id: 'a' })], noSelection).lines).toEqual([]);
  });
});

describe('readDiscountPercent', () => {
  it('reads whole percentages', () => {
    expect(readDiscountPercent('10')).toEqual({ ok: true, basisPoints: 1_000 });
  });

  it('reads two decimals with either separator', () => {
    expect(readDiscountPercent('7,5')).toEqual({ ok: true, basisPoints: 750 });
    expect(readDiscountPercent('7.55')).toEqual({ ok: true, basisPoints: 755 });
    expect(readDiscountPercent(',5')).toEqual({ ok: true, basisPoints: 50 });
  });

  it('reads an empty box as no discount, so clearing it is not an error', () => {
    expect(readDiscountPercent('')).toEqual({ ok: true, basisPoints: 0 });
    expect(readDiscountPercent('   ')).toEqual({ ok: true, basisPoints: 0 });
  });

  it('takes 100 % and refuses more', () => {
    expect(readDiscountPercent('100')).toEqual({ ok: true, basisPoints: 10_000 });
    expect(readDiscountPercent('100.01').ok).toBe(false);
    expect(readDiscountPercent('101').ok).toBe(false);
  });

  it('refuses anything that is not a percentage', () => {
    for (const text of ['abc', '-5', '1.234', '1e2', '5 %']) {
      expect(readDiscountPercent(text).ok, text).toBe(false);
    }
  });
});

describe('buildPaymentCart', () => {
  const items = [
    item({ id: 'a', unitPriceMillimes: mm(2_500) }),
    item({ id: 'b', unitPriceMillimes: mm(3_000) }),
  ];
  const offered = new Map<string, LineDiscount>([
    ['a', { millimes: mm(2_500), reason: 'erreur cuisine' }],
  ]);

  it('puts the discounts and the cart discount on the ticked rows', () => {
    const cart = buildPaymentCart(items, selectAll(items), offered, 1_000);

    expect(cart.lines[0]).toMatchObject({
      lineDiscountMillimes: 2_500,
      lineDiscountReason: 'erreur cuisine',
    });
    expect(cart.discountBasisPoints).toBe(1_000);
    // 10 % of the remaining 3,000.
    expect(totals(cart).totalMillimes).toBe(2_700);
  });

  it('drops a discount whose row somebody removed while the counter was looking', () => {
    const cart = buildPaymentCart([items[1]], selectAll(items), offered, 0);

    expect(cart.lines.map((line) => line.orderItemId)).toEqual(['b']);
    expect(totals(cart).totalMillimes).toBe(3_000);
  });

  it('caps a discount that no longer fits its row rather than throwing', () => {
    const tooMuch = new Map<string, LineDiscount>([
      ['a', { millimes: mm(9_999), reason: 'offert' }],
    ]);

    const cart = buildPaymentCart(items, selectAll(items), tooMuch, 0);

    expect(cart.lines[0].lineDiscountMillimes).toBe(2_500);
  });

  it('ignores a discount with no reason instead of applying one silently', () => {
    const unreasoned = new Map<string, LineDiscount>([['a', { millimes: mm(500), reason: '  ' }]]);

    const cart = buildPaymentCart(items, selectAll(items), unreasoned, 0);

    expect(cart.lines[0].lineDiscountMillimes).toBe(0);
    expect(cart.lines[0].lineDiscountReason).toBeUndefined();
  });

  it('discounts nothing when nothing is ticked', () => {
    expect(buildPaymentCart(items, noSelection, offered, 500).lines).toEqual([]);
  });
});

describe('paymentPlan', () => {
  const items = [
    item({ id: 'a', unitPriceMillimes: mm(2_500) }),
    item({ id: 'b', unitPriceMillimes: mm(3_000) }),
    item({ id: 'c', unitPriceMillimes: mm(4_500) }),
  ];

  it('refuses a payment with nothing ticked', () => {
    const plan = paymentPlan(items, cartForSelection(items, noSelection));

    expect(plan.problem).toBe('Choose what is being paid for');
    expect(plan.closesTable).toBe(false);
  });

  it('pays part of a table and says what is left', () => {
    const plan = paymentPlan(items, cartForSelection(items, toggleItem(noSelection, 'a')));

    expect(plan.problem).toBeNull();
    expect(plan.totalMillimes).toBe(2_500);
    expect(plan.remainingMillimes).toBe(7_500);
    expect(plan.closesTable).toBe(false);
    expect(plan.itemIds).toEqual(['a']);
  });

  it('closes the table when the last unpaid row is paid', () => {
    const plan = paymentPlan(items, cartForSelection(items, selectAll(items)));

    expect(plan.remainingMillimes).toBe(0);
    expect(plan.closesTable).toBe(true);
  });

  it('counts a line that was offered at its discounted total, and the rest at full price', () => {
    const cart = offerLine(
      cartForSelection(items, selectAll(items)),
      'c',
      mm(4_500),
      'erreur cuisine',
    );

    const plan = paymentPlan(items, cart);

    expect(plan.totalMillimes).toBe(5_500);
    expect(plan.closesTable).toBe(true);
  });

  it('takes the cart discount off what is being paid, never off what is left', () => {
    const cart = setCartDiscount(cartForSelection(items, toggleItem(noSelection, 'c')), 1_000);

    const plan = paymentPlan(items, cart);

    // 10 % of 4,500 is 450, allocated to the one line; the other two rows still owe their full price.
    expect(plan.totalMillimes).toBe(4_050);
    expect(plan.remainingMillimes).toBe(5_500);
  });

  it('does not close a table that keeps a row this device added, and counts that row as left', () => {
    const held = [
      item({ id: 'mine', ...addedHere, unitPriceMillimes: mm(1_000) }),
      item({ id: 'unpriced', ...addedHere, priceKnown: false, unitPriceMillimes: mm(0) }),
    ];

    const plan = paymentPlan(items, cartForSelection(items, selectAll(items)), held);

    expect(plan.closesTable).toBe(false);
    expect(plan.remainingMillimes).toBe(1_000);
  });

  it('still closes a table whose only held rows are coming off before the payment arrives', () => {
    const held = [item({ id: 'off', ...takenOffHere('remove') })];

    const plan = paymentPlan(items, cartForSelection(items, selectAll(items)), held);

    expect(plan.closesTable).toBe(true);
    expect(plan.remainingMillimes).toBe(0);
  });
});
