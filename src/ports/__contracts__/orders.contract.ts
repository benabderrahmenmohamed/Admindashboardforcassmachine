import { beforeEach, describe, expect, it } from 'vitest';
import { mm } from '@/lib/money';
import type { DiningTable, KitchenTicket, OpenOrderItem, TableBoardEntry } from '@/ports';
import type { ContractFixture, MakeFixture } from './fixture';
import {
  addToTable,
  createProduct,
  deviceId,
  editOf,
  failure,
  newId,
  openTill,
  orderRecord,
  tablePaymentRecord,
  timestamp,
} from './support';

/** A moment in the past, so two sends never land in the same millisecond and share a ticket. */
function minutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

/** The board entry of one table. Other tables of the shop are none of a test's business. */
async function boardEntry(fixture: ContractFixture, table: DiningTable): Promise<TableBoardEntry> {
  const board = await fixture.waiter.orders.board();
  const entry = board.find((candidate) => candidate.table.id === table.id);
  if (!entry) {
    return expect.unreachable(`The board does not show table ${table.name}`);
  }
  return entry;
}

/** The kitchen's tickets for one order, oldest send first. */
async function ticketsFor(fixture: ContractFixture, orderId: string): Promise<KitchenTicket[]> {
  const tickets = await fixture.kitchen.orders.kitchenTickets();
  return tickets.filter((ticket) => ticket.orderId === orderId);
}

/** The item as the table shows it now. */
async function itemOnTable(
  fixture: ContractFixture,
  table: DiningTable,
  itemId: string,
): Promise<OpenOrderItem | undefined> {
  const order = await fixture.waiter.orders.openOrder(table.id);
  return order?.items.find((candidate) => candidate.id === itemId);
}

/**
 * Open orders: what is on the tables right now. The database defines the semantics (docs/spec.md,
 * contracts/errors.md); every adapter runs this suite unchanged.
 */
export function describeOrdersPortContract(makeFixture: MakeFixture): void {
  describe('OrdersPort contract', () => {
    let fixture: ContractFixture;

    beforeEach(async () => {
      fixture = await makeFixture();
    });

    it('lists the shop tables in the admin order and shows every active one on the board', async () => {
      const tables = await fixture.waiter.orders.listTables();
      expect(tables.length).toBeGreaterThan(0);
      expect([...tables].sort((a, b) => a.sortOrder - b.sortOrder)).toEqual(tables);

      const board = await fixture.cashier.orders.board();
      expect(board.map((entry) => entry.table)).toEqual(tables.filter((table) => table.isActive));
      const table = await fixture.newTable();
      expect(await boardEntry(fixture, table)).toEqual({
        table,
        orderId: null,
        openedAt: null,
        dueMillimes: 0,
        activeCount: 0,
        unsentCount: 0,
        unpaidCount: 0,
      });
      await expect(fixture.waiter.orders.openOrder(table.id)).resolves.toBeNull();
    });

    it('lets the admin rename, move and retire a table, but never give it the name of another', async () => {
      const table = await fixture.newTable();
      const other = await fixture.newTable();

      const retired = await fixture.admin.orders.updateTable(table.id, {
        name: `  ${table.name} bis  `,
        sortOrder: table.sortOrder + 1,
        isActive: false,
      });
      expect(retired).toEqual({
        id: table.id,
        name: `${table.name} bis`,
        sortOrder: table.sortOrder + 1,
        isActive: false,
      });
      expect(await fixture.waiter.orders.listTables()).toContainEqual(retired);
      const board = await fixture.cashier.orders.board();
      expect(board.map((entry) => entry.table.id)).not.toContain(table.id);

      const added = await failure(
        fixture.admin.orders.createTable({ name: other.name, sortOrder: 0, isActive: true }),
        'VALIDATION_ERROR',
      );
      expect(added.details).toMatchObject({ field: 'name' });
      const renamed = await failure(
        fixture.admin.orders.updateTable(retired.id, {
          name: other.name,
          sortOrder: retired.sortOrder,
          isActive: false,
        }),
        'VALIDATION_ERROR',
      );
      expect(renamed.details).toMatchObject({ field: 'name' });
      // A table saved under the name it already has is not in its own way.
      await expect(
        fixture.admin.orders.updateTable(other.id, {
          name: other.name,
          sortOrder: other.sortOrder + 1,
          isActive: true,
        }),
      ).resolves.toMatchObject({ id: other.id, name: other.name });

      await failure(
        fixture.waiter.orders.createTable({
          name: `${other.name} ter`,
          sortOrder: 0,
          isActive: true,
        }),
        'FORBIDDEN',
      );
    });

    it('opens the order of a free table once, whichever device gets there first', async () => {
      const table = await fixture.newTable();
      const coffee = await createProduct(fixture, 'Express', 1_900);
      const water = await createProduct(fixture, 'Eau', 850);

      // Two devices add to the same free table. Neither names an order, so neither can create a
      // second one: the server finds the table's order or opens it.
      const first = await fixture.waiter.orders.addItem(
        await orderRecord(
          { tableId: table.id, productId: coffee.id, qty: 2, note: '' },
          { deviceId: deviceId('phone') },
        ),
      );
      const second = await fixture.cashier.orders.addItem(
        await orderRecord(
          { tableId: table.id, productId: water.id, qty: 1, note: 'Sans glaçons' },
          { deviceId: deviceId('caisse') },
        ),
      );

      expect(second.orderId).toBe(first.orderId);
      expect(second.itemId).not.toBe(first.itemId);
      const order = await fixture.waiter.orders.openOrder(table.id);
      expect(order).toMatchObject({ id: first.orderId, tableId: table.id, status: 'open' });
      expect(order?.items.map((item) => item.id)).toEqual([first.itemId, second.itemId]);
      expect(await boardEntry(fixture, table)).toMatchObject({
        orderId: first.orderId,
        dueMillimes: 2 * 1_900 + 850,
        activeCount: 2,
        unsentCount: 2,
        unpaidCount: 2,
      });
    });

    it('snapshots the name and the price when the item is added, so a later change never moves it', async () => {
      const table = await fixture.newTable();
      const product = await createProduct(fixture, 'Thé', 2_100);
      const item = await addToTable(fixture, table, product, 3, 'Bien chaud');

      expect(item).toMatchObject({
        productId: product.id,
        nameSnapshot: product.name,
        unitPriceMillimes: 2_100,
        qty: 3,
        note: 'Bien chaud',
        addedBy: fixture.waiterUser.id,
        sentAt: null,
        preparedAt: null,
        removedAt: null,
        removedBy: null,
        removedReason: null,
        paidSaleId: null,
      });

      await fixture.admin.catalog.updateProduct(product.id, {
        ...editOf(product, 0),
        name: `${product.name} (new)`,
        priceMillimes: mm(2_600),
      });

      expect(await itemOnTable(fixture, table, item.id)).toEqual(item);
      expect(await boardEntry(fixture, table)).toMatchObject({ dueMillimes: 3 * 2_100 });
    });

    it('sends every unsent item of the table at once, and one send is one kitchen ticket', async () => {
      const table = await fixture.newTable();
      const coffee = await createProduct(fixture, 'Express', 1_900);
      const cake = await createProduct(fixture, 'Bambalouni', 450);
      const first = await addToTable(fixture, table, coffee, 2);
      const second = await addToTable(fixture, table, cake);

      const sentAt = minutesAgo(10);
      const sent = await fixture.waiter.orders.send(
        await orderRecord({ tableId: table.id }, { createdAt: sentAt }),
      );
      expect(sent).toEqual({ status: 'created', orderId: first.orderId, affected: 2 });

      // A third item lands after the send and waits for the next one.
      const third = await addToTable(fixture, table, coffee);
      expect(await boardEntry(fixture, table)).toMatchObject({ activeCount: 3, unsentCount: 1 });
      const again = await fixture.waiter.orders.send(
        await orderRecord({ tableId: table.id }, { createdAt: minutesAgo(5) }),
      );
      expect(again.affected).toBe(1);
      // Nothing is left unsent, so a third send stamps nothing and is not an error.
      await expect(
        fixture.waiter.orders.send(await orderRecord({ tableId: table.id })),
      ).resolves.toMatchObject({ status: 'created', affected: 0 });

      const tickets = await ticketsFor(fixture, first.orderId);
      expect(tickets).toHaveLength(2);
      expect(tickets[0]).toMatchObject({ tableId: table.id, tableName: table.name, sentAt });
      expect(tickets[0].items.map((item) => item.id)).toEqual([first.id, second.id]);
      expect(tickets[1].items.map((item) => item.id)).toEqual([third.id]);
      expect(await boardEntry(fixture, table)).toMatchObject({ activeCount: 3, unsentCount: 0 });
    });

    it('lets the kitchen mark an item prepared, which takes it off the ticket and leaves it on the table', async () => {
      const table = await fixture.newTable();
      const product = await createProduct(fixture, 'Express', 1_900);
      const item = await addToTable(fixture, table, product);
      await fixture.waiter.orders.send(await orderRecord({ tableId: table.id }));

      const prepared = await fixture.kitchen.orders.prepareItem(
        await orderRecord({ itemId: item.id }),
      );

      expect(prepared).toEqual({ status: 'created', orderId: item.orderId, affected: 1 });
      expect(await ticketsFor(fixture, item.orderId)).toEqual([]);
      const onTable = await itemOnTable(fixture, table, item.id);
      expect(onTable?.preparedAt).not.toBeNull();
      expect(await boardEntry(fixture, table)).toMatchObject({ activeCount: 1, unpaidCount: 1 });
    });

    it('keeps the row of a removed item and reports the ones removed after the kitchen was told', async () => {
      const table = await fixture.newTable();
      const product = await createProduct(fixture, 'Express', 1_900);
      const sentItem = await addToTable(fixture, table, product, 2);
      const sentAt = minutesAgo(10);
      await fixture.waiter.orders.send(
        await orderRecord({ tableId: table.id }, { createdAt: sentAt }),
      );
      const unsentItem = await addToTable(fixture, table, product);

      const removed = await fixture.waiter.orders.removeItem(
        await orderRecord({ itemId: sentItem.id, reason: 'The guest sent it back' }),
      );
      await fixture.waiter.orders.removeItem(
        await orderRecord({ itemId: unsentItem.id, reason: 'Ordered by mistake' }),
      );

      expect(removed).toEqual({ status: 'created', orderId: sentItem.orderId, affected: 1 });
      const row = await itemOnTable(fixture, table, sentItem.id);
      expect(row).toMatchObject({
        qty: 2,
        sentAt,
        removedBy: fixture.waiterUser.id,
        removedReason: 'The guest sent it back',
      });
      expect(row?.removedAt).not.toBeNull();
      expect(await ticketsFor(fixture, sentItem.orderId)).toEqual([]);
      expect(await boardEntry(fixture, table)).toMatchObject({
        orderId: sentItem.orderId,
        dueMillimes: 0,
        activeCount: 0,
      });

      const report = await fixture.admin.orders.removedAfterSent({
        from: minutesAgo(60),
        to: timestamp(),
      });
      expect(report.find((line) => line.itemId === sentItem.id)).toEqual({
        itemId: sentItem.id,
        tableName: table.name,
        productName: product.name,
        qty: 2,
        unitPriceMillimes: 1_900,
        sentAt,
        removedAt: row?.removedAt,
        removedBy: fixture.waiterUser.id,
        removedByName: fixture.waiterUser.name,
        removedReason: 'The guest sent it back',
        submittedBy: fixture.waiterUser.id,
        submittedByName: fixture.waiterUser.name,
      });
      // The one taken off before the kitchen heard of it is not fraud, so it is not in the report.
      expect(report.some((line) => line.itemId === unsentItem.id)).toBe(false);
      // A period that ended before the removal does not hold it. Asked about this item rather than
      // about the whole report, because the report is the whole café's: a backend whose database keeps
      // what earlier runs did has removals of its own in that half hour, and what is under test here
      // is the period, not the café being empty.
      const earlier = await fixture.admin.orders.removedAfterSent({
        from: minutesAgo(60),
        to: minutesAgo(30),
      });
      expect(earlier.some((line) => line.itemId === sentItem.id)).toBe(false);
    });

    it('credits the person a record names, who need not be the one who sends it', async () => {
      const table = await fixture.newTable();
      const product = await createProduct(fixture, 'Express', 1_900);
      const waiter = fixture.waiterUser;

      // The waiter handed the phone over before it had a network again: what the waiter did
      // reaches the server under the admin's login, and stays the waiter's.
      const added = await fixture.admin.orders.addItem(
        await orderRecord(
          { tableId: table.id, productId: product.id, qty: 1, note: '' },
          { actorUserId: waiter.id },
        ),
      );
      await fixture.admin.orders.send(
        await orderRecord(
          { tableId: table.id },
          { actorUserId: waiter.id, createdAt: minutesAgo(10) },
        ),
      );
      await fixture.admin.orders.removeItem(
        await orderRecord(
          { itemId: added.itemId, reason: 'The guest sent it back' },
          { actorUserId: waiter.id },
        ),
      );

      expect(await itemOnTable(fixture, table, added.itemId)).toMatchObject({
        addedBy: waiter.id,
        removedBy: waiter.id,
      });

      // A cancel takes everything still on the table off in the name of whoever cancelled.
      const left = await addToTable(fixture, table, product);
      await fixture.waiter.orders.send(
        await orderRecord({ tableId: table.id }, { createdAt: minutesAgo(5) }),
      );
      await fixture.admin.orders.cancelOrder(
        await orderRecord(
          { tableId: table.id, reason: 'The guests left' },
          { actorUserId: fixture.cashierUser.id },
        ),
      );

      const report = await fixture.admin.orders.removedAfterSent({
        from: minutesAgo(60),
        to: timestamp(),
      });
      // Each names its author, and the login that sent it beside them: the admin's, for both.
      expect(report.find((line) => line.itemId === added.itemId)).toMatchObject({
        removedBy: waiter.id,
        removedByName: waiter.name,
        submittedBy: fixture.adminUser.id,
        submittedByName: fixture.adminUser.name,
      });
      expect(report.find((line) => line.itemId === left.id)).toMatchObject({
        removedBy: fixture.cashierUser.id,
        removedByName: fixture.cashierUser.name,
        submittedBy: fixture.adminUser.id,
        submittedByName: fixture.adminUser.name,
      });
    });

    it('refuses an author from outside the shop, and credits the sender of a record that names nobody', async () => {
      const table = await fixture.newTable();
      const product = await createProduct(fixture, 'Express', 1_900);
      const addFields = { tableId: table.id, productId: product.id, qty: 1, note: '' };
      const stranger = newId();

      const outsider = await failure(
        fixture.admin.orders.addItem(await orderRecord(addFields, { actorUserId: stranger })),
        'FORBIDDEN',
      );
      expect(outsider.details).toMatchObject({ actorUserId: stranger });
      await expect(fixture.waiter.orders.openOrder(table.id)).resolves.toBeNull();

      // A record queued before records named their author: the caller did it, as far as anyone
      // can tell.
      const unnamed = await fixture.cashier.orders.addItem(await orderRecord(addFields));
      expect((await itemOnTable(fixture, table, unnamed.itemId))?.addedBy).toBe(
        fixture.cashierUser.id,
      );

      const refusedRemoval = await failure(
        fixture.admin.orders.removeItem(
          await orderRecord(
            { itemId: unnamed.itemId, reason: 'The guest sent it back' },
            { actorUserId: stranger },
          ),
        ),
        'FORBIDDEN',
      );
      expect(refusedRemoval.details).toMatchObject({ actorUserId: stranger });
      await failure(
        fixture.admin.orders.cancelOrder(
          await orderRecord(
            { tableId: table.id, reason: 'The guests left' },
            { actorUserId: stranger },
          ),
        ),
        'FORBIDDEN',
      );
      expect(await itemOnTable(fixture, table, unnamed.itemId)).toMatchObject({
        removedAt: null,
        removedBy: null,
      });
    });

    it('leaves the order open when a table pays in parts, and closes it when nothing is owed', async () => {
      const table = await fixture.newTable();
      const coffee = await createProduct(fixture, 'Express', 1_900);
      const water = await createProduct(fixture, 'Eau', 850);
      const first = await addToTable(fixture, table, coffee, 2);
      const second = await addToTable(fixture, table, water);
      const till = await openTill(fixture);

      const part = await tablePaymentRecord(till, 1, table, [first]);
      await expect(fixture.cashier.sales.recordSale(part)).resolves.toMatchObject({
        status: 'created',
        receiptNumber: `${till.terminal.terminalCode}-1`,
      });

      expect(await itemOnTable(fixture, table, first.id)).toMatchObject({ paidSaleId: part.id });
      expect(await boardEntry(fixture, table)).toMatchObject({
        orderId: first.orderId,
        dueMillimes: 850,
        activeCount: 2,
        unpaidCount: 1,
      });

      const rest = await tablePaymentRecord(till, 2, table, [second]);
      await expect(fixture.cashier.sales.recordSale(rest)).resolves.toMatchObject({
        status: 'created',
      });

      // Nothing is owed, so the table is free again and its order is closed.
      await expect(fixture.waiter.orders.openOrder(table.id)).resolves.toBeNull();
      expect(await boardEntry(fixture, table)).toMatchObject({
        orderId: null,
        dueMillimes: 0,
        activeCount: 0,
      });
    });

    it('opens a new order for an add that arrives after the caisse paid the table', async () => {
      const table = await fixture.newTable();
      const product = await createProduct(fixture, 'Express', 1_900);
      const item = await addToTable(fixture, table, product);
      const till = await openTill(fixture);
      await fixture.cashier.sales.recordSale(await tablePaymentRecord(till, 1, table, [item]));
      await expect(fixture.waiter.orders.openOrder(table.id)).resolves.toBeNull();

      // A waiter's phone comes back from a dead spot and sends the add it took before the payment.
      const late = await fixture.waiter.orders.addItem(
        await orderRecord(
          { tableId: table.id, productId: product.id, qty: 1, note: '' },
          { createdAt: minutesAgo(20) },
        ),
      );

      expect(late.status).toBe('created');
      expect(late.orderId).not.toBe(item.orderId);
      const order = await fixture.waiter.orders.openOrder(table.id);
      expect(order).toMatchObject({ id: late.orderId, status: 'open' });
      expect(order?.items.map((line) => line.id)).toEqual([late.itemId]);
      expect(await boardEntry(fixture, table)).toMatchObject({
        orderId: late.orderId,
        dueMillimes: 1_900,
        unpaidCount: 1,
      });
    });

    it('refuses a payment whose line no longer matches the table: ORDER_CHANGED, and the number is still free', async () => {
      const table = await fixture.newTable();
      const product = await createProduct(fixture, 'Express', 1_900);
      const item = await addToTable(fixture, table, product, 2);
      const till = await openTill(fixture);
      const payment = await tablePaymentRecord(till, 1, table, [item]);

      // The waiter takes the item off the table while the caisse is holding the receipt.
      await fixture.waiter.orders.removeItem(
        await orderRecord({ itemId: item.id, reason: 'The guest sent it back' }),
      );

      const stale = await failure(fixture.cashier.sales.recordSale(payment), 'ORDER_CHANGED');
      expect(stale.details).toMatchObject({ lineNo: 1 });

      // Nothing was recorded, so the terminal's next receipt is still the first one.
      await expect(
        fixture.cashier.sales.listSales({ terminalId: till.terminalId }),
      ).resolves.toEqual([]);
      const afresh = await addToTable(fixture, table, product);
      await expect(
        fixture.cashier.sales.recordSale(await tablePaymentRecord(till, 1, table, [afresh])),
      ).resolves.toMatchObject({ status: 'created' });
    });

    it('refuses a payment for an item that was already paid: ORDER_CHANGED', async () => {
      const table = await fixture.newTable();
      const product = await createProduct(fixture, 'Express', 1_900);
      const item = await addToTable(fixture, table, product);
      const other = await addToTable(fixture, table, product);
      const till = await openTill(fixture);
      await fixture.cashier.sales.recordSale(await tablePaymentRecord(till, 1, table, [item]));

      const twice = await failure(
        fixture.cashier.sales.recordSale(await tablePaymentRecord(till, 2, table, [item])),
        'ORDER_CHANGED',
      );
      expect(twice.details).toMatchObject({ lineNo: 1, itemId: item.id });
      expect(await boardEntry(fixture, table)).toMatchObject({ unpaidCount: 1 });
      await expect(
        fixture.cashier.sales.recordSale(await tablePaymentRecord(till, 2, table, [other])),
      ).resolves.toMatchObject({ status: 'created' });
    });

    it('cancels a table nobody paid, and refuses to cancel one that has a paid item', async () => {
      const table = await fixture.newTable();
      const product = await createProduct(fixture, 'Express', 1_900);
      const item = await addToTable(fixture, table, product);
      await fixture.waiter.orders.send(await orderRecord({ tableId: table.id }));

      const cancelled = await fixture.cashier.orders.cancelOrder(
        await orderRecord({ tableId: table.id, reason: 'The guests left' }),
      );

      expect(cancelled).toEqual({ status: 'created', orderId: item.orderId, affected: 1 });
      await expect(fixture.waiter.orders.openOrder(table.id)).resolves.toBeNull();
      expect(await ticketsFor(fixture, item.orderId)).toEqual([]);
      expect(await boardEntry(fixture, table)).toMatchObject({ orderId: null, dueMillimes: 0 });

      const paidTable = await fixture.newTable();
      const paidItem = await addToTable(fixture, paidTable, product);
      const other = await addToTable(fixture, paidTable, product);
      const till = await openTill(fixture);
      await fixture.cashier.sales.recordSale(
        await tablePaymentRecord(till, 1, paidTable, [paidItem]),
      );

      const refused = await failure(
        fixture.cashier.orders.cancelOrder(
          await orderRecord({ tableId: paidTable.id, reason: 'The guests left' }),
        ),
        'ORDER_CHANGED',
      );
      expect(refused.details).toMatchObject({ orderId: other.orderId });
      await expect(fixture.waiter.orders.openOrder(paidTable.id)).resolves.toMatchObject({
        status: 'open',
      });
    });

    it('refuses anything on a table that has no open order: ORDER_CLOSED', async () => {
      const free = await fixture.newTable();
      const sendNothing = await failure(
        fixture.waiter.orders.send(await orderRecord({ tableId: free.id })),
        'ORDER_CLOSED',
      );
      expect(sendNothing.details).toMatchObject({ tableId: free.id });
      await failure(
        fixture.cashier.orders.cancelOrder(
          await orderRecord({ tableId: free.id, reason: 'Nothing there' }),
        ),
        'ORDER_CLOSED',
      );

      const table = await fixture.newTable();
      const product = await createProduct(fixture, 'Express', 1_900);
      const item = await addToTable(fixture, table, product);
      await fixture.cashier.orders.cancelOrder(
        await orderRecord({ tableId: table.id, reason: 'The guests left' }),
      );

      const late = await failure(
        fixture.waiter.orders.removeItem(
          await orderRecord({ itemId: item.id, reason: 'The guest sent it back' }),
        ),
        'ORDER_CLOSED',
      );
      expect(late.details).toMatchObject({ tableId: table.id, orderId: item.orderId });
    });

    it('refuses an item id that is on no table: ITEM_NOT_FOUND', async () => {
      const missing = newId();
      const removed = await failure(
        fixture.waiter.orders.removeItem(
          await orderRecord({ itemId: missing, reason: 'Ordered by mistake' }),
        ),
        'ITEM_NOT_FOUND',
      );
      expect(removed.details).toMatchObject({ itemId: missing });
      await failure(
        fixture.kitchen.orders.prepareItem(await orderRecord({ itemId: missing })),
        'ITEM_NOT_FOUND',
      );

      // An item the waiter has taken off the table is gone from the kitchen screen, not from the
      // shop: preparing it is a conflict, and taking it off again is simply nothing to do.
      const table = await fixture.newTable();
      const product = await createProduct(fixture, 'Express', 1_900);
      const item = await addToTable(fixture, table, product);
      await fixture.waiter.orders.send(await orderRecord({ tableId: table.id }));
      await fixture.waiter.orders.removeItem(
        await orderRecord({ itemId: item.id, reason: 'The guest sent it back' }),
      );
      await failure(
        fixture.kitchen.orders.prepareItem(await orderRecord({ itemId: item.id })),
        'ORDER_CHANGED',
      );
      await expect(
        fixture.waiter.orders.removeItem(await orderRecord({ itemId: item.id, reason: 'Again' })),
      ).resolves.toEqual({ status: 'created', orderId: item.orderId, affected: 0 });
      const row = await itemOnTable(fixture, table, item.id);
      expect(row?.removedReason).toBe('The guest sent it back');

      // The kitchen never heard of an item that has not been sent, so it cannot prepare it either.
      const unsent = await addToTable(fixture, table, product);
      await failure(
        fixture.kitchen.orders.prepareItem(await orderRecord({ itemId: unsent.id })),
        'ORDER_CHANGED',
      );
    });

    it('refuses to put anything on a table the admin has retired: TABLE_INACTIVE', async () => {
      const retired = await fixture.retiredTable();
      const product = await createProduct(fixture, 'Express', 1_900);

      const refused = await failure(
        fixture.waiter.orders.addItem(
          await orderRecord({ tableId: retired.id, productId: product.id, qty: 1, note: '' }),
        ),
        'TABLE_INACTIVE',
      );

      expect(refused.details).toMatchObject({ tableId: retired.id });
      await expect(fixture.waiter.orders.openOrder(retired.id)).resolves.toBeNull();
      const board = await fixture.waiter.orders.board();
      expect(board.some((entry) => entry.table.id === retired.id)).toBe(false);
      // A table of another shop, or none at all, is not this shop's to write to.
      const stranger = newId();
      const elsewhere = await failure(
        fixture.waiter.orders.addItem(
          await orderRecord({ tableId: stranger, productId: product.id, qty: 1, note: '' }),
        ),
        'FORBIDDEN',
      );
      expect(elsewhere.details).toMatchObject({ tableId: stranger });
      await failure(
        fixture.waiter.orders.send(await orderRecord({ tableId: stranger })),
        'FORBIDDEN',
      );
    });

    it('answers a record that arrives twice with what it answered the first time', async () => {
      const table = await fixture.newTable();
      const product = await createProduct(fixture, 'Express', 1_900);

      const add = await orderRecord({
        tableId: table.id,
        productId: product.id,
        qty: 1,
        note: '',
      });
      const added = await fixture.waiter.orders.addItem(add);
      await expect(fixture.waiter.orders.addItem(add)).resolves.toEqual({
        ...added,
        status: 'replayed',
      });

      const send = await orderRecord({ tableId: table.id });
      const sent = await fixture.waiter.orders.send(send);
      // The replay answers 1, not 0: it is the stored outcome, not the work done again.
      expect(sent.affected).toBe(1);
      await expect(fixture.waiter.orders.send(send)).resolves.toEqual({
        ...sent,
        status: 'replayed',
      });

      const prepare = await orderRecord({ itemId: added.itemId });
      const preparedOnce = await fixture.kitchen.orders.prepareItem(prepare);
      await expect(fixture.kitchen.orders.prepareItem(prepare)).resolves.toEqual({
        ...preparedOnce,
        status: 'replayed',
      });

      const remove = await orderRecord({
        itemId: added.itemId,
        reason: 'The guest sent it back',
      });
      const removedOnce = await fixture.waiter.orders.removeItem(remove);
      await expect(fixture.waiter.orders.removeItem(remove)).resolves.toEqual({
        ...removedOnce,
        status: 'replayed',
      });

      const cancel = await orderRecord({ tableId: table.id, reason: 'The guests left' });
      const cancelledOnce = await fixture.cashier.orders.cancelOrder(cancel);
      await expect(fixture.cashier.orders.cancelOrder(cancel)).resolves.toEqual({
        ...cancelledOnce,
        status: 'replayed',
      });

      // One item, added once: every replay above changed nothing.
      const order = await fixture.admin.orders.openOrder(table.id);
      expect(order).toBeNull();
    });

    it('refuses the same record id with another payload: IDEMPOTENCY_CONFLICT', async () => {
      const table = await fixture.newTable();
      const product = await createProduct(fixture, 'Express', 1_900);
      const add = await orderRecord({
        tableId: table.id,
        productId: product.id,
        qty: 1,
        note: '',
      });
      const added = await fixture.waiter.orders.addItem(add);

      const other = await orderRecord(
        { tableId: table.id, productId: product.id, qty: 4, note: '' },
        { id: add.id },
      );
      const conflict = await failure(fixture.waiter.orders.addItem(other), 'IDEMPOTENCY_CONFLICT');

      expect(conflict.details).toMatchObject({ id: add.id });
      const order = await fixture.waiter.orders.openOrder(table.id);
      expect(order?.items.map((item) => [item.id, item.qty])).toEqual([[added.itemId, 1]]);
    });

    it('lets each role do its own work and nobody else the rest', async () => {
      const table = await fixture.newTable();
      const product = await createProduct(fixture, 'Express', 1_900);
      const addFields = { tableId: table.id, productId: product.id, qty: 1, note: '' };

      // The kitchen prepares; it does not work the tables.
      await failure(fixture.kitchen.orders.addItem(await orderRecord(addFields)), 'FORBIDDEN');
      await failure(
        fixture.kitchen.orders.send(await orderRecord({ tableId: table.id })),
        'FORBIDDEN',
      );

      const item = await addToTable(fixture, table, product);
      await fixture.waiter.orders.send(await orderRecord({ tableId: table.id }));

      // A waiter works the tables, but the kitchen's stamp and the register are not theirs.
      await failure(
        fixture.waiter.orders.prepareItem(await orderRecord({ itemId: item.id })),
        'FORBIDDEN',
      );
      await failure(
        fixture.waiter.orders.cancelOrder(
          await orderRecord({ tableId: table.id, reason: 'The guests left' }),
        ),
        'FORBIDDEN',
      );
      const till = await openTill(fixture);
      await failure(
        fixture.waiter.sales.recordSale(await tablePaymentRecord(till, 1, table, [item])),
        'FORBIDDEN',
      );

      // The fraud report is the admin's.
      await failure(
        fixture.cashier.orders.removedAfterSent({ from: minutesAgo(60), to: timestamp() }),
        'FORBIDDEN',
      );
      await failure(
        fixture.waiter.orders.removedAfterSent({ from: minutesAgo(60), to: timestamp() }),
        'FORBIDDEN',
      );

      // Everything that was refused left the table as it was, and the admin may do it all.
      expect(await boardEntry(fixture, table)).toMatchObject({
        activeCount: 1,
        unsentCount: 0,
        unpaidCount: 1,
      });
      await expect(
        fixture.admin.orders.prepareItem(await orderRecord({ itemId: item.id })),
      ).resolves.toMatchObject({ status: 'created', affected: 1 });
      await expect(
        fixture.admin.orders.cancelOrder(
          await orderRecord({ tableId: table.id, reason: 'The guests left' }),
        ),
      ).resolves.toMatchObject({ status: 'created' });
    });

    it('needs a reason to remove an item or cancel a table, and at least one unit to add', async () => {
      const table = await fixture.newTable();
      const product = await createProduct(fixture, 'Express', 1_900);
      const item = await addToTable(fixture, table, product);

      await failure(
        fixture.waiter.orders.removeItem(await orderRecord({ itemId: item.id, reason: '  ' })),
        'VALIDATION_ERROR',
      );
      await failure(
        fixture.cashier.orders.cancelOrder(await orderRecord({ tableId: table.id, reason: '' })),
        'VALIDATION_ERROR',
      );
      await failure(
        fixture.waiter.orders.addItem(
          await orderRecord({ tableId: table.id, productId: product.id, qty: 0, note: '' }),
        ),
        'VALIDATION_ERROR',
      );
      await failure(
        fixture.waiter.orders.addItem(
          await orderRecord({ tableId: table.id, productId: newId(), qty: 1, note: '' }),
        ),
        'NOT_FOUND',
      );

      expect(await boardEntry(fixture, table)).toMatchObject({
        activeCount: 1,
        dueMillimes: 1_900,
      });
    });
  });
}
