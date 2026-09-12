import { describe, expect, it } from 'vitest';
import { at, roomItem, roomOrder } from '@/features/orders/__fixtures__/room';
import { NO_LOCAL } from '@/features/orders/overlay';
import { cancelBlock } from './cancel';

describe('cancelBlock', () => {
  it('offers to cancel a table with something on it that nobody has paid for', () => {
    const order = roomOrder([
      roomItem({ id: 'sent', sentAt: at(2) }),
      roomItem({ id: 'unsent' }),
      // Taken off already: it neither blocks the cancel nor counts as something on the table.
      roomItem({ id: 'off', removedAt: at(3), paidSaleId: null }),
    ]);

    expect(cancelBlock(order)).toBeNull();
  });

  it('offers to cancel rows this device added that the server does not have yet', () => {
    // The adds go out before the cancel written after them, so the server has the order by then.
    const order = roomOrder([roomItem({ id: 'mine', fromServer: false })], { orderId: null });

    expect(cancelBlock(order)).toBeNull();
  });

  it('has nothing to cancel on a free table, or one whose rows are all taken off', () => {
    expect(cancelBlock(null)).toBe('nothing');
    expect(cancelBlock(roomOrder([roomItem({ id: 'off', removedAt: at(1) })]))).toBe('nothing');
  });

  it('does not cancel twice', () => {
    const order = roomOrder([roomItem({ id: 'row' })], {
      cancelling: { sync: 'pending', reason: 'The guests left' },
    });

    expect(cancelBlock(order)).toBe('cancelling');
  });

  it('refuses once a row is paid, as the server would', () => {
    const order = roomOrder([
      roomItem({ id: 'paid', paidSaleId: 'sale-1' }),
      roomItem({ id: 'rest' }),
    ]);

    expect(cancelBlock(order)).toBe('paid');
  });

  it('refuses while a payment this device wrote for a row is on its way', () => {
    const order = roomOrder([
      roomItem({ id: 'paying', local: { ...NO_LOCAL, paying: 'pending' } }),
      roomItem({ id: 'rest' }),
    ]);

    expect(cancelBlock(order)).toBe('paying');
  });
});
