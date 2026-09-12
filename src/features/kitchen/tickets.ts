/**
 * The kitchen board: one card per send, oldest first.
 *
 * A ticket is what one waiter told the kitchen at one moment — the spec's "one send = one ticket" —
 * so a table that orders twice has two cards and the second does not reopen the first. An item the
 * waiter took off after sending it stays on the card as a void, because the cook has to be told to
 * stop making it; it is the only reason a removed row belongs on this screen at all.
 *
 * No React and no clock: `now` comes in, so the same card renders identically in a test.
 */
import { minutesSince } from '@/features/orders/board';
import { itemStage } from '@/features/orders/tableOrder';
import type { KitchenTicket, OpenOrderItem } from '@/ports';

export interface TicketView {
  /** Stable across refreshes: one send of one order. */
  readonly key: string;
  readonly orderId: string;
  readonly tableId: string;
  readonly tableName: string;
  readonly sentAt: string;
  readonly waitedMinutes: number;
  /** Still to make. */
  readonly toPrepare: readonly OpenOrderItem[];
  readonly prepared: readonly OpenOrderItem[];
  /** Removed after the kitchen was told: stop making these. */
  readonly voided: readonly OpenOrderItem[];
  /** Nothing left to make, so the card can leave the board. */
  readonly isDone: boolean;
}

export function ticketKey(ticket: KitchenTicket): string {
  return `${ticket.orderId}:${ticket.sentAt}`;
}

export function ticketView(ticket: KitchenTicket, now: number): TicketView {
  const byStage = (...stages: readonly ReturnType<typeof itemStage>[]) =>
    ticket.items.filter((item) => stages.includes(itemStage(item)));
  const toPrepare = byStage('unsent', 'sent');
  return {
    key: ticketKey(ticket),
    orderId: ticket.orderId,
    tableId: ticket.tableId,
    tableName: ticket.tableName,
    sentAt: ticket.sentAt,
    waitedMinutes: minutesSince(ticket.sentAt, now),
    toPrepare,
    prepared: byStage('prepared'),
    // A paid item is off the kitchen's hands too, and only a removed one is a void to shout about.
    voided: byStage('removed'),
    isDone: toPrepare.length === 0,
  };
}

/**
 * The board: oldest send first, so the ticket that has waited longest is at the top. Cards with
 * nothing left to make and nothing to void are dropped — the kitchen has finished with them.
 */
export function ticketBoard(tickets: readonly KitchenTicket[], now: number): TicketView[] {
  return tickets
    .map((ticket) => ticketView(ticket, now))
    .filter((view) => view.toPrepare.length > 0 || view.voided.length > 0)
    .sort((a, b) => {
      const order = Date.parse(a.sentAt) - Date.parse(b.sentAt);
      return order === 0 || Number.isNaN(order) ? a.tableName.localeCompare(b.tableName) : order;
    });
}

/** How long the board has been kept waiting: the oldest card's minutes, or zero when it is empty. */
export function longestWait(board: readonly TicketView[]): number {
  return board.reduce((longest, view) => Math.max(longest, view.waitedMinutes), 0);
}
