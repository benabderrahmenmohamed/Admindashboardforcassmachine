/**
 * The table grid, as a waiter and a cashier both read it: one tile per table, saying whether it is
 * free, what it owes and whether anything is still waiting to go to the kitchen.
 *
 * Kept out of the components because it is the one thing on the screen that has to be right: the
 * tile a waiter taps says "3 to send" or "12,500 DT due", and that reading is the same on the phone
 * and at the counter. No React here, and the clock comes in as an argument.
 */
import { add, formatTND, type Millimes } from '@/lib/money';
import type { TableBoardEntry } from '@/ports';

/**
 * - `free`: nobody is sitting there — no open order.
 * - `unsent`: something has been ordered that the kitchen has not been told about yet.
 * - `owing`: everything is with the kitchen and money is still due.
 * - `settled`: an open order with nothing left to send and nothing left to pay.
 */
export type TableState = 'free' | 'unsent' | 'owing' | 'settled';

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
}

export function tableState(entry: TableBoardEntry): TableState {
  if (entry.orderId === null || entry.activeCount === 0) {
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
export function tableTile(entry: TableBoardEntry): TableTile {
  const state = tableState(entry);
  const due = formatTND(entry.dueMillimes);
  const statusText =
    state === 'free'
      ? 'Free'
      : state === 'unsent'
        ? `${items(entry.unsentCount)} to send · ${due}`
        : state === 'owing'
          ? `${due} due`
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
  };
}

/**
 * The grid in the order the admin put the tables in, inactive ones left out: a table taken out of
 * service must not be tapped, and the board a backend sends may carry one until it catches up.
 */
export function tableTiles(entries: readonly TableBoardEntry[]): TableTile[] {
  return entries
    .filter((entry) => entry.table.isActive)
    .slice()
    .sort((a, b) =>
      a.table.sortOrder === b.table.sortOrder
        ? a.table.name.localeCompare(b.table.name)
        : a.table.sortOrder - b.table.sortOrder,
    )
    .map(tableTile);
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
