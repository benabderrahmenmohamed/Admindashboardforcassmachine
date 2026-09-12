/**
 * The room as this device draws it: the server's last read, with the order records this device has
 * written since drawn over it and flagged.
 *
 * A waiter's tap never waits for the server — the add, the send or the removal goes into the
 * device's queue — so a screen that showed only the server's rows would show nothing happening.
 * These functions replay the device's order records over a server read, oldest first, the way the
 * server will apply them once the queue drains, and decide record by record what is drawn:
 *
 * - A record still on its way (`pending`, `sending`) or refused (`conflict`) is drawn as a flagged
 *   change. Nothing the read already shows is drawn twice: a row is matched by its id, and an added
 *   item's id is its add record's id, on the server as here.
 * - A record the server took (`acked`) after the read was made is drawn as the server now holds it,
 *   unflagged, until a read made after the ack replaces this one. That is the window between an ack
 *   and the refetch it triggers, and without it an added item would blink out of view.
 * - A discarded record is a change a person gave up on, and draws nothing.
 * - A sale this device wrote for a table is drawn too, over the rows it pays: they are being paid
 *   here. Without that, a caisse with no connection would still show them owed, and take the same
 *   rows' money a second time — a sale that can only come back refused, behind a number that stops
 *   the register's queue. A voided sale paid nothing and draws nothing.
 *
 * Changes are drawn over the server's rows rather than applied to them wherever the server still
 * holds the row: an item this device is taking off stays on its table, marked, because until the
 * server has the removal it is still on the table and still owed. Only an add — a row the server
 * does not have at all — is drawn as a row of its own.
 *
 * The table grid is drawn from these orders too, in `board.ts`. No React, no clock and no I/O: the
 * moment of each read comes in with the read.
 */
import {
  isOrderRecord,
  type LedgerOutboxRecord,
  type OrderOutboxRecord,
  type OutboxRecord,
} from '@/features/sync/types';
import { ZERO, type Millimes } from '@/lib/money';
import type { KitchenTicket, OpenOrder, OpenOrderItem, Product } from '@/ports';

/**
 * How far one of this device's changes got:
 * - `pending`: on this device, waiting its turn, its next attempt or its answer;
 * - `conflict`: the server refused it and the queue stopped there, so a person has to act.
 */
export type LocalSync = 'pending' | 'conflict';

/** A row coming off its table on this device: by its own removal, or with the table's cancel. */
export interface LocalRemoval {
  readonly sync: LocalSync;
  readonly reason: string;
  readonly cause: 'remove' | 'cancel';
}

/** This device's changes to one row that the server does not show yet; null where there is none. */
export interface ItemLocal {
  /** The row exists only on this device: its add has not reached the server. */
  readonly added: LocalSync | null;
  /** A send of its table will tell the kitchen about it. */
  readonly sending: LocalSync | null;
  readonly preparing: LocalSync | null;
  readonly removing: LocalRemoval | null;
  /** A sale written on this device pays the row: the money is in this till, the server does not know. */
  readonly paying: LocalSync | null;
}

export const NO_LOCAL: ItemLocal = {
  added: null,
  sending: null,
  preparing: null,
  removing: null,
  paying: null,
};

/** One row of a table, as the server holds it or as this device added it. */
export interface RoomItem extends Omit<OpenOrderItem, 'orderId' | 'addedBy'> {
  /** The server's order the row is on; null for a row only this device has, on a free table. */
  readonly orderId: string | null;
  /** Null for a row only this device has: the server stamps who added it. */
  readonly addedBy: string | null;
  /**
   * True for a row as the server last read it. A row drawn from this device's own add — pending, or
   * acked and not read back yet — carries the cached menu's name and price, not the server's
   * snapshot, so nothing may be charged against it.
   */
  readonly fromServer: boolean;
  /** False when the menu on this device did not know the product: the price is a placeholder. */
  readonly priceKnown: boolean;
  readonly local: ItemLocal;
}

/** How many of this device's records the server does not show yet: waiting, and refused. */
export interface LocalChanges {
  readonly pending: number;
  readonly conflicts: number;
}

export const NO_CHANGES: LocalChanges = { pending: 0, conflicts: 0 };

export interface LocalCancel {
  readonly sync: LocalSync;
  readonly reason: string;
}

/** A table as this device draws it. */
export interface RoomOrder {
  readonly tableId: string;
  /** The server's open order, or null while everything on the table is this device's own adds. */
  readonly orderId: string | null;
  readonly openedAt: string | null;
  readonly items: readonly RoomItem[];
  /** A cancel of the whole table this device wrote, which the server does not show yet. */
  readonly cancelling: LocalCancel | null;
  /** This device's records on the table that the server does not show yet. */
  readonly changes: LocalChanges;
}

/** A kitchen ticket as this device draws it. */
export interface RoomTicket extends Omit<KitchenTicket, 'items'> {
  readonly items: readonly RoomItem[];
}

/** A server read and the moment it was made: TanStack Query's `dataUpdatedAt`. */
export interface Read<T> {
  readonly data: T;
  readonly readAt: number;
}

/** What a pending add is drawn with: the product's name and price as the menu on this device has them. */
export interface MenuEntry {
  readonly name: string;
  readonly priceMillimes: Millimes;
}

export type Menu = ReadonlyMap<string, MenuEntry>;

export function menuOf(products: readonly Pick<Product, 'id' | 'name' | 'priceMillimes'>[]): Menu {
  return new Map(
    products.map((product) => [
      product.id,
      { name: product.name, priceMillimes: product.priceMillimes },
    ]),
  );
}

/**
 * The name of an added row whose product the menu on this device does not have — a queue that
 * outlived a cleared cache. The row still shows, with its quantity and note; its name and its price
 * arrive with the server's read.
 */
export const UNKNOWN_ITEM_NAME = 'Menu item';

type Standing = LocalSync | 'acked';

/** Where `record` stands against a read made at `readAt`, or null when it draws nothing on it. */
export function standing(record: OutboxRecord, readAt: number): Standing | null {
  switch (record.status) {
    case 'pending':
    case 'sending':
      return 'pending';
    case 'conflict':
      return 'conflict';
    case 'acked':
      // `>=`: an ack and a read in the same millisecond cannot be ordered. Drawing an acked change
      // the read already shows costs nothing, because it is matched away; leaving out one the read
      // does not show would make it blink.
      return record.ackedAt !== null && record.ackedAt >= readAt ? 'acked' : null;
    case 'voided':
    case 'discarded':
      return null;
  }
}

/** A sale that pays rows of a table: a refund, or a counter sale, pays none. */
type TablePayment = Extract<LedgerOutboxRecord, { seq: number }> & {
  readonly kind: 'sale';
  readonly payload: { readonly tableId: string };
};

function isTablePayment(record: OutboxRecord): record is TablePayment {
  return record.kind === 'sale' && record.payload.tableId !== null;
}

interface Unshown {
  readonly record: OrderOutboxRecord | TablePayment;
  readonly at: Standing;
}

/**
 * The records a read made at `readAt` may not show — order records, and sales that pay a table — in
 * the order the server applies them.
 */
function unshown(records: readonly OutboxRecord[], readAt: number): Unshown[] {
  return records
    .flatMap((record): Unshown[] => {
      if (!isOrderRecord(record) && !isTablePayment(record)) {
        return [];
      }
      const at = standing(record, readAt);
      return at === null ? [] : [{ record, at }];
    })
    .sort((a, b) => a.record.ordinal - b.record.ordinal);
}

/** Row ids as the server stores them: a uuid column reads back lowercase whatever was written. */
function idKey(id: string): string {
  return id.toLowerCase();
}

function serverItem(item: OpenOrderItem): RoomItem {
  return { ...item, fromServer: true, priceKnown: true, local: NO_LOCAL };
}

function withLocal(item: RoomItem, change: Partial<ItemLocal>): RoomItem {
  return { ...item, local: { ...item.local, ...change } };
}

/**
 * One table: the server's open order, or null when it is free, with this device's order records
 * drawn over it. Null when the table is free and this device has nothing on it either.
 *
 * - An add is drawn as a row of its own at the end, named and priced from `menu`, flagged
 *   `added`, unless the read already has its row.
 * - A removal marks its row `removing` and leaves it where it is: still on the table, still owed.
 * - A send marks `sending` every row it will stamp: not yet sent, not being taken off, and not
 *   already being sent by an earlier send. A row added after the send is not one of them.
 * - A prepare marks `preparing` a row the kitchen has, or is being sent; the server refuses to
 *   prepare anything else, so nothing else is drawn.
 * - A cancel marks the table `cancelling` and every active, unpaid row `removing`.
 * - Acked in the window, each is drawn as done: the row added, the stamp set, a cancelled order's
 *   rows gone.
 */
export function overlayOrder(
  tableId: string,
  read: Read<OpenOrder | null>,
  records: readonly OutboxRecord[],
  menu: Menu,
): RoomOrder | null {
  const server = read.data;
  const rows = new Map<string, RoomItem>();
  for (const item of server?.items ?? []) {
    rows.set(idKey(item.id), serverItem(item));
  }
  let orderId = server?.id ?? null;
  let openedAt = server?.openedAt ?? null;
  let cancelling: LocalCancel | null = null;
  let pending = 0;
  let conflicts = 0;

  const counted = (at: Standing): void => {
    if (at === 'pending') {
      pending += 1;
    } else if (at === 'conflict') {
      conflicts += 1;
    }
  };

  for (const { record, at } of unshown(records, read.readAt)) {
    switch (record.kind) {
      case 'order_item_add': {
        const { payload } = record;
        const id = idKey(payload.id);
        // Already in the read: the server's row is the one to show, and it needs no flag.
        if (payload.tableId !== tableId || rows.has(id)) {
          break;
        }
        const entry = menu.get(payload.productId);
        rows.set(id, {
          id: payload.id,
          orderId,
          productId: payload.productId,
          nameSnapshot: entry?.name ?? UNKNOWN_ITEM_NAME,
          unitPriceMillimes: entry?.priceMillimes ?? ZERO,
          qty: payload.qty,
          note: payload.note,
          addedBy: null,
          addedAt: payload.createdAt,
          sentAt: null,
          preparedAt: null,
          removedAt: null,
          removedBy: null,
          removedReason: null,
          paidSaleId: null,
          fromServer: false,
          priceKnown: entry !== undefined,
          local: at === 'acked' ? NO_LOCAL : { ...NO_LOCAL, added: at },
        });
        // The server opens a free table's order with the first add, stamped with the add's time.
        openedAt ??= payload.createdAt;
        counted(at);
        break;
      }

      case 'order_item_remove': {
        const { payload } = record;
        const id = idKey(payload.itemId);
        const row = rows.get(id);
        // A row of another table, or one the read already shows off the table.
        if (row === undefined || row.removedAt !== null) {
          break;
        }
        if (at === 'acked') {
          rows.set(id, {
            ...row,
            removedAt: payload.createdAt,
            removedReason: payload.reason,
            local: { ...row.local, removing: null },
          });
        } else if (row.local.removing === null) {
          // The first removal is the one the server keeps; a second one of the same row changes
          // nothing there, so it changes nothing here.
          rows.set(
            id,
            withLocal(row, { removing: { sync: at, reason: payload.reason, cause: 'remove' } }),
          );
        }
        counted(at);
        break;
      }

      case 'order_send': {
        const { payload } = record;
        if (payload.tableId !== tableId) {
          break;
        }
        for (const [id, row] of rows) {
          if (
            row.sentAt !== null ||
            row.removedAt !== null ||
            row.local.removing !== null ||
            row.local.sending !== null
          ) {
            continue;
          }
          // The server stamps the send's own moment, so a drawn stamp is the one the read will have.
          rows.set(
            id,
            at === 'acked'
              ? { ...row, sentAt: payload.createdAt }
              : withLocal(row, { sending: at }),
          );
        }
        counted(at);
        break;
      }

      case 'order_item_prepare': {
        const { payload } = record;
        const id = idKey(payload.itemId);
        const row = rows.get(id);
        if (
          row === undefined ||
          row.preparedAt !== null ||
          row.removedAt !== null ||
          (row.sentAt === null && row.local.sending === null)
        ) {
          break;
        }
        rows.set(
          id,
          at === 'acked'
            ? { ...row, preparedAt: payload.createdAt }
            : withLocal(row, { preparing: at }),
        );
        counted(at);
        break;
      }

      case 'order_cancel': {
        const { payload } = record;
        if (payload.tableId !== tableId) {
          break;
        }
        if (at === 'acked') {
          // Every row of the cancelled order left the table with it, this device's earlier adds
          // included. A later order the read already shows is not the one this record cancelled.
          const cancelled = record.result?.orderId ?? orderId;
          for (const [id, row] of rows) {
            if (!row.fromServer || row.orderId === cancelled) {
              rows.delete(id);
            }
          }
          if (orderId === cancelled) {
            orderId = null;
            openedAt = null;
          }
          break;
        }
        cancelling ??= { sync: at, reason: payload.reason };
        for (const [id, row] of rows) {
          // A paid row stays: the ledger holds it, and the server refuses the cancel because of it.
          if (row.removedAt === null && row.paidSaleId === null && row.local.removing === null) {
            rows.set(
              id,
              withLocal(row, { removing: { sync: at, reason: payload.reason, cause: 'cancel' } }),
            );
          }
        }
        counted(at);
        break;
      }

      case 'sale': {
        const { payload } = record;
        if (payload.tableId !== tableId) {
          break;
        }
        let pays = false;
        for (const line of payload.lines) {
          const id = line.openOrderItemId === null ? null : idKey(line.openOrderItemId);
          const row = id === null ? undefined : rows.get(id);
          // A counter line pays no row; a row the read already shows paid needs nothing drawn.
          if (id === null || row === undefined || row.paidSaleId !== null) {
            continue;
          }
          // The sale's id is the record's: it is the id the server stamps on the rows it pays.
          rows.set(
            id,
            at === 'acked' ? { ...row, paidSaleId: payload.id } : withLocal(row, { paying: at }),
          );
          pays = true;
        }
        // Counted only where it shows: a sale for rows this read does not have would otherwise put a
        // change on a table that has nothing on it.
        if (pays) {
          counted(at);
        }
        break;
      }
    }
  }

  const items = [...rows.values()];
  if (orderId === null && items.length === 0 && pending === 0 && conflicts === 0) {
    return null;
  }
  return { tableId, orderId, openedAt, items, cancelling, changes: { pending, conflicts } };
}

/**
 * The kitchen's tickets with this device's order records drawn over them. The kitchen reads only
 * what it has to make, so:
 *
 * - A prepare marks its row `preparing`: off the list of things to make, flagged, and the ticket
 *   stays on the board until the server has it. Acked in the window, the row is gone, as the
 *   server's next read will have it.
 * - A removal marks its row `removing`, which the board shows as a void; a cancel does that to
 *   every row of the table's tickets. Acked in the window, the row (or the order's tickets) is gone.
 * - An add or a send draws nothing: a send names a table, not the rows it will stamp, and those rows
 *   are not in the kitchen's read. The ticket appears when the server has the send.
 */
export function overlayKitchen(
  read: Read<readonly KitchenTicket[]>,
  records: readonly OutboxRecord[],
): RoomTicket[] {
  const tickets = read.data.map((ticket) => ({
    ticket,
    rows: new Map(ticket.items.map((item) => [idKey(item.id), serverItem(item)])),
  }));

  const find = (itemId: string) => {
    const id = idKey(itemId);
    for (const entry of tickets) {
      const row = entry.rows.get(id);
      if (row !== undefined) {
        return { rows: entry.rows, id, row };
      }
    }
    return null;
  };

  for (const { record, at } of unshown(records, read.readAt)) {
    switch (record.kind) {
      case 'order_item_prepare': {
        const found = find(record.payload.itemId);
        if (found === null || found.row.preparedAt !== null || found.row.removedAt !== null) {
          break;
        }
        if (at === 'acked') {
          found.rows.delete(found.id);
        } else {
          found.rows.set(found.id, withLocal(found.row, { preparing: at }));
        }
        break;
      }

      case 'order_item_remove': {
        const found = find(record.payload.itemId);
        if (found === null || found.row.removedAt !== null || found.row.local.removing !== null) {
          break;
        }
        if (at === 'acked') {
          found.rows.delete(found.id);
        } else {
          found.rows.set(
            found.id,
            withLocal(found.row, {
              removing: { sync: at, reason: record.payload.reason, cause: 'remove' },
            }),
          );
        }
        break;
      }

      case 'order_cancel': {
        const { payload } = record;
        for (const entry of tickets) {
          if (entry.ticket.tableId !== payload.tableId) {
            continue;
          }
          if (at === 'acked') {
            const cancelled = record.result?.orderId;
            if (cancelled === undefined || entry.ticket.orderId === cancelled) {
              entry.rows.clear();
            }
            continue;
          }
          for (const [id, row] of entry.rows) {
            if (row.removedAt === null && row.local.removing === null) {
              entry.rows.set(
                id,
                withLocal(row, { removing: { sync: at, reason: payload.reason, cause: 'cancel' } }),
              );
            }
          }
        }
        break;
      }

      // A paid dish still has to be made, so a payment changes nothing on the kitchen's board either.
      case 'order_item_add':
      case 'order_send':
      case 'sale':
        break;
    }
  }

  return tickets
    .filter((entry) => entry.rows.size > 0)
    .map(({ ticket, rows }) => ({
      orderId: ticket.orderId,
      tableId: ticket.tableId,
      tableName: ticket.tableName,
      sentAt: ticket.sentAt,
      items: [...rows.values()],
    }));
}

/**
 * Which table each row is on, as far as this device knows: every row it added — the add names the
 * table — and every row of the orders it has read. A removal or a prepare names only a row, and
 * this is how the grid finds the table to flag.
 */
export function rowTables(
  records: readonly OutboxRecord[],
  orders: readonly (OpenOrder | null)[],
): ReadonlyMap<string, string> {
  const tables = new Map<string, string>();
  for (const order of orders) {
    if (order === null) {
      continue;
    }
    for (const item of order.items) {
      tables.set(idKey(item.id), order.tableId);
    }
  }
  for (const record of records) {
    if (record.kind === 'order_item_add') {
      tables.set(idKey(record.payload.id), record.payload.tableId);
    }
  }
  return tables;
}

/**
 * The tables a grid read at `readAt` may not show this device's changes on, with how many of those
 * changes are waiting and refused. A table with only acked changes is listed with none: its tile is
 * still drawn from its order until the grid is read again. A removal or a prepare whose row this
 * device cannot place on a table is left out; the table's own screen shows it.
 */
export function changedTables(
  records: readonly OutboxRecord[],
  readAt: number,
  tables: ReadonlyMap<string, string>,
): ReadonlyMap<string, LocalChanges> {
  const changed = new Map<string, LocalChanges>();
  for (const { record, at } of unshown(records, readAt)) {
    const tableId =
      record.kind === 'order_item_remove' || record.kind === 'order_item_prepare'
        ? tables.get(idKey(record.payload.itemId))
        : record.payload.tableId;
    // A payment names its table, so it flags the tile like any change to the table.
    if (tableId === undefined) {
      continue;
    }
    const current = changed.get(tableId) ?? NO_CHANGES;
    changed.set(tableId, {
      pending: current.pending + (at === 'pending' ? 1 : 0),
      conflicts: current.conflicts + (at === 'conflict' ? 1 : 0),
    });
  }
  return changed;
}
