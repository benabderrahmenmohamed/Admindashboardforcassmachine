/**
 * The table grid, as a waiter and a cashier both read it: one tile per table, saying whether it is
 * free, what it owes and whether anything is still waiting to go to the kitchen.
 *
 * Kept out of the components because it is the one thing on the screen that has to be right: the
 * tile a waiter taps says "3 to send" or "12,500 DT due", and that reading is the same on the phone
 * and at the counter. No React here, and the clock comes in as an argument.
 */
import { add, formatTND, ZERO, type Millimes } from '@/lib/money';
import type { TableBoardEntry } from '@/ports';
import { NO_CHANGES, type LocalChanges, type LocalSync, type RoomOrder } from './overlay';
import { orderTotals } from './tableOrder';

/**
 * - `free`: nothing is on the table — no open order, or everything on it was taken off.
 * - `unsent`: something has been ordered that the kitchen has not been told about yet.
 * - `owing`: everything is with the kitchen and money is still due.
 * - `settled`: an open order with nothing left to send and nothing left to pay.
 */
export type TableState = 'free' | 'unsent' | 'owing' | 'settled';

/** What this device has changed on a table that the grid's read does not show yet. */
export interface BoardLocal {
  readonly changes: LocalChanges;
  readonly cancelling: LocalSync | null;
  /** Rows owed whose price the menu on this device does not know, so `dueMillimes` leaves out. */
  readonly unpricedCount: number;
}

export const NO_BOARD_LOCAL: BoardLocal = {
  changes: NO_CHANGES,
  cancelling: null,
  unpricedCount: 0,
};

export interface RoomBoardEntry extends TableBoardEntry {
  readonly local: BoardLocal;
}

export interface TableTile {
  readonly tableId: string;
  readonly name: string;
  readonly state: TableState;
  /** What the unpaid, active items come to. */
  readonly dueMillimes: Millimes;
  readonly unsentCount: number;
  readonly activeCount: number;
  readonly openedAt: string | null;
  /** The line under the table's name, already worded. */
  readonly statusText: string;
  readonly local: BoardLocal;
}

export function tableState(entry: TableBoardEntry): TableState {
  // Counted rather than read off `orderId`: a table this device put the first item on has rows and
  // no server order yet, and is not free.
  if (entry.activeCount === 0) {
    return 'free';
  }
  if (entry.unsentCount > 0) {
    return 'unsent';
  }
  return entry.unpaidCount > 0 ? 'owing' : 'settled';
}

function items(count: number): string {
  return `${count} ${count === 1 ? 'item' : 'items'}`;
}

/** One tile. `unsent` leads with what the kitchen is waiting for, because that is the waiter's job. */
export function tableTile(entry: TableBoardEntry, local: BoardLocal = NO_BOARD_LOCAL): TableTile {
  const state = tableState(entry);
  const due = formatTND(entry.dueMillimes);
  // A price this device does not know is not guessed, and not silently left out either.
  const unpriced = local.unpricedCount > 0 ? ` + ${local.unpricedCount} unpriced` : '';
  const statusText =
    state === 'free'
      ? 'Free'
      : state === 'unsent'
        ? `${items(entry.unsentCount)} to send · ${due}${unpriced}`
        : state === 'owing'
          ? `${due} due${unpriced}`
          : 'Paid';
  return {
    tableId: entry.table.id,
    name: entry.table.name,
    state,
    dueMillimes: entry.dueMillimes,
    unsentCount: entry.unsentCount,
    activeCount: entry.activeCount,
    openedAt: entry.openedAt,
    statusText,
    local,
  };
}

/**
 * The grid in the order the admin put the tables in, inactive ones left out: a table taken out of
 * service must not be tapped, and the board a backend sends may carry one until it catches up.
 */
export function tableTiles(entries: readonly RoomBoardEntry[]): TableTile[] {
  return entries
    .filter((entry) => entry.table.isActive)
    .slice()
    .sort((a, b) =>
      a.table.sortOrder === b.table.sortOrder
        ? a.table.name.localeCompare(b.table.name)
        : a.table.sortOrder - b.table.sortOrder,
    )
    .map((entry) => tableTile(entry, entry.local));
}

/** A tile's counts and flags as its table draws them, for a table this device has changed. */
function entryOf(entry: TableBoardEntry, order: RoomOrder | null): RoomBoardEntry {
  if (order === null) {
    return {
      table: entry.table,
      orderId: null,
      openedAt: null,
      dueMillimes: ZERO,
      activeCount: 0,
      unsentCount: 0,
      unpaidCount: 0,
      local: NO_BOARD_LOCAL,
    };
  }
  const totals = orderTotals(order.items);
  return {
    table: entry.table,
    orderId: order.orderId,
    openedAt: order.openedAt,
    dueMillimes: totals.dueMillimes,
    activeCount: totals.activeCount,
    // What is left for a waiter to send: the tile's "to send" is a call to action, and a send this
    // device already made has answered it.
    unsentCount: totals.toSendCount,
    unpaidCount: totals.unpaidCount,
    local: {
      changes: order.changes,
      cancelling: order.cancelling?.sync ?? null,
      unpricedCount: totals.unpricedCount,
    },
  };
}

/**
 * The grid with this device's changes drawn over it.
 *
 * The grid's read carries counts, not rows, so it cannot tell whether it already holds an item this
 * device added: an ack and the read that follows it can land in either order. A table this device
 * has changed is therefore drawn from its own order, overlaid (`orders`), whose rows are matched by
 * id. A changed table whose order has not been read yet keeps the grid's counts and says it has
 * changes waiting; every other table is exactly as the grid read it.
 *
 * `changed` comes from `changedTables` over the grid's read, and `orders` from `overlayOrder` over
 * each changed table's own read.
 */
export function overlayBoard(
  entries: readonly TableBoardEntry[],
  changed: ReadonlyMap<string, LocalChanges>,
  orders: ReadonlyMap<string, RoomOrder | null>,
): RoomBoardEntry[] {
  return entries.map((entry) => {
    const tableId = entry.table.id;
    const changes = changed.get(tableId);
    if (changes === undefined) {
      return { ...entry, local: NO_BOARD_LOCAL };
    }
    const order = orders.get(tableId);
    if (order === undefined) {
      return { ...entry, local: { ...NO_BOARD_LOCAL, changes } };
    }
    return entryOf(entry, order);
  });
}

export interface BoardSummary {
  readonly tableCount: number;
  readonly freeCount: number;
  readonly waitingToSend: number;
  readonly dueMillimes: Millimes;
}

/** What the header of the grid says: how full the room is and what it owes altogether. */
export function boardSummary(tiles: readonly TableTile[]): BoardSummary {
  return {
    tableCount: tiles.length,
    freeCount: tiles.filter((tile) => tile.state === 'free').length,
    waitingToSend: tiles.filter((tile) => tile.unsentCount > 0).length,
    // Through the money module, so the room's total is added as integers like every other amount.
    dueMillimes: add(...tiles.map((tile) => tile.dueMillimes)),
  };
}

/** Whole minutes between two ISO timestamps, floor, never negative. For "open 25 min". */
export function minutesSince(from: string, now: number): number {
  const started = Date.parse(from);
  if (Number.isNaN(started)) {
    return 0;
  }
  return Math.max(0, Math.floor((now - started) / 60_000));
}
