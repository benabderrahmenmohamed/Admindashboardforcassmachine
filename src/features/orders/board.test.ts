import { describe, expect, it } from 'vitest';
import { formatTND, mm } from '@/lib/money';
import type { TableBoardEntry } from '@/ports';
import { boardSummary, minutesSince, tableState, tableTile, tableTiles } from './board';

type EntryOptions = Omit<Partial<TableBoardEntry>, 'table'> & {
  name: string;
  sortOrder?: number;
  isActive?: boolean;
};

function entry({ name, sortOrder = 0, isActive = true, ...rest }: EntryOptions): TableBoardEntry {
  return {
    table: { id: `table-${name}`, name, sortOrder, isActive },
    orderId: null,
    openedAt: null,
    dueMillimes: mm(0),
    activeCount: 0,
    unsentCount: 0,
    unpaidCount: 0,
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
