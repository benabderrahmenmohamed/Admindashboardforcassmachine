/**
 * The kitchen board: one card per send, oldest first.
 *
 * A ticket is what one waiter told the kitchen at one moment — the spec's "one send = one ticket" —
 * so a table that orders twice has two cards and the second does not reopen the first. An item the
 * waiter took off after sending it stays on the card as a void, because the cook has to be told to
 * stop making it; it is the only reason a removed row belongs on this screen at all.
 *
 * The tickets read here are drawn by `overlayKitchen`: a row this device marked prepared, or is
 * taking off, is marked rather than stamped until the server has the change, and the board places
 * it by the mark so the cook's list of things to make answers the tap at once.
 *
 * No React and no clock: `now` comes in, so the same card renders identically in a test.
 */
import { minutesSince } from '@/features/orders/board';
import type { RoomItem, RoomTicket } from '@/features/orders/overlay';

export interface TicketView {
  /** Stable across refreshes: one send of one order. */
  readonly key: string;
  readonly orderId: string;
  readonly tableId: string;
  readonly tableName: string;
  readonly sentAt: string;
  readonly waitedMinutes: number;
  /** Still to make. */
  readonly toPrepare: readonly RoomItem[];
  /** Made: stamped by the server, or marked on this device and on its way there. */
  readonly prepared: readonly RoomItem[];
  /** Taken off after the kitchen was told, here or on the server: stop making these. */
  readonly voided: readonly RoomItem[];
  /** Nothing left to make, so the card can leave the board. */
  readonly isDone: boolean;
}

export function ticketKey(ticket: Pick<RoomTicket, 'orderId' | 'sentAt'>): string {
  return `${ticket.orderId}:${ticket.sentAt}`;
}

function isVoided(item: RoomItem): boolean {
  return item.removedAt !== null || item.local.removing !== null;
}

function isPrepared(item: RoomItem): boolean {
  return item.preparedAt !== null || item.local.preparing !== null;
}

export function ticketView(ticket: RoomTicket, now: number): TicketView {
  const voided = ticket.items.filter(isVoided);
  const prepared = ticket.items.filter((item) => !isVoided(item) && isPrepared(item));
  // Read off the stamps the kitchen cares about, not the item's stage: a table that paid before its
  // coffee was made still owes the guest a coffee, and the server keeps the row on the board for it.
  const toPrepare = ticket.items.filter((item) => !isVoided(item) && !isPrepared(item));
  return {
    key: ticketKey(ticket),
    orderId: ticket.orderId,
    tableId: ticket.tableId,
    tableName: ticket.tableName,
    sentAt: ticket.sentAt,
    waitedMinutes: minutesSince(ticket.sentAt, now),
    toPrepare,
    prepared,
    voided,
    isDone: toPrepare.length === 0,
  };
}

/**
 * The board: oldest send first, so the ticket that has waited longest is at the top. Cards with
 * nothing left to make and nothing to void are dropped — the kitchen has finished with them — unless
 * this device marked something on the card prepared that the server does not have yet: the card
 * stays, flagged, until it does, so a tap that never arrives is not a card that silently vanished.
 */
export function ticketBoard(tickets: readonly RoomTicket[], now: number): TicketView[] {
  return tickets
    .map((ticket) => ticketView(ticket, now))
    .filter(
      (view) =>
        view.toPrepare.length > 0 ||
        view.voided.length > 0 ||
        view.prepared.some((item) => item.local.preparing !== null),
    )
    .sort((a, b) => {
      const order = Date.parse(a.sentAt) - Date.parse(b.sentAt);
      return order === 0 || Number.isNaN(order) ? a.tableName.localeCompare(b.tableName) : order;
    });
}

/** How long the board has been kept waiting: the oldest card's minutes, or zero when it is empty. */
export function longestWait(board: readonly TicketView[]): number {
  return board.reduce((longest, view) => Math.max(longest, view.waitedMinutes), 0);
}
