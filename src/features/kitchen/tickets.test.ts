import { describe, expect, it } from 'vitest';
import { mm } from '@/lib/money';
import type { KitchenTicket, OpenOrderItem } from '@/ports';
import { longestWait, ticketBoard, ticketKey, ticketView } from './tickets';

const SENT = '2026-09-12T10:05:00.000Z';
const NOW = Date.parse('2026-09-12T10:20:00.000Z');

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
    sentAt: SENT,
    preparedAt: null,
    removedAt: null,
    removedBy: null,
    removedReason: null,
    paidSaleId: null,
    ...overrides,
  };
}

function ticket(overrides: Partial<KitchenTicket> & { items: OpenOrderItem[] }): KitchenTicket {
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
