import { describe, expect, it } from 'vitest';
import { roomItem } from '@/features/orders/__fixtures__/room';
import { NO_LOCAL, type RoomItem, type RoomTicket } from '@/features/orders/overlay';
import { longestWait, ticketBoard, ticketKey, ticketView } from './tickets';

const SENT = '2026-09-12T10:05:00.000Z';
const NOW = Date.parse('2026-09-12T10:20:00.000Z');

function item(overrides: Partial<RoomItem> & { id: string }): RoomItem {
  return roomItem({ sentAt: SENT, ...overrides });
}

function ticket(overrides: Partial<RoomTicket> & { items: RoomItem[] }): RoomTicket {
  return {
    orderId: 'order-1',
    tableId: 'table-1',
    tableName: 'T1',
    sentAt: SENT,
    ...overrides,
  };
}

describe('ticketView', () => {
  it('says how long the kitchen has had the ticket', () => {
    const view = ticketView(ticket({ items: [item({ id: 'a' })] }), NOW);

    expect(view.waitedMinutes).toBe(15);
  });

  it('splits what is still to make from what is done', () => {
    const view = ticketView(
      ticket({
        items: [item({ id: 'a' }), item({ id: 'b', preparedAt: '2026-09-12T10:10:00.000Z' })],
      }),
      NOW,
    );

    expect(view.toPrepare.map((line) => line.id)).toEqual(['a']);
    expect(view.prepared.map((line) => line.id)).toEqual(['b']);
    expect(view.isDone).toBe(false);
  });

  it('shows an item removed after it was sent as a void, and stops counting it as work', () => {
    const view = ticketView(
      ticket({
        items: [
          item({ id: 'a', removedAt: '2026-09-12T10:12:00.000Z', removedReason: 'wrong table' }),
        ],
      }),
      NOW,
    );

    expect(view.voided.map((line) => line.id)).toEqual(['a']);
    expect(view.toPrepare).toHaveLength(0);
    expect(view.isDone).toBe(true);
  });

  it('still asks for an item the table has already paid for: the guest is owed the coffee', () => {
    const view = ticketView(ticket({ items: [item({ id: 'a', paidSaleId: 'sale-1' })] }), NOW);

    expect(view.toPrepare.map((line) => line.id)).toEqual(['a']);
  });

  it('takes an item this device marked prepared off what is to make at once', () => {
    const view = ticketView(
      ticket({ items: [item({ id: 'a', local: { ...NO_LOCAL, preparing: 'pending' } })] }),
      NOW,
    );

    expect(view.prepared.map((line) => line.id)).toEqual(['a']);
    expect(view.toPrepare).toHaveLength(0);
  });

  it('shows an item this device is taking off, alone or with its table, as a void at once', () => {
    const view = ticketView(
      ticket({
        items: [
          item({
            id: 'a',
            local: { ...NO_LOCAL, removing: { sync: 'pending', reason: 'x', cause: 'remove' } },
          }),
          item({
            id: 'b',
            local: {
              ...NO_LOCAL,
              preparing: 'pending',
              removing: { sync: 'conflict', reason: 'y', cause: 'cancel' },
            },
          }),
        ],
      }),
      NOW,
    );

    expect(view.voided.map((line) => line.id)).toEqual(['a', 'b']);
    expect(view.prepared).toHaveLength(0);
  });

  it('gives one send of one order one key, so a card keeps its place across refreshes', () => {
    expect(ticketKey(ticket({ items: [item({ id: 'a' })] }))).toBe(`order-1:${SENT}`);
  });
});

describe('ticketBoard', () => {
  it('puts the send that has waited longest first', () => {
    const board = ticketBoard(
      [
        ticket({
          orderId: 'order-2',
          tableName: 'T2',
          sentAt: '2026-09-12T10:10:00.000Z',
          items: [item({ id: 'b' })],
        }),
        ticket({ items: [item({ id: 'a' })] }),
      ],
      NOW,
    );

    expect(board.map((view) => view.tableName)).toEqual(['T1', 'T2']);
  });

  it('separates two sends of the same table instead of merging them', () => {
    const board = ticketBoard(
      [
        ticket({ items: [item({ id: 'a' })] }),
        ticket({ sentAt: '2026-09-12T10:12:00.000Z', items: [item({ id: 'b' })] }),
      ],
      NOW,
    );

    expect(board).toHaveLength(2);
    expect(board.map((view) => view.key)).toEqual([
      'order-1:2026-09-12T10:05:00.000Z',
      'order-1:2026-09-12T10:12:00.000Z',
    ]);
  });

  it('takes a finished ticket off the board', () => {
    const board = ticketBoard(
      [ticket({ items: [item({ id: 'a', preparedAt: '2026-09-12T10:10:00.000Z' })] })],
      NOW,
    );

    expect(board).toHaveLength(0);
  });

  it('keeps a ticket finished on this device until the server has it, so the tap is seen to wait', () => {
    const waiting = ticketBoard(
      [ticket({ items: [item({ id: 'a', local: { ...NO_LOCAL, preparing: 'pending' } })] })],
      NOW,
    );
    const refused = ticketBoard(
      [ticket({ items: [item({ id: 'a', local: { ...NO_LOCAL, preparing: 'conflict' } })] })],
      NOW,
    );

    expect(waiting.map((view) => view.isDone)).toEqual([true]);
    expect(refused).toHaveLength(1);
  });

  it('keeps a finished ticket that has a void on it, so the cook is told to stop', () => {
    const board = ticketBoard(
      [
        ticket({
          items: [
            item({ id: 'a', preparedAt: '2026-09-12T10:10:00.000Z' }),
            item({ id: 'b', removedAt: '2026-09-12T10:12:00.000Z' }),
          ],
        }),
      ],
      NOW,
    );

    expect(board).toHaveLength(1);
    expect(board[0].voided.map((line) => line.id)).toEqual(['b']);
  });

  it('breaks a tie between two tables sent at the same moment by name', () => {
    const board = ticketBoard(
      [
        ticket({ orderId: 'order-2', tableName: 'T9', items: [item({ id: 'b' })] }),
        ticket({ tableName: 'T2', items: [item({ id: 'a' })] }),
      ],
      NOW,
    );

    expect(board.map((view) => view.tableName)).toEqual(['T2', 'T9']);
  });
});

describe('longestWait', () => {
  it('is the oldest card on the board', () => {
    const board = ticketBoard(
      [
        ticket({ items: [item({ id: 'a' })] }),
        ticket({
          orderId: 'order-2',
          sentAt: '2026-09-12T10:18:00.000Z',
          items: [item({ id: 'b' })],
        }),
      ],
      NOW,
    );

    expect(longestWait(board)).toBe(15);
  });

  it('is nothing on an empty board', () => {
    expect(longestWait([])).toBe(0);
  });
});
