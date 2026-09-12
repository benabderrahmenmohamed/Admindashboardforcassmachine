import { AppError } from '@/lib/errors';
import { add, mulQty, type Millimes } from '@/lib/money';
import {
  diningTableInputSchema,
  removedAfterSentQuerySchema,
  type DiningTable,
  type KitchenTicket,
  type OpenOrder,
  type OpenOrderItem,
  type OrderItemAddResult,
  type OrdersPort,
  type OrderWriteResult,
  type RemovedAfterSent,
  type Role,
} from '@/ports';
import type { MemoryProfile } from './seed';
import {
  orderCancelInput,
  orderItemAddInput,
  orderItemPrepareInput,
  orderItemRemoveInput,
  orderSendInput,
} from './shapes';
import type {
  DiningTableRow,
  MemoryStore,
  OpenOrderItemRow,
  OpenOrderRow,
  OrderRecordKind,
  OrderRecordRow,
  ProductRow,
} from './store';
import {
  freshId,
  invalidField,
  parseInput,
  parseTimestamp,
  parseUuid,
  perform,
  replayOf,
  requireProfile,
  type MemoryContext,
} from './support';

/**
 * Frees a table that has nothing left to pay, as private.close_order_if_settled: an order with a
 * payment on it and no active unpaid item closes. Called after every payment and after a removal,
 * because taking the last unpaid item off a table frees it just as paying for it does. An order
 * where everything was taken off and nothing paid stays open: the guests are still there.
 */
export function closeIfSettled(store: MemoryStore, orderId: string, closedAt: string): boolean {
  const order = store.openOrders.get(orderId);
  if (!order || order.status !== 'open') {
    return false;
  }
  let paid = false;
  for (const item of store.openOrderItems.values()) {
    if (item.orderId !== orderId) {
      continue;
    }
    if (item.removedAt === null && item.paidSaleId === null) {
      return false;
    }
    paid = paid || item.paidSaleId !== null;
  }
  if (!paid) {
    return false;
  }
  store.openOrders.set(order.id, { ...order, status: 'closed', closedAt });
  return true;
}

/**
 * Who may work a table. A waiter takes the orders, the counter takes them too when a guest orders
 * there, and the admin can always step in; the kitchen only prepares what it was sent.
 */
const TABLE_ROLES: readonly Role[] = ['admin', 'cashier', 'waiter'];
/** Marking an item prepared belongs to the kitchen; the admin can unstick a screen. */
const PREPARE_ROLES: readonly Role[] = ['admin', 'kitchen'];
/** Cancelling a whole table is a money decision, so it goes with the register, as a refund does. */
const CANCEL_ROLES: readonly Role[] = ['admin', 'cashier'];

/**
 * Open orders, as order_item_add, order_item_remove, order_send, order_item_prepare and
 * order_cancel: what is on the tables right now, which is working state and not the ledger. The
 * ledger takes over at payment, and `paidSaleId` on an item is the link between the two.
 *
 * Every write is a record a device wrote, possibly offline, and may arrive twice: the id and the
 * payload hash decide a replay exactly as they do for a sale, and every write answers before its
 * own rules could refuse it. A write names the table, never an order, so two devices adding to the
 * same free table cannot race on creating one.
 */
export function createMemoryOrders(context: MemoryContext): OrdersPort {
  const { store } = context;

  function tableView(row: DiningTableRow): DiningTable {
    return { id: row.id, name: row.name, sortOrder: row.sortOrder, isActive: row.isActive };
  }

  function itemView(row: OpenOrderItemRow): OpenOrderItem {
    return {
      id: row.id,
      orderId: row.orderId,
      productId: row.productId,
      nameSnapshot: row.nameSnapshot,
      unitPriceMillimes: row.unitPriceMillimes,
      qty: row.qty,
      note: row.note,
      addedBy: row.addedBy,
      addedAt: row.addedAt,
      sentAt: row.sentAt,
      preparedAt: row.preparedAt,
      removedAt: row.removedAt,
      removedBy: row.removedBy,
      removedReason: row.removedReason,
      paidSaleId: row.paidSaleId,
    };
  }

  /** The order's items in the order they were added, removed and paid ones included. */
  function itemsOf(orderId: string): OpenOrderItemRow[] {
    return Array.from(store.openOrderItems.values()).filter((item) => item.orderId === orderId);
  }

  function orderView(order: OpenOrderRow): OpenOrder {
    return {
      id: order.id,
      tableId: order.tableId,
      status: order.status,
      openedAt: order.openedAt,
      closedAt: order.closedAt,
      items: itemsOf(order.id).map(itemView),
    };
  }

  function tablesOf(shopId: string): DiningTableRow[] {
    return Array.from(store.diningTables.values())
      .filter((table) => table.shopId === shopId)
      .sort((a, b) => a.sortOrder - b.sortOrder || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  function tableName(tableId: string): string {
    return store.diningTables.get(tableId)?.name ?? '';
  }

  /**
   * Two tables of one café cannot share a name, as dining_tables' unique (shop_id, name): a save that
   * would give `tableId` (null for a new table) the name of another is VALIDATION_ERROR on the name,
   * as migration 20260913000014 answers it.
   */
  function requireFreeName(shopId: string, name: string, tableId: string | null): void {
    const taken = tablesOf(shopId).some((table) => table.name === name && table.id !== tableId);
    if (taken) {
      throw invalidField('name', 'Another table already has this name.');
    }
  }

  /** The table's order while it is open, which is what makes the table busy. */
  function openOrderOf(shopId: string, tableId: string): OpenOrderRow | undefined {
    for (const order of store.openOrders.values()) {
      if (order.shopId === shopId && order.tableId === tableId && order.status === 'open') {
        return order;
      }
    }
    return undefined;
  }

  /**
   * The table a record names, as private.lock_table: one of the caller's shop, in service when the
   * write puts something new on it. Locking is what makes lazy creation safe in the database;
   * memory calls run one at a time, so there is nothing to lock.
   */
  function tableFor(
    profile: MemoryProfile,
    tableId: string,
    requireActive: boolean,
  ): DiningTableRow {
    const id = parseUuid(tableId, 'table_id');
    const table = store.diningTables.get(id);
    if (!table || table.shopId !== profile.shopId) {
      throw new AppError('FORBIDDEN', 'This table is not in your shop.', {
        details: { tableId: id },
      });
    }
    if (requireActive && !table.isActive) {
      throw new AppError('TABLE_INACTIVE', 'This table is not in service.', {
        details: { tableId: id },
      });
    }
    return table;
  }

  /**
   * The product an add names. Being sold out (`available` false) does not refuse it: availability
   * is what the menu shows, and a waiter who already promised a guest a coffee must be able to put
   * it on the table.
   */
  function menuItem(profile: MemoryProfile, productId: string): ProductRow {
    const id = parseUuid(productId, 'product_id');
    const product = store.products.get(id);
    if (!product || product.shopId !== profile.shopId || product.archivedAt !== null) {
      throw new AppError('NOT_FOUND', 'The product does not exist.', {
        details: { productId: id },
      });
    }
    return product;
  }

  function itemOf(profile: MemoryProfile, itemId: string): OpenOrderItemRow {
    const id = parseUuid(itemId, 'item_id');
    const item = store.openOrderItems.get(id);
    if (!item || item.shopId !== profile.shopId) {
      throw new AppError('ITEM_NOT_FOUND', 'This item is not on any table.', {
        details: { itemId: id },
      });
    }
    return item;
  }

  function orderOf(item: OpenOrderItemRow): OpenOrderRow {
    const order = store.openOrders.get(item.orderId);
    if (!order) {
      throw new AppError('UNKNOWN', `The item ${item.id} names an order that does not exist`);
    }
    return order;
  }

  function orderChanged(message: string, item: OpenOrderItemRow, order: OpenOrderRow): AppError {
    return new AppError('ORDER_CHANGED', message, {
      details: { itemId: item.id, orderId: order.id, tableId: order.tableId },
    });
  }

  function orderClosed(tableId: string, orderId: string | null): AppError {
    return new AppError('ORDER_CLOSED', 'This table has no open order any more.', {
      details: orderId === null ? { tableId } : { tableId, orderId },
    });
  }

  /** What every order record is recognised by, with its id in the form the database stores. */
  interface RecordStamp {
    readonly id: string;
    readonly deviceId: string;
    readonly payloadHash: string;
  }

  function stampOf(input: RecordStamp): RecordStamp {
    return { ...input, id: input.id.toLowerCase() };
  }

  function remember(
    stamp: RecordStamp,
    profile: MemoryProfile,
    kind: OrderRecordKind,
    outcome: { readonly orderId: string; readonly itemId?: string; readonly affected: number },
  ): void {
    store.orderRecords.set(stamp.id, {
      id: stamp.id,
      shopId: profile.shopId,
      kind,
      deviceId: stamp.deviceId,
      payloadHash: stamp.payloadHash,
      orderId: outcome.orderId,
      itemId: outcome.itemId ?? null,
      affected: outcome.affected,
      productId: null,
      stockQty: null,
      receivedAt: context.now().toISOString(),
    });
  }

  function storedItemId(stored: OrderRecordRow): string {
    if (stored.itemId === null) {
      throw new AppError('UNKNOWN', `The stored add ${stored.id} has no item`);
    }
    return stored.itemId;
  }

  /** The order a stored order write touched. A record of those kinds always names one. */
  function storedOrderId(stored: OrderRecordRow): string {
    if (stored.orderId === null) {
      throw new AppError('UNKNOWN', `The stored record ${stored.id} has no order`);
    }
    return stored.orderId;
  }

  /** What is still owed on an order: its active, unpaid items at the price snapshotted for each. */
  function dueOf(items: readonly OpenOrderItemRow[]): Millimes {
    return add(
      ...items
        .filter((item) => item.removedAt === null && item.paidSaleId === null)
        .map((item) => mulQty(item.unitPriceMillimes, item.qty)),
    );
  }

  return {
    listTables: () =>
      perform(context, 'orders.listTables', () => {
        const profile = requireProfile(context);
        return tablesOf(profile.shopId).map(tableView);
      }),

    createTable: (input) =>
      perform(context, 'orders.createTable', () => {
        const profile = requireProfile(context, ['admin']);
        const fields = parseInput(diningTableInputSchema, input);
        requireFreeName(profile.shopId, fields.name, null);
        const row: DiningTableRow = {
          id: freshId(context, store.diningTables),
          shopId: profile.shopId,
          name: fields.name,
          sortOrder: fields.sortOrder,
          isActive: fields.isActive,
        };
        store.diningTables.set(row.id, row);
        context.emit(profile.shopId, 'dining_tables');
        return tableView(row);
      }),

    updateTable: (id, input) =>
      perform(context, 'orders.updateTable', () => {
        const profile = requireProfile(context, ['admin']);
        const tableId = parseUuid(id, 'id');
        const fields = parseInput(diningTableInputSchema, input);
        const existing = store.diningTables.get(tableId);
        if (!existing || existing.shopId !== profile.shopId) {
          throw new AppError('NOT_FOUND', 'The table does not exist.', { details: { tableId } });
        }
        requireFreeName(profile.shopId, fields.name, tableId);
        // Retired, never deleted: a sale paid at this table keeps its name, and an order already
        // open on it stays open — the guests are still sitting there.
        const row: DiningTableRow = {
          ...existing,
          name: fields.name,
          sortOrder: fields.sortOrder,
          isActive: fields.isActive,
        };
        store.diningTables.set(tableId, row);
        context.emit(profile.shopId, 'dining_tables');
        return tableView(row);
      }),

    board: () =>
      perform(context, 'orders.board', () => {
        const profile = requireProfile(context);
        return tablesOf(profile.shopId)
          .filter((table) => table.isActive)
          .map((table) => {
            const order = openOrderOf(profile.shopId, table.id);
            const items = order === undefined ? [] : itemsOf(order.id);
            const active = items.filter((item) => item.removedAt === null);
            return {
              table: tableView(table),
              orderId: order?.id ?? null,
              openedAt: order?.openedAt ?? null,
              dueMillimes: dueOf(active),
              activeCount: active.length,
              unsentCount: active.filter((item) => item.sentAt === null).length,
              unpaidCount: active.filter((item) => item.paidSaleId === null).length,
            };
          });
      }),

    openOrder: (tableId) =>
      perform(context, 'orders.openOrder', (): OpenOrder | null => {
        const profile = requireProfile(context);
        const id = parseUuid(tableId, 'table_id');
        const order = openOrderOf(profile.shopId, id);
        return order === undefined ? null : orderView(order);
      }),

    kitchenTickets: () =>
      perform(context, 'orders.kitchenTickets', () => {
        const profile = requireProfile(context);
        // One ticket per send: the items a waiter told the kitchen about at the same moment, oldest
        // send first and each in the order it was added. A paid table keeps its ticket, because the
        // coffee still has to be made; a cancelled one loses it, because its items left the table
        // with it.
        const waiting = Array.from(store.openOrderItems.values())
          .filter(
            (item) =>
              item.shopId === profile.shopId &&
              item.sentAt !== null &&
              item.preparedAt === null &&
              item.removedAt === null &&
              store.openOrders.get(item.orderId)?.status !== 'cancelled',
          )
          .sort(
            (a, b) =>
              Date.parse(a.sentAt ?? '') - Date.parse(b.sentAt ?? '') ||
              Date.parse(a.addedAt) - Date.parse(b.addedAt),
          );
        const tickets = new Map<string, KitchenTicket>();
        for (const item of waiting) {
          const { sentAt } = item;
          const order = store.openOrders.get(item.orderId);
          if (!order || sentAt === null) {
            continue;
          }
          const key = `${item.orderId} ${sentAt}`;
          const ticket = tickets.get(key);
          if (ticket) {
            ticket.items.push(itemView(item));
          } else {
            tickets.set(key, {
              orderId: order.id,
              tableId: order.tableId,
              tableName: tableName(order.tableId),
              sentAt,
              items: [itemView(item)],
            });
          }
        }
        return Array.from(tickets.values());
      }),

    removedAfterSent: (query) =>
      perform(context, 'orders.removedAfterSent', () => {
        const profile = requireProfile(context, ['admin']);
        const range = parseInput(removedAfterSentQuerySchema, query);
        const from = Date.parse(parseTimestamp(range.from, 'from'));
        const to = Date.parse(parseTimestamp(range.to, 'to'));
        if (to < from) {
          throw invalidField('to', 'The end of the period cannot be before its start.');
        }
        const removed: RemovedAfterSent[] = [];
        for (const item of store.openOrderItems.values()) {
          const { sentAt, removedAt, removedBy, removedReason } = item;
          if (
            item.shopId !== profile.shopId ||
            sentAt === null ||
            removedAt === null ||
            removedBy === null
          ) {
            continue;
          }
          const at = Date.parse(removedAt);
          if (at < from || at > to) {
            continue;
          }
          const order = store.openOrders.get(item.orderId);
          removed.push({
            itemId: item.id,
            tableName: order === undefined ? '' : tableName(order.tableId),
            productName: item.nameSnapshot,
            qty: item.qty,
            unitPriceMillimes: item.unitPriceMillimes,
            sentAt,
            removedAt,
            removedBy,
            removedByName: store.profiles.get(removedBy)?.displayName ?? '',
            removedReason: removedReason ?? '',
          });
        }
        // Newest first, as a report of a shift is read.
        return removed.sort(
          (a, b) =>
            Date.parse(b.removedAt) - Date.parse(a.removedAt) ||
            (a.itemId < b.itemId ? -1 : a.itemId > b.itemId ? 1 : 0),
        );
      }),

    addItem: (record) =>
      perform(context, 'orders.addItem', (): OrderItemAddResult => {
        const profile = requireProfile(context, TABLE_ROLES);
        const input = parseInput(orderItemAddInput, record);
        const stamp = stampOf(input);
        const replay = replayOf(store, profile, 'order_item_add', stamp.id, stamp.payloadHash);
        if (replay) {
          return {
            status: 'replayed',
            orderId: storedOrderId(replay),
            itemId: storedItemId(replay),
          };
        }
        if (store.openOrderItems.has(stamp.id)) {
          // The item id is the record id, so this id already being a line means another record of
          // the same id landed, as the database's unique violation does.
          throw new AppError(
            'IDEMPOTENCY_CONFLICT',
            'A different record was already stored under this id.',
            { details: { id: stamp.id } },
          );
        }
        const table = tableFor(profile, input.tableId, true);
        const product = menuItem(profile, input.productId);
        if (input.qty < 1) {
          throw invalidField('qty', 'A quantity is at least one.');
        }
        const addedAt = parseTimestamp(input.createdAt, 'added_at');

        // The table's order, or a new one. A closed order means the table is free again, so an add
        // that arrives after the caisse paid opens the next order with that item rather than
        // losing it: the caisse then sees one unpaid item instead of a guest walking out with it.
        const existing = openOrderOf(profile.shopId, table.id);
        const order: OpenOrderRow = existing ?? {
          id: freshId(context, store.openOrders),
          shopId: profile.shopId,
          tableId: table.id,
          status: 'open',
          openedAt: addedAt,
          closedAt: null,
          cancelledReason: null,
        };
        if (existing === undefined) {
          store.openOrders.set(order.id, order);
        }
        const item: OpenOrderItemRow = {
          // The item is the record: one add is one line, so a replay can never insert a second.
          id: stamp.id,
          shopId: profile.shopId,
          orderId: order.id,
          productId: product.id,
          // Snapshots: a price change tonight never moves what a guest ordered this afternoon.
          nameSnapshot: product.name,
          unitPriceMillimes: product.priceMillimes,
          qty: input.qty,
          note: input.note,
          addedBy: profile.userId,
          addedAt,
          sentAt: null,
          preparedAt: null,
          removedAt: null,
          removedBy: null,
          removedReason: null,
          paidSaleId: null,
        };
        store.openOrderItems.set(item.id, item);
        remember(stamp, profile, 'order_item_add', {
          orderId: order.id,
          itemId: item.id,
          affected: 1,
        });
        if (existing === undefined) {
          context.emit(profile.shopId, 'open_orders');
        }
        context.emit(profile.shopId, 'open_order_items');
        return { status: 'created', orderId: order.id, itemId: item.id };
      }),

    removeItem: (record) =>
      perform(context, 'orders.removeItem', (): OrderWriteResult => {
        const profile = requireProfile(context, TABLE_ROLES);
        const input = parseInput(orderItemRemoveInput, record);
        const stamp = stampOf(input);
        const replay = replayOf(store, profile, 'order_item_remove', stamp.id, stamp.payloadHash);
        if (replay) {
          return { status: 'replayed', orderId: storedOrderId(replay), affected: replay.affected };
        }
        const reason = input.reason.trim();
        if (reason === '') {
          throw invalidField('reason', 'Say why the item is being removed.');
        }
        const item = itemOf(profile, input.itemId);
        const order = orderOf(item);
        if (item.paidSaleId !== null) {
          throw orderChanged('This item has already been paid for.', item, order);
        }
        if (order.status !== 'open') {
          throw orderClosed(order.tableId, order.id);
        }
        // Taking off an item that is already off the table changes nothing, and must never stop a
        // waiter's queue: the first removal, with its reason and its author, is the one that counts.
        const affected = item.removedAt === null ? 1 : 0;
        if (affected === 1) {
          // The row stays: what the admin reads in the report is what was removed after being sent.
          store.openOrderItems.set(item.id, {
            ...item,
            removedAt: context.now().toISOString(),
            removedBy: profile.userId,
            removedReason: reason,
          });
          // Taking the last unpaid item off a table that has paid for the rest frees it, exactly as
          // paying for that item would have.
          if (closeIfSettled(store, order.id, context.now().toISOString())) {
            context.emit(profile.shopId, 'open_orders');
          }
          context.emit(profile.shopId, 'open_order_items');
        }
        remember(stamp, profile, 'order_item_remove', { orderId: order.id, affected });
        return { status: 'created', orderId: order.id, affected };
      }),

    send: (record) =>
      perform(context, 'orders.send', (): OrderWriteResult => {
        const profile = requireProfile(context, TABLE_ROLES);
        const input = parseInput(orderSendInput, record);
        const stamp = stampOf(input);
        const replay = replayOf(store, profile, 'order_send', stamp.id, stamp.payloadHash);
        if (replay) {
          return { status: 'replayed', orderId: storedOrderId(replay), affected: replay.affected };
        }
        // A table retired while guests were sitting at it can still be sent for: what the admin
        // took off the list is the table, not the people at it.
        const table = tableFor(profile, input.tableId, false);
        const order = openOrderOf(profile.shopId, table.id);
        if (order === undefined) {
          throw orderClosed(table.id, null);
        }
        // One send is one ticket: every item that is still on the table and has not been sent gets
        // the same stamp, so the kitchen reads them as one order.
        const sentAt = parseTimestamp(input.createdAt, 'sent_at');
        const pending = itemsOf(order.id).filter(
          (item) => item.removedAt === null && item.sentAt === null,
        );
        for (const item of pending) {
          store.openOrderItems.set(item.id, { ...item, sentAt });
        }
        remember(stamp, profile, 'order_send', { orderId: order.id, affected: pending.length });
        if (pending.length > 0) {
          context.emit(profile.shopId, 'open_order_items');
        }
        return { status: 'created', orderId: order.id, affected: pending.length };
      }),

    prepareItem: (record) =>
      perform(context, 'orders.prepareItem', (): OrderWriteResult => {
        const profile = requireProfile(context, PREPARE_ROLES);
        const input = parseInput(orderItemPrepareInput, record);
        const stamp = stampOf(input);
        const replay = replayOf(store, profile, 'order_item_prepare', stamp.id, stamp.payloadHash);
        if (replay) {
          return { status: 'replayed', orderId: storedOrderId(replay), affected: replay.affected };
        }
        const item = itemOf(profile, input.itemId);
        const order = orderOf(item);
        // An item the kitchen was never told about, or one taken off the table while it cooked:
        // the screen is out of date, which is what ORDER_CHANGED means. A paid table is not: the
        // coffee still has to be made.
        if (item.sentAt === null || item.removedAt !== null) {
          throw orderChanged('That item is no longer on the kitchen screen.', item, order);
        }
        // Two cooks tapping the same line is not a conflict: the first stamp stands and the second
        // write changes nothing, so a kitchen screen is never stuck on a line somebody else took.
        const affected = item.preparedAt === null ? 1 : 0;
        if (affected === 1) {
          store.openOrderItems.set(item.id, {
            ...item,
            preparedAt: context.now().toISOString(),
          });
          context.emit(profile.shopId, 'open_order_items');
        }
        remember(stamp, profile, 'order_item_prepare', { orderId: order.id, affected });
        return { status: 'created', orderId: order.id, affected };
      }),

    cancelOrder: (record) =>
      perform(context, 'orders.cancelOrder', (): OrderWriteResult => {
        const profile = requireProfile(context, CANCEL_ROLES);
        const input = parseInput(orderCancelInput, record);
        const stamp = stampOf(input);
        const replay = replayOf(store, profile, 'order_cancel', stamp.id, stamp.payloadHash);
        if (replay) {
          return { status: 'replayed', orderId: storedOrderId(replay), affected: replay.affected };
        }
        const reason = input.reason.trim();
        if (reason === '') {
          throw invalidField('reason', 'Say why the order is being cancelled.');
        }
        const table = tableFor(profile, input.tableId, false);
        const order = openOrderOf(profile.shopId, table.id);
        if (order === undefined) {
          throw orderClosed(table.id, null);
        }
        const items = itemsOf(order.id);
        // A paid item is in the ledger; only a refund can undo it, so the whole table cannot be
        // dropped behind the register's back.
        const paid = items.find((item) => item.paidSaleId !== null);
        if (paid) {
          throw orderChanged('Part of this order has already been paid for.', paid, order);
        }
        // Everything still on the table is taken off it, with the cancel's reason: a cancelled
        // order that had been sent still reaches the removed-after-sent report.
        const removedAt = context.now().toISOString();
        const active = items.filter((item) => item.removedAt === null);
        for (const item of active) {
          store.openOrderItems.set(item.id, {
            ...item,
            removedAt,
            removedBy: profile.userId,
            removedReason: reason,
          });
        }
        store.openOrders.set(order.id, {
          ...order,
          status: 'cancelled',
          closedAt: removedAt,
          cancelledReason: reason,
        });
        remember(stamp, profile, 'order_cancel', { orderId: order.id, affected: active.length });
        context.emit(profile.shopId, 'open_orders');
        if (active.length > 0) {
          // The kitchen drops the tickets of a cancelled table.
          context.emit(profile.shopId, 'open_order_items');
        }
        return { status: 'created', orderId: order.id, affected: active.length };
      }),
  };
}
