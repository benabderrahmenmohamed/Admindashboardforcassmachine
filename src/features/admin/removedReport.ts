/**
 * The report of items taken off a table after the kitchen had already been told.
 *
 * The spec is blunt about why it exists: that is the classic waiter fraud, so the rows are kept and
 * the admin is shown them per waiter, with what they were worth. Nothing here judges anybody — a
 * spilled coffee is a removal too — it only makes the pattern visible.
 */
import { add, mulQty, type Millimes } from '@/lib/money';
import type { RemovedAfterSent } from '@/ports';

/** What one removed row was worth: its quantity at the price it was ordered at. */
export function removalValue(row: RemovedAfterSent): Millimes {
  return mulQty(row.unitPriceMillimes, row.qty);
}

export interface RemovalTotals {
  /** How many rows were taken off. */
  readonly count: number;
  /** How many units those rows came to. */
  readonly units: number;
  readonly valueMillimes: Millimes;
}

export function removalTotals(rows: readonly RemovedAfterSent[]): RemovalTotals {
  return {
    count: rows.length,
    units: rows.reduce((units, row) => units + row.qty, 0),
    valueMillimes: add(...rows.map(removalValue)),
  };
}

export interface WaiterRemovals extends RemovalTotals {
  readonly userId: string;
  readonly name: string;
  readonly rows: readonly RemovedAfterSent[];
}

/**
 * Grouped by whoever took the items off, worth the most first: the list an owner reads top down.
 * Ties go to the name, so two waiters with the same total keep a stable order between refreshes.
 */
export function removalsByWaiter(rows: readonly RemovedAfterSent[]): WaiterRemovals[] {
  const byUser = new Map<string, RemovedAfterSent[]>();
  for (const row of rows) {
    const existing = byUser.get(row.removedBy);
    if (existing) {
      existing.push(row);
    } else {
      byUser.set(row.removedBy, [row]);
    }
  }
  return [...byUser.entries()]
    .map(([userId, group]): WaiterRemovals => {
      return {
        userId,
        name: group[0].removedByName,
        rows: group,
        ...removalTotals(group),
      };
    })
    .sort((a, b) =>
      a.valueMillimes === b.valueMillimes
        ? a.name.localeCompare(b.name)
        : b.valueMillimes - a.valueMillimes,
    );
}

/**
 * The name of the login a removal was sent under, when that is not the person the removal names: a
 * phone passed on before it synced, or a record written in someone else's name. Null when they are
 * the same person, and for a removal from before the login was recorded, of which nothing more is
 * known. An empty name is a login with no display name, which is still another login.
 */
export function otherSender(row: RemovedAfterSent): string | null {
  if (row.submittedBy === null || row.submittedBy === row.removedBy) {
    return null;
  }
  return row.submittedByName ?? '';
}

/** How long the kitchen had the item before it was taken off. Floor, never negative. */
export function minutesBeforeRemoval(row: RemovedAfterSent): number {
  const sent = Date.parse(row.sentAt);
  const removed = Date.parse(row.removedAt);
  if (Number.isNaN(sent) || Number.isNaN(removed)) {
    return 0;
  }
  return Math.max(0, Math.floor((removed - sent) / 60_000));
}

/** The "from" and "to" a date input holds, as `YYYY-MM-DD` in the browser's own day. */
export function isoDay(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

/**
 * A whole local day as the port wants it: from midnight to the last millisecond before the next.
 * Both ends are required, so a report is always of a named period rather than "everything so far".
 */
export function dayBounds(fromDay: string, toDay: string): { from: string; to: string } {
  return {
    from: new Date(`${fromDay}T00:00:00`).toISOString(),
    to: new Date(`${toDay}T23:59:59.999`).toISOString(),
  };
}
