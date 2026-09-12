import { describe, expect, it } from 'vitest';
import { saleLine, saleRecord } from '@/features/pos/__fixtures__/records';
import type { OutboxRecord, OutboxStatus } from '@/features/sync/types';
import { ZERO } from '@/lib/money';
import type { OpenOrder } from '@/ports';
import {
  addRecord,
  at,
  cancelRecord,
  CITRONNADE,
  EXPRESS,
  kitchenTicket,
  MENU,
  ms,
  ORDER,
  OTHER_TABLE,
  prepareRecord,
  removeRecord,
  sendRecord,
  serverItem,
  serverOrder,
  TABLE,
  type RecordOptions,
} from './__fixtures__/room';
import {
  changedTables,
  menuOf,
  NO_LOCAL,
  overlayKitchen,
  overlayOrder,
  rowTables,
  standing,
  UNKNOWN_ITEM_NAME,
  type RoomOrder,
} from './overlay';

/** TABLE as this device draws it over `server`, read at minute `readAtMinutes`. */
function draw(
  server: OpenOrder | null,
  records: readonly OutboxRecord[],
  readAtMinutes = 10,
): RoomOrder | null {
  return overlayOrder(TABLE, { data: server, readAt: ms(readAtMinutes) }, records, MENU);
}

/** The same, for a table the test expects something on. */
function drawn(
  server: OpenOrder | null,
  records: readonly OutboxRecord[],
  readAtMinutes = 10,
): RoomOrder {
  const order = draw(server, records, readAtMinutes);
  if (order === null) {
    throw new Error('Expected the table to be drawn, and it was free.');
  }
  return order;
}

function row(order: RoomOrder, id: string) {
  const found = order.items.find((item) => item.id === id);
  if (found === undefined) {
    throw new Error(`Expected row ${id} on the table.`);
  }
  return found;
}

const WAITING: readonly OutboxStatus[] = ['pending', 'sending'];
const GIVEN_UP: readonly OutboxStatus[] = ['discarded', 'voided'];

describe('standing', () => {
  it('draws a record that is queued or on its way as pending', () => {
    for (const status of WAITING) {
      expect(standing(addRecord({ id: 'a' }, { ordinal: 1, status }), ms(10)), status).toBe(
        'pending',
      );
    }
  });

  it('draws a record the server refused as a conflict', () => {
    expect(standing(addRecord({ id: 'a' }, { ordinal: 1, status: 'conflict' }), ms(10))).toBe(
      'conflict',
    );
  });

  it('draws an acked record over a read made before or at its ack, and not over a later one', () => {
    const acked = addRecord({ id: 'a' }, { ordinal: 1, status: 'acked', ackedAt: ms(10) });

    expect(standing(acked, ms(9))).toBe('acked');
    expect(standing(acked, ms(10))).toBe('acked');
    expect(standing(acked, ms(11))).toBeNull();
  });

  it('never draws a record a person gave up on', () => {
    for (const status of GIVEN_UP) {
      expect(standing(addRecord({ id: 'a' }, { ordinal: 1, status }), 0), status).toBeNull();
    }
  });
});

describe('menuOf', () => {
  it('indexes the name and price of every product by its id', () => {
    expect(menuOf([EXPRESS]).get(EXPRESS.id)).toEqual({
      name: EXPRESS.name,
      priceMillimes: EXPRESS.priceMillimes,
    });
  });
});

describe('overlayOrder with nothing written on this device', () => {
  it('is the server order, every row as the server has it', () => {
    const order = drawn(serverOrder([serverItem({ id: 'x' })]), []);

    expect(order).toMatchObject({ tableId: TABLE, orderId: ORDER, openedAt: at(0) });
    expect(order.items).toEqual([
      { ...serverItem({ id: 'x' }), fromServer: true, priceKnown: true, local: NO_LOCAL },
    ]);
    expect(order.changes).toEqual({ pending: 0, conflicts: 0 });
  });

  it('is null for a free table', () => {
    expect(draw(null, [])).toBeNull();
  });

  it('draws nothing for a sale whose rows the read does not have', () => {
    expect(draw(null, [saleRecord({ seq: 1, tableId: TABLE })])).toBeNull();
  });
});

describe('overlayOrder: an add', () => {
  it('appears on a free table at once, named and priced from the menu, flagged, queued or sending', () => {
    for (const status of WAITING) {
      const order = drawn(null, [
        addRecord(
          { id: 'a', productId: CITRONNADE.id, qty: 2, note: 'sans sucre' },
          { ordinal: 1, status, createdAt: at(3) },
        ),
      ]);

      expect(order.orderId, status).toBeNull();
      expect(order.openedAt, status).toBe(at(3));
      expect(order.items, status).toEqual([
        {
          id: 'a',
          orderId: null,
          productId: CITRONNADE.id,
          nameSnapshot: CITRONNADE.name,
          unitPriceMillimes: CITRONNADE.priceMillimes,
          qty: 2,
          note: 'sans sucre',
          addedBy: null,
          addedAt: at(3),
          sentAt: null,
          preparedAt: null,
          removedAt: null,
          removedBy: null,
          removedReason: null,
          paidSaleId: null,
          fromServer: false,
          priceKnown: true,
          local: { ...NO_LOCAL, added: 'pending' },
        },
      ]);
      expect(order.changes, status).toEqual({ pending: 1, conflicts: 0 });
    }
  });

  it('joins the rows the server has, after them, on the server’s order', () => {
    const order = drawn(serverOrder([serverItem({ id: 'x' })]), [
      addRecord({ id: 'a' }, { ordinal: 1 }),
    ]);

    expect(order.items.map((item) => [item.id, item.fromServer])).toEqual([
      ['x', true],
      ['a', false],
    ]);
    expect(row(order, 'a').orderId).toBe(ORDER);
    expect(order.openedAt).toBe(at(0));
  });

  it('is flagged as a conflict once the server refused it', () => {
    const order = drawn(null, [addRecord({ id: 'a' }, { ordinal: 1, status: 'conflict' })]);

    expect(row(order, 'a').local.added).toBe('conflict');
    expect(order.changes).toEqual({ pending: 0, conflicts: 1 });
  });

  it('has a placeholder name and no price when the menu on this device does not know the product', () => {
    const order = drawn(null, [addRecord({ id: 'a', productId: 'p-gone' }, { ordinal: 1 })]);

    expect(row(order, 'a')).toMatchObject({
      nameSnapshot: UNKNOWN_ITEM_NAME,
      unitPriceMillimes: ZERO,
      priceKnown: false,
    });
  });

  it('draws nothing once a person gave it up', () => {
    for (const status of GIVEN_UP) {
      expect(draw(null, [addRecord({ id: 'a' }, { ordinal: 1, status })]), status).toBeNull();
    }
  });

  it('stays in view, unflagged, between its ack and the read that follows it', () => {
    const order = drawn(
      null,
      [addRecord({ id: 'a' }, { ordinal: 1, status: 'acked', ackedAt: ms(12) })],
      10,
    );

    expect(row(order, 'a')).toMatchObject({ fromServer: false, local: NO_LOCAL });
    expect(order.changes).toEqual({ pending: 0, conflicts: 0 });
  });

  it('is shown once, as the server has it, when the read after the ack arrives', () => {
    const order = drawn(
      serverOrder([serverItem({ id: 'a', addedBy: 'waiter-1' })]),
      [addRecord({ id: 'a' }, { ordinal: 1, status: 'acked', ackedAt: ms(12) })],
      13,
    );

    expect(order.items).toHaveLength(1);
    expect(row(order, 'a')).toMatchObject({
      fromServer: true,
      addedBy: 'waiter-1',
      local: NO_LOCAL,
    });
  });

  it('is shown once when a read that raced its ack already has the row', () => {
    // The realtime event of the write can come back before the ack is stored: the read is older
    // than the ack and holds the row all the same.
    const order = drawn(
      serverOrder([serverItem({ id: 'a' })]),
      [addRecord({ id: 'a' }, { ordinal: 1, status: 'acked', ackedAt: ms(12) })],
      11,
    );

    expect(order.items).toHaveLength(1);
    expect(row(order, 'a').fromServer).toBe(true);
  });

  it('gives way to the server’s row while its answer is still on its way', () => {
    for (const status of WAITING) {
      const order = drawn(serverOrder([serverItem({ id: 'a' })]), [
        addRecord({ id: 'a' }, { ordinal: 1, status }),
      ]);

      expect(order.items, status).toHaveLength(1);
      expect(row(order, 'a').local, status).toEqual(NO_LOCAL);
      expect(order.changes, status).toEqual({ pending: 0, conflicts: 0 });
    }
  });

  it('matches the server’s row whatever the case of the id it was written with', () => {
    const upper = 'AAAAAAAA-0000-4000-8000-000000000001';
    const order = drawn(serverOrder([serverItem({ id: upper.toLowerCase() })]), [
      addRecord({ id: upper }, { ordinal: 1 }),
    ]);

    expect(order.items).toHaveLength(1);
  });

  it('draws nothing once read back without it: the table was paid and closed meanwhile', () => {
    expect(
      draw(null, [addRecord({ id: 'a' }, { ordinal: 1, status: 'acked', ackedAt: ms(12) })], 13),
    ).toBeNull();
  });

  it('leaves a table it does not name alone', () => {
    expect(draw(null, [addRecord({ id: 'a', tableId: OTHER_TABLE }, { ordinal: 1 })])).toBeNull();
  });
});

describe('overlayOrder: a removal', () => {
  const sentRow = serverItem({ id: 'x', sentAt: at(5) });

  it('keeps the row where it is, marked coming off with its reason, and still owed', () => {
    for (const status of WAITING) {
      const order = drawn(serverOrder([sentRow]), [removeRecord('r', 'x', { ordinal: 1, status })]);

      expect(row(order, 'x'), status).toMatchObject({
        removedAt: null,
        local: {
          ...NO_LOCAL,
          removing: { sync: 'pending', reason: 'Guest changed their mind', cause: 'remove' },
        },
      });
      expect(order.changes, status).toEqual({ pending: 1, conflicts: 0 });
    }
  });

  it('is flagged as a conflict once the server refused it', () => {
    const order = drawn(serverOrder([sentRow]), [
      removeRecord('r', 'x', { ordinal: 1, status: 'conflict' }),
    ]);

    expect(row(order, 'x').local.removing?.sync).toBe('conflict');
    expect(order.changes).toEqual({ pending: 0, conflicts: 1 });
  });

  it('shows the row taken off, unflagged, between its ack and the next read', () => {
    const order = drawn(
      serverOrder([sentRow]),
      [removeRecord('r', 'x', { ordinal: 1, status: 'acked', ackedAt: ms(12), createdAt: at(11) })],
      10,
    );

    expect(row(order, 'x')).toMatchObject({
      removedAt: at(11),
      removedReason: 'Guest changed their mind',
      local: NO_LOCAL,
    });
  });

  it('draws nothing once a person gave it up, or once the next read has it', () => {
    for (const status of GIVEN_UP) {
      const order = drawn(serverOrder([sentRow]), [removeRecord('r', 'x', { ordinal: 1, status })]);
      expect(row(order, 'x').local, status).toEqual(NO_LOCAL);
    }
    const afterRead = drawn(
      serverOrder([{ ...sentRow, removedAt: at(12), removedReason: 'Guest changed their mind' }]),
      [removeRecord('r', 'x', { ordinal: 1, status: 'acked', ackedAt: ms(12) })],
      13,
    );
    expect(row(afterRead, 'x')).toMatchObject({ removedAt: at(12), local: NO_LOCAL });
  });

  it('takes off a row only this device has, by the id its add gave it', () => {
    const order = drawn(null, [
      addRecord({ id: 'a' }, { ordinal: 1 }),
      removeRecord('r', 'a', { ordinal: 2 }),
    ]);

    expect(row(order, 'a').local).toMatchObject({
      added: 'pending',
      removing: { sync: 'pending', cause: 'remove' },
    });
    expect(order.changes).toEqual({ pending: 2, conflicts: 0 });
  });

  it('draws nothing on a row the read already shows off the table', () => {
    const order = drawn(serverOrder([{ ...sentRow, removedAt: at(8) }]), [
      removeRecord('r', 'x', { ordinal: 1 }),
    ]);

    expect(row(order, 'x').local).toEqual(NO_LOCAL);
    expect(order.changes).toEqual({ pending: 0, conflicts: 0 });
  });

  it('keeps the reason of the first of two removals of one row, as the server does', () => {
    const order = drawn(serverOrder([sentRow]), [
      removeRecord('r1', 'x', { ordinal: 1 }, 'first'),
      removeRecord('r2', 'x', { ordinal: 2 }, 'second'),
    ]);

    expect(row(order, 'x').local.removing?.reason).toBe('first');
  });

  it('leaves a row of another table alone', () => {
    const order = drawn(serverOrder([sentRow]), [removeRecord('r', 'elsewhere', { ordinal: 1 })]);

    expect(row(order, 'x').local).toEqual(NO_LOCAL);
    expect(order.changes).toEqual({ pending: 0, conflicts: 0 });
  });
});

describe('overlayOrder: a send', () => {
  it('marks every row the kitchen has not been told about as sending, whichever device added it', () => {
    for (const status of WAITING) {
      const order = drawn(serverOrder([serverItem({ id: 'theirs' })]), [
        addRecord({ id: 'mine' }, { ordinal: 1 }),
        sendRecord('s', { ordinal: 2, status }),
      ]);

      expect(row(order, 'theirs').local.sending, status).toBe('pending');
      expect(row(order, 'mine').local.sending, status).toBe('pending');
      expect(row(order, 'theirs').sentAt, status).toBeNull();
      expect(order.changes, status).toEqual({ pending: 2, conflicts: 0 });
    }
  });

  it('leaves alone a row already sent, one coming off before it, and one added after it', () => {
    const order = drawn(
      serverOrder([
        serverItem({ id: 'sent', sentAt: at(5) }),
        serverItem({ id: 'off' }),
        serverItem({ id: 'gone', removedAt: at(6) }),
      ]),
      [
        removeRecord('r', 'off', { ordinal: 1 }),
        sendRecord('s', { ordinal: 2 }),
        addRecord({ id: 'later' }, { ordinal: 3 }),
      ],
    );

    expect(order.items.map((item) => [item.id, item.local.sending])).toEqual([
      ['sent', null],
      ['off', null],
      ['gone', null],
      ['later', null],
    ]);
  });

  it('stamps the send’s own moment on its rows between its ack and the next read', () => {
    const order = drawn(
      serverOrder([serverItem({ id: 'x' })]),
      [sendRecord('s', { ordinal: 1, status: 'acked', ackedAt: ms(12), createdAt: at(11) })],
      10,
    );

    expect(row(order, 'x')).toMatchObject({ sentAt: at(11), local: NO_LOCAL });
  });

  it('is flagged as a conflict once the server refused it', () => {
    const order = drawn(serverOrder([serverItem({ id: 'x' })]), [
      sendRecord('s', { ordinal: 1, status: 'conflict' }),
    ]);

    expect(row(order, 'x').local.sending).toBe('conflict');
  });

  it('does not mark a row already being sent by an earlier send', () => {
    const order = drawn(serverOrder([serverItem({ id: 'x' })]), [
      sendRecord('s1', { ordinal: 1, status: 'conflict' }),
      sendRecord('s2', { ordinal: 2 }),
    ]);

    expect(row(order, 'x').local.sending).toBe('conflict');
  });

  it('leaves another table alone', () => {
    const order = drawn(serverOrder([serverItem({ id: 'x' })]), [
      sendRecord('s', { ordinal: 1 }, OTHER_TABLE),
    ]);

    expect(row(order, 'x').local).toEqual(NO_LOCAL);
  });
});

describe('overlayOrder: a prepare', () => {
  it('marks a row the kitchen has as preparing', () => {
    const order = drawn(serverOrder([serverItem({ id: 'x', sentAt: at(5) })]), [
      prepareRecord('p', 'x', { ordinal: 1 }),
    ]);

    expect(row(order, 'x').local.preparing).toBe('pending');
    expect(row(order, 'x').preparedAt).toBeNull();
  });

  it('marks a row that a send on this device is taking to the kitchen first', () => {
    const order = drawn(serverOrder([serverItem({ id: 'x' })]), [
      sendRecord('s', { ordinal: 1 }),
      prepareRecord('p', 'x', { ordinal: 2 }),
    ]);

    expect(row(order, 'x').local).toMatchObject({ sending: 'pending', preparing: 'pending' });
  });

  it('draws nothing on a row the kitchen was never told about, which the server refuses to prepare', () => {
    const order = drawn(serverOrder([serverItem({ id: 'x' })]), [
      prepareRecord('p', 'x', { ordinal: 1 }),
    ]);

    expect(row(order, 'x').local).toEqual(NO_LOCAL);
  });

  it('stamps the row prepared between its ack and the next read', () => {
    const order = drawn(
      serverOrder([serverItem({ id: 'x', sentAt: at(5) })]),
      [
        prepareRecord('p', 'x', {
          ordinal: 1,
          status: 'acked',
          ackedAt: ms(12),
          createdAt: at(11),
        }),
      ],
      10,
    );

    expect(row(order, 'x')).toMatchObject({ preparedAt: at(11), local: NO_LOCAL });
  });

  it('is flagged as a conflict once the server refused it', () => {
    const order = drawn(serverOrder([serverItem({ id: 'x', sentAt: at(5) })]), [
      prepareRecord('p', 'x', { ordinal: 1, status: 'conflict' }),
    ]);

    expect(row(order, 'x').local.preparing).toBe('conflict');
  });
});

describe('overlayOrder: a cancel', () => {
  it('marks the table, and every active unpaid row as coming off with the cancel’s reason', () => {
    const order = drawn(
      serverOrder([
        serverItem({ id: 'x' }),
        serverItem({ id: 'paid', paidSaleId: 'sale-1' }),
        serverItem({ id: 'gone', removedAt: at(6) }),
      ]),
      [addRecord({ id: 'mine' }, { ordinal: 1 }), cancelRecord('c', { ordinal: 2 })],
    );

    expect(order.cancelling).toEqual({ sync: 'pending', reason: 'The guests left' });
    expect(order.items.map((item) => [item.id, item.local.removing?.cause ?? null])).toEqual([
      ['x', 'cancel'],
      ['paid', null],
      ['gone', null],
      ['mine', 'cancel'],
    ]);
  });

  it('is flagged as a conflict once the server refused it', () => {
    const order = drawn(serverOrder([serverItem({ id: 'x' })]), [
      cancelRecord('c', { ordinal: 1, status: 'conflict' }),
    ]);

    expect(order.cancelling?.sync).toBe('conflict');
    expect(row(order, 'x').local.removing?.sync).toBe('conflict');
  });

  it('takes the cancelled order off the table between its ack and the next read, keeping later adds', () => {
    const order = drawn(
      serverOrder([serverItem({ id: 'x' })]),
      [
        addRecord({ id: 'before' }, { ordinal: 1, status: 'acked', ackedAt: ms(11) }),
        cancelRecord('c', { ordinal: 2, status: 'acked', ackedAt: ms(12) }),
        addRecord({ id: 'after' }, { ordinal: 3, createdAt: at(13) }),
      ],
      10,
    );

    expect(order.items.map((item) => item.id)).toEqual(['after']);
    expect(order).toMatchObject({ orderId: null, openedAt: at(13), cancelling: null });
  });

  it('is a free table once acked with nothing after it', () => {
    expect(
      draw(serverOrder([serverItem({ id: 'x' })]), [
        cancelRecord('c', { ordinal: 1, status: 'acked', ackedAt: ms(12) }),
      ]),
    ).toBeNull();
  });

  it('keeps a later order that a read racing the ack already shows', () => {
    const order = drawn(
      serverOrder([serverItem({ id: 'y', orderId: 'order-2' })], { id: 'order-2' }),
      [cancelRecord('c', { ordinal: 1, status: 'acked', ackedAt: ms(12) })],
      11,
    );

    expect(order.orderId).toBe('order-2');
    expect(order.items.map((item) => item.id)).toEqual(['y']);
  });

  it('leaves another table alone', () => {
    const order = drawn(serverOrder([serverItem({ id: 'x' })]), [
      cancelRecord('c', { ordinal: 1 }, OTHER_TABLE),
    ]);

    expect(order.cancelling).toBeNull();
    expect(row(order, 'x').local).toEqual(NO_LOCAL);
  });
});

describe('overlayOrder: a payment written on this device', () => {
  /** A sale paying rows `ids` of `tableId`, as the caisse queues it. */
  function payment(ids: readonly string[], options: Parameters<typeof saleRecord>[0]) {
    return saleRecord({
      ...options,
      lines: ids.map((id, index) =>
        saleLine({ id: `line-${index + 1}`, lineNo: index + 1, openOrderItemId: id }),
      ),
    });
  }

  // The offline double charge: the caisse took the money and the queue still holds the sale, so the
  // table must not look as though it still owes those rows.
  it('marks the rows it pays as being paid, queued, sending or refused, and counts the change', () => {
    for (const status of [...WAITING, 'conflict'] as const) {
      const order = drawn(serverOrder([serverItem({ id: 'a' }), serverItem({ id: 'b' })]), [
        payment(['a'], { seq: 42, ordinal: 1, status, tableId: TABLE }),
      ]);

      const expected = status === 'conflict' ? 'conflict' : 'pending';
      expect(row(order, 'a').local, status).toEqual({ ...NO_LOCAL, paying: expected });
      expect(row(order, 'a').paidSaleId, status).toBeNull();
      expect(row(order, 'b').local, status).toEqual(NO_LOCAL);
      expect(order.changes, status).toEqual(
        expected === 'conflict' ? { pending: 0, conflicts: 1 } : { pending: 1, conflicts: 0 },
      );
    }
  });

  it('draws the rows paid once the server took the sale, until the next read', () => {
    const sale = {
      ...payment(['a'], { seq: 42, ordinal: 1, status: 'acked', tableId: TABLE }),
      ackedAt: ms(12),
    };

    const order = drawn(serverOrder([serverItem({ id: 'a' })]), [sale], 10);

    expect(row(order, 'a')).toMatchObject({ paidSaleId: sale.payload.id, local: NO_LOCAL });
    expect(order.changes).toEqual({ pending: 0, conflicts: 0 });
  });

  it('draws nothing for a counter sale, a refund, a voided sale or a sale for another table', () => {
    const server = serverOrder([serverItem({ id: 'a' })]);
    const untouched = [
      // A counter line names no row.
      saleRecord({
        seq: 1,
        ordinal: 1,
        tableId: null,
        lines: [saleLine({ openOrderItemId: null })],
      }),
      payment(['a'], { seq: 2, ordinal: 2, kind: 'refund', tableId: null }),
      payment(['a'], { seq: 3, ordinal: 3, status: 'voided', tableId: TABLE }),
      payment(['a'], { seq: 4, ordinal: 4, tableId: OTHER_TABLE }),
    ];

    for (const record of untouched) {
      const order = drawn(server, [record]);
      expect(row(order, 'a').local, record.id).toEqual(NO_LOCAL);
      expect(order.changes, record.id).toEqual({ pending: 0, conflicts: 0 });
    }
  });

  it('leaves a row the read already shows paid as the server has it', () => {
    const order = drawn(serverOrder([serverItem({ id: 'a', paidSaleId: 'sale-earlier' })]), [
      payment(['a'], { seq: 42, ordinal: 1, tableId: TABLE }),
    ]);

    expect(row(order, 'a')).toMatchObject({ paidSaleId: 'sale-earlier', local: NO_LOCAL });
  });

  it('pays no row on the kitchen board, where a paid dish still has to be made', () => {
    const tickets = overlayKitchen(
      { data: [kitchenTicket([serverItem({ id: 'a', sentAt: at(1) })])], readAt: ms(10) },
      [payment(['a'], { seq: 42, ordinal: 1, tableId: TABLE })],
    );

    expect(tickets.flatMap((ticket) => ticket.items.map((item) => [item.id, item.local]))).toEqual([
      ['a', NO_LOCAL],
    ]);
  });
});

describe('overlayOrder: the queue as a whole', () => {
  it('replays the records in the order they were written, not the order they are listed in', () => {
    const order = drawn(null, [
      removeRecord('r', 'a', { ordinal: 2 }),
      addRecord({ id: 'a' }, { ordinal: 1 }),
    ]);

    expect(row(order, 'a').local.removing?.cause).toBe('remove');
  });

  it('counts what the server does not show yet, waiting and refused, and nothing acked', () => {
    const order = drawn(serverOrder([serverItem({ id: 'x' })]), [
      addRecord({ id: 'a' }, { ordinal: 1, status: 'acked', ackedAt: ms(12) }),
      addRecord({ id: 'b' }, { ordinal: 2, status: 'conflict' }),
      addRecord({ id: 'c' }, { ordinal: 3, status: 'sending' }),
      sendRecord('s', { ordinal: 4 }),
    ]);

    expect(order.changes).toEqual({ pending: 2, conflicts: 1 });
  });

  it('shows one tapped item once at every step from the tap to the server and back', () => {
    const tapped = (options: Omit<RecordOptions, 'ordinal'>) => [
      addRecord({ id: 'a', productId: CITRONNADE.id }, { ...options, ordinal: 1 }),
    ];
    const rowOnServer = serverItem({
      id: 'a',
      productId: CITRONNADE.id,
      nameSnapshot: CITRONNADE.name,
      unitPriceMillimes: CITRONNADE.priceMillimes,
    });

    const steps = [
      // Offline: queued, and the table read before it was tapped.
      drawn(null, tapped({ status: 'pending' }), 10),
      drawn(null, tapped({ status: 'sending' }), 10),
      // Acked, the old read still on screen.
      drawn(null, tapped({ status: 'acked', ackedAt: ms(12) }), 10),
      // The read the ack triggered.
      drawn(serverOrder([rowOnServer]), tapped({ status: 'acked', ackedAt: ms(12) }), 13),
    ];

    expect(steps.map((order) => order.items.map((item) => item.nameSnapshot))).toEqual([
      [CITRONNADE.name],
      [CITRONNADE.name],
      [CITRONNADE.name],
      [CITRONNADE.name],
    ]);
    expect(steps.map((order) => order.items[0].local.added)).toEqual([
      'pending',
      'pending',
      null,
      null,
    ]);
    expect(steps.map((order) => order.items[0].fromServer)).toEqual([false, false, false, true]);
  });
});

describe('overlayKitchen', () => {
  const x = serverItem({ id: 'x', sentAt: at(5) });
  const y = serverItem({ id: 'y', sentAt: at(5) });
  const theirs = kitchenTicket([serverItem({ id: 'z', sentAt: at(7) })], {
    orderId: 'order-2',
    tableId: OTHER_TABLE,
    tableName: 'T2',
    sentAt: at(7),
  });

  function kitchen(records: readonly OutboxRecord[], readAtMinutes = 10) {
    return overlayKitchen(
      { data: [kitchenTicket([x, y]), theirs], readAt: ms(readAtMinutes) },
      records,
    );
  }

  it('is the server’s tickets when this device has written nothing', () => {
    const tickets = kitchen([]);

    expect(tickets.map((ticket) => ticket.items.map((item) => [item.id, item.fromServer]))).toEqual(
      [
        [
          ['x', true],
          ['y', true],
        ],
        [['z', true]],
      ],
    );
  });

  it('marks a prepared row preparing while it waits, or refused, and leaves the other tickets alone', () => {
    for (const [status, sync] of [
      ['pending', 'pending'],
      ['sending', 'pending'],
      ['conflict', 'conflict'],
    ] as const) {
      const [mine, other] = kitchen([prepareRecord('p', 'x', { ordinal: 1, status })]);

      expect(
        mine.items.map((item) => item.local.preparing),
        status,
      ).toEqual([sync, null]);
      expect(other.items[0].local, status).toEqual(NO_LOCAL);
    }
  });

  it('takes a prepared row off between its ack and the next read, and the emptied ticket with it', () => {
    const tickets = kitchen([
      prepareRecord('p1', 'x', { ordinal: 1, status: 'acked', ackedAt: ms(12) }),
      prepareRecord('p2', 'y', { ordinal: 2, status: 'acked', ackedAt: ms(12) }),
    ]);

    expect(tickets.map((ticket) => ticket.orderId)).toEqual(['order-2']);
  });

  it('marks a removed row coming off, which the board shows as a void', () => {
    const [mine] = kitchen([removeRecord('r', 'y', { ordinal: 1 }, 'wrong table')]);

    expect(mine.items[1].local.removing).toEqual({
      sync: 'pending',
      reason: 'wrong table',
      cause: 'remove',
    });
  });

  it('takes a removed row off between its ack and the next read', () => {
    const [mine] = kitchen([
      removeRecord('r', 'y', { ordinal: 1, status: 'acked', ackedAt: ms(12) }),
    ]);

    expect(mine.items.map((item) => item.id)).toEqual(['x']);
  });

  it('marks every row of a cancelled table coming off, and only that table', () => {
    const [mine, other] = kitchen([cancelRecord('c', { ordinal: 1 })]);

    expect(mine.items.map((item) => item.local.removing?.cause)).toEqual(['cancel', 'cancel']);
    expect(other.items[0].local).toEqual(NO_LOCAL);
  });

  it('takes a cancelled order’s tickets off between its ack and the next read', () => {
    const tickets = kitchen([cancelRecord('c', { ordinal: 1, status: 'acked', ackedAt: ms(12) })]);

    expect(tickets.map((ticket) => ticket.orderId)).toEqual(['order-2']);
  });

  it('draws nothing for an add or a send, whose rows the kitchen’s read does not hold', () => {
    const tickets = kitchen([
      addRecord({ id: 'a' }, { ordinal: 1 }),
      sendRecord('s', { ordinal: 2 }),
    ]);

    expect(tickets.flatMap((ticket) => ticket.items.map((item) => item.id))).toEqual([
      'x',
      'y',
      'z',
    ]);
    expect(tickets.flatMap((ticket) => ticket.items.map((item) => item.local))).toEqual([
      NO_LOCAL,
      NO_LOCAL,
      NO_LOCAL,
    ]);
  });

  it('draws nothing for a record a person gave up on, or the next read already has', () => {
    for (const status of GIVEN_UP) {
      expect(kitchen([prepareRecord('p', 'x', { ordinal: 1, status })])[0].items[0].local).toEqual(
        NO_LOCAL,
      );
    }
    // Read after the ack: the server's board no longer lists the row, so neither does this one.
    const afterRead = overlayKitchen({ data: [kitchenTicket([y]), theirs], readAt: ms(13) }, [
      prepareRecord('p', 'x', { ordinal: 1, status: 'acked', ackedAt: ms(12) }),
    ]);
    expect(afterRead[0].items.map((item) => item.id)).toEqual(['y']);
  });
});

describe('rowTables', () => {
  it('places every row this device added, and every row of the orders it has read', () => {
    const tables = rowTables(
      [addRecord({ id: 'MINE', tableId: OTHER_TABLE }, { ordinal: 1, status: 'acked' })],
      [serverOrder([serverItem({ id: 'x' })]), null],
    );

    expect([...tables]).toEqual([
      ['x', TABLE],
      ['mine', OTHER_TABLE],
    ]);
  });
});

describe('changedTables', () => {
  const tables = new Map([
    ['x', TABLE],
    ['y', OTHER_TABLE],
  ]);

  it('lists the tables an add, a send and a cancel name, counting waiting and refused records', () => {
    const changed = changedTables(
      [
        addRecord({ id: 'a' }, { ordinal: 1 }),
        sendRecord('s', { ordinal: 2, status: 'conflict' }),
        cancelRecord('c', { ordinal: 3, status: 'sending' }, OTHER_TABLE),
      ],
      ms(10),
      tables,
    );

    expect([...changed]).toEqual([
      [TABLE, { pending: 1, conflicts: 1 }],
      [OTHER_TABLE, { pending: 1, conflicts: 0 }],
    ]);
  });

  it('puts a removal and a prepare on the table of the row they name, and skips a row it cannot place', () => {
    const changed = changedTables(
      [
        removeRecord('r', 'x', { ordinal: 1 }),
        prepareRecord('p', 'y', { ordinal: 2 }),
        removeRecord('r2', 'unknown', { ordinal: 3 }),
      ],
      ms(10),
      tables,
    );

    expect([...changed]).toEqual([
      [TABLE, { pending: 1, conflicts: 0 }],
      [OTHER_TABLE, { pending: 1, conflicts: 0 }],
    ]);
  });

  it('keeps a table with an ack the grid has not read yet, with nothing waiting on it', () => {
    const records = [addRecord({ id: 'a' }, { ordinal: 1, status: 'acked', ackedAt: ms(12) })];

    expect([...changedTables(records, ms(10), tables)]).toEqual([
      [TABLE, { pending: 0, conflicts: 0 }],
    ]);
    expect([...changedTables(records, ms(13), tables)]).toEqual([]);
  });

  it('forgets a record a person gave up on', () => {
    expect([
      ...changedTables(
        [addRecord({ id: 'a' }, { ordinal: 1, status: 'discarded' })],
        ms(10),
        tables,
      ),
    ]).toEqual([]);
  });
});
