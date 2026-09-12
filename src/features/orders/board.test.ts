import { describe, expect, it } from 'vitest';
import { formatTND, mm } from '@/lib/money';
import { boardEntry, OTHER_TABLE, roomItem, roomOrder, TABLE } from './__fixtures__/room';
import {
  boardSummary,
  minutesSince,
  NO_BOARD_LOCAL,
  overlayBoard,
  tableState,
  tableTile,
  tableTiles,
  type RoomBoardEntry,
} from './board';
import { NO_LOCAL, type LocalChanges, type RoomOrder } from './overlay';

type EntryOptions = Omit<Partial<RoomBoardEntry>, 'table'> & {
  name: string;
  sortOrder?: number;
  isActive?: boolean;
};

function entry({ name, sortOrder = 0, isActive = true, ...rest }: EntryOptions): RoomBoardEntry {
  return {
    table: { id: `table-${name}`, name, sortOrder, isActive },
    orderId: null,
    openedAt: null,
    dueMillimes: mm(0),
    activeCount: 0,
    unsentCount: 0,
    unpaidCount: 0,
    local: NO_BOARD_LOCAL,
    ...rest,
  };
}

const occupied = {
  orderId: 'order-1',
  openedAt: '2026-09-12T10:00:00.000Z',
  dueMillimes: mm(12_500),
  activeCount: 3,
  unpaidCount: 3,
};

describe('tableState', () => {
  it('calls a table with no open order free', () => {
    expect(tableState(entry({ name: 'T1' }))).toBe('free');
  });

  it('calls an order whose items were all removed free, not owing', () => {
    expect(
      tableState(
        entry({ name: 'T1', ...occupied, activeCount: 0, unpaidCount: 0, dueMillimes: mm(0) }),
      ),
    ).toBe('free');
  });

  it('does not call a table free that has rows only this device put on it', () => {
    expect(tableState(entry({ name: 'T1', activeCount: 1, unsentCount: 1, unpaidCount: 1 }))).toBe(
      'unsent',
    );
  });

  it('leads with what the kitchen has not been told, even when money is due', () => {
    expect(tableState(entry({ name: 'T1', ...occupied, unsentCount: 2 }))).toBe('unsent');
  });

  it('owes once everything has gone to the kitchen', () => {
    expect(tableState(entry({ name: 'T1', ...occupied }))).toBe('owing');
  });

  it('is settled when an open order has nothing left to pay', () => {
    expect(tableState(entry({ name: 'T1', ...occupied, unpaidCount: 0, dueMillimes: mm(0) }))).toBe(
      'settled',
    );
  });
});

describe('tableTile', () => {
  /** Through formatTND, so the tile is checked against the app's own money text, separator and all. */
  const due = formatTND(mm(12_500));

  it('says how many items are waiting and what the table comes to', () => {
    const tile = tableTile(entry({ name: 'T3', ...occupied, unsentCount: 1 }));

    expect(tile.statusText).toBe(`1 item to send · ${due}`);
  });

  it('counts more than one item in the plural', () => {
    const tile = tableTile(entry({ name: 'T3', ...occupied, unsentCount: 2 }));

    expect(tile.statusText).toBe(`2 items to send · ${due}`);
  });

  it('shows only what is due once everything has been sent', () => {
    expect(tableTile(entry({ name: 'T3', ...occupied })).statusText).toBe(`${due} due`);
  });

  it('says nothing about money on a free table', () => {
    expect(tableTile(entry({ name: 'T3' })).statusText).toBe('Free');
  });

  it('says how many rows are owed at a price this device does not know, rather than guessing', () => {
    const tile = tableTile(entry({ name: 'T3', ...occupied }), {
      ...NO_BOARD_LOCAL,
      unpricedCount: 1,
    });

    expect(tile.statusText).toBe(`${due} due + 1 unpriced`);
  });

  it('carries what this device changed on the table, for the tile to flag', () => {
    const local = { ...NO_BOARD_LOCAL, changes: { pending: 2, conflicts: 0 } };

    expect(tableTile(entry({ name: 'T3' }), local).local).toBe(local);
  });
});

describe('tableTiles', () => {
  it('puts the tables in the order the admin gave them', () => {
    const tiles = tableTiles([
      entry({ name: 'Terrasse', sortOrder: 2 }),
      entry({ name: 'T1', sortOrder: 1 }),
    ]);

    expect(tiles.map((tile) => tile.name)).toEqual(['T1', 'Terrasse']);
  });

  it('falls back to the name when two tables share a position', () => {
    const tiles = tableTiles([entry({ name: 'B' }), entry({ name: 'A' })]);

    expect(tiles.map((tile) => tile.name)).toEqual(['A', 'B']);
  });

  it('leaves out a table that is not in service', () => {
    const tiles = tableTiles([entry({ name: 'T9', isActive: false }), entry({ name: 'T1' })]);

    expect(tiles.map((tile) => tile.name)).toEqual(['T1']);
  });

  it('keeps each table’s own changes on its tile', () => {
    const local = { ...NO_BOARD_LOCAL, changes: { pending: 1, conflicts: 0 } };
    const tiles = tableTiles([entry({ name: 'T1', local }), entry({ name: 'T2' })]);

    expect(tiles.map((tile) => tile.local.changes.pending)).toEqual([1, 0]);
  });
});

describe('overlayBoard', () => {
  const grid = [
    boardEntry(TABLE, {
      orderId: 'order-1',
      dueMillimes: mm(2_500),
      activeCount: 1,
      unsentCount: 1,
      unpaidCount: 1,
    }),
    boardEntry(OTHER_TABLE),
  ];

  function overlay(
    changed: ReadonlyMap<string, LocalChanges>,
    orders: ReadonlyMap<string, RoomOrder | null>,
  ) {
    return overlayBoard(grid, changed, orders);
  }

  it('is the grid as read, with nothing flagged, when this device changed nothing', () => {
    expect(overlay(new Map(), new Map())).toEqual(
      grid.map((read) => ({ ...read, local: NO_BOARD_LOCAL })),
    );
  });

  it('draws a changed table from its own order, rows this device added included', () => {
    const order = roomOrder(
      [
        roomItem({ id: 'x' }),
        roomItem({ id: 'a', fromServer: false, qty: 2, local: { ...NO_LOCAL, added: 'pending' } }),
      ],
      { changes: { pending: 1, conflicts: 0 } },
    );

    const [changed, untouched] = overlay(
      new Map([[TABLE, { pending: 1, conflicts: 0 }]]),
      new Map([[TABLE, order]]),
    );

    expect(changed).toEqual({
      table: grid[0].table,
      orderId: 'order-1',
      openedAt: order.openedAt,
      dueMillimes: mm(7_500),
      activeCount: 2,
      unsentCount: 2,
      unpaidCount: 2,
      local: { changes: { pending: 1, conflicts: 0 }, cancelling: null, unpricedCount: 0 },
    });
    expect(untouched).toEqual({ ...grid[1], local: NO_BOARD_LOCAL });
  });

  it('counts a row once when the grid already holds a row this device added', () => {
    // The grid counted the row already; the order the tile is drawn from matched it by id.
    const [changed] = overlay(
      new Map([[TABLE, { pending: 0, conflicts: 0 }]]),
      new Map([[TABLE, roomOrder([roomItem({ id: 'x' })])]]),
    );

    expect(changed.activeCount).toBe(1);
  });

  it('takes a row a send on this device covers off what is still to send, and flags the send', () => {
    const [changed] = overlay(
      new Map([[TABLE, { pending: 1, conflicts: 0 }]]),
      new Map([
        [
          TABLE,
          roomOrder([roomItem({ id: 'x', local: { ...NO_LOCAL, sending: 'pending' } })], {
            changes: { pending: 1, conflicts: 0 },
          }),
        ],
      ]),
    );

    expect(changed).toMatchObject({ unsentCount: 0, unpaidCount: 1, dueMillimes: mm(2_500) });
    expect(changed.local.changes.pending).toBe(1);
  });

  it('keeps a row coming off owed, and flags a waiting cancel', () => {
    const removing = {
      sync: 'pending' as const,
      reason: 'The guests left',
      cause: 'cancel' as const,
    };
    const [changed] = overlay(
      new Map([[TABLE, { pending: 1, conflicts: 0 }]]),
      new Map([
        [
          TABLE,
          roomOrder([roomItem({ id: 'x', local: { ...NO_LOCAL, removing } })], {
            cancelling: { sync: 'pending', reason: 'The guests left' },
            changes: { pending: 1, conflicts: 0 },
          }),
        ],
      ]),
    );

    expect(changed).toMatchObject({ activeCount: 1, dueMillimes: mm(2_500), unsentCount: 0 });
    expect(changed.local.cancelling).toBe('pending');
  });

  it('counts the rows whose price this device does not know apart from what is due', () => {
    const [changed] = overlay(
      new Map([[TABLE, { pending: 1, conflicts: 0 }]]),
      new Map([
        [
          TABLE,
          roomOrder([
            roomItem({ id: 'x' }),
            roomItem({ id: 'a', fromServer: false, priceKnown: false, unitPriceMillimes: mm(0) }),
          ]),
        ],
      ]),
    );

    expect(changed).toMatchObject({ dueMillimes: mm(2_500), unpaidCount: 2 });
    expect(changed.local.unpricedCount).toBe(1);
  });

  it('frees a table whose order is gone once drawn', () => {
    const [changed] = overlay(
      new Map([[TABLE, { pending: 0, conflicts: 0 }]]),
      new Map([[TABLE, null]]),
    );

    expect(changed).toEqual({ ...boardEntry(TABLE), local: NO_BOARD_LOCAL });
  });

  it('keeps the grid’s counts and flags the changes of a table whose order is not read yet', () => {
    const [changed] = overlay(new Map([[TABLE, { pending: 2, conflicts: 1 }]]), new Map());

    expect(changed).toEqual({
      ...grid[0],
      local: { ...NO_BOARD_LOCAL, changes: { pending: 2, conflicts: 1 } },
    });
  });
});

describe('boardSummary', () => {
  it('adds up the room: free tables, tables waiting on the kitchen and what is owed', () => {
    const tiles = tableTiles([
      entry({ name: 'T1' }),
      entry({ name: 'T2', ...occupied, unsentCount: 2 }),
      entry({ name: 'T3', ...occupied, dueMillimes: mm(7_500) }),
    ]);

    expect(boardSummary(tiles)).toEqual({
      tableCount: 3,
      freeCount: 1,
      waitingToSend: 1,
      dueMillimes: mm(20_000),
    });
  });

  it('owes nothing in an empty room', () => {
    expect(boardSummary([]).dueMillimes).toBe(mm(0));
  });
});

describe('minutesSince', () => {
  it('counts whole minutes', () => {
    expect(minutesSince('2026-09-12T10:00:00.000Z', Date.parse('2026-09-12T10:25:40.000Z'))).toBe(
      25,
    );
  });

  it('never goes negative when the device clock is behind the server', () => {
    expect(minutesSince('2026-09-12T10:00:00.000Z', Date.parse('2026-09-12T09:00:00.000Z'))).toBe(
      0,
    );
  });

  it('reads an unparsable timestamp as just now rather than throwing', () => {
    expect(minutesSince('not a date', Date.now())).toBe(0);
  });
});
