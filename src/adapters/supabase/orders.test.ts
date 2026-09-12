import { describe, expect, it } from 'vitest';
import type {
  OrderCancelRecord,
  OrderItemAddRecord,
  OrderItemPrepareRecord,
  OrderItemRemoveRecord,
  OrdersPort,
  OrderSendRecord,
} from '@/ports';
import {
  failureOf,
  fakeSupabase,
  json,
  raised,
  routes,
  unreachable,
  type FakeCall,
  type FakeHandler,
} from './fakeSupabase';
import { createSupabaseOrders } from './orders';

const RECORD_ID = '0b7c6f1e-3d2a-4c5b-8e9f-1a2b3c4d5e6f';
const HASH = 'ab'.repeat(32);

const ITEM_COLUMNS =
  'id,order_id,product_id,name_snapshot,unit_price_millimes,qty,note,added_by,added_at,sent_at,prepared_at,removed_at,removed_by,removed_reason,paid_sale_id';
const ORDER_COLUMNS = `id,table_id,status,opened_at,closed_at,open_order_items(${ITEM_COLUMNS})`;
const ITEM_WITH_TABLE_COLUMNS = `${ITEM_COLUMNS},open_orders!inner(id,table_id,status,dining_tables!inner(name))`;

/** What every record a device writes carries: who wrote it, where, and how to spot a replay. */
const recordBase = {
  id: RECORD_ID,
  deviceId: 'device-7',
  createdAt: '2026-09-12T10:00:00.000Z',
  payloadHash: HASH,
};

const recordBaseJson = {
  id: RECORD_ID,
  device_id: 'device-7',
  created_at: '2026-09-12T10:00:00.000Z',
  payload_hash: HASH,
};

const addRecord: OrderItemAddRecord = {
  ...recordBase,
  tableId: 't-1',
  productId: 'p-cafe',
  qty: 2,
  note: 'sans sucre',
};

const removeRecord: OrderItemRemoveRecord = {
  ...recordBase,
  itemId: 'i-1',
  reason: 'Client changed his mind',
};

const sendRecord: OrderSendRecord = { ...recordBase, tableId: 't-1' };

const prepareRecord: OrderItemPrepareRecord = { ...recordBase, itemId: 'i-1' };

const cancelRecord: OrderCancelRecord = { ...recordBase, tableId: 't-1', reason: 'Guests left' };

function tableRow(id: string, name: string, sortOrder: number, isActive = true) {
  return { id, name, sort_order: sortOrder, is_active: isActive };
}

function itemRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'i-1',
    order_id: 'o-1',
    product_id: 'p-cafe',
    name_snapshot: 'Express',
    unit_price_millimes: 1500,
    qty: 1,
    note: '',
    added_by: 'user-waiter',
    added_at: '2026-09-12T08:00:00.000Z',
    sent_at: null,
    prepared_at: null,
    removed_at: null,
    removed_by: null,
    removed_reason: null,
    paid_sale_id: null,
    ...overrides,
  };
}

/** An item as the kitchen and the removed report read it: with the order and the table it is on. */
function itemWithTable(overrides: Record<string, unknown> = {}, table = { name: 'Terrasse 1' }) {
  const row = itemRow(overrides);
  return {
    ...row,
    open_orders: {
      id: row.order_id,
      table_id: row.order_id === 'o-2' ? 't-2' : 't-1',
      status: 'open',
      dining_tables: table,
    },
  };
}

function setup(handler: FakeHandler) {
  const { client, calls } = fakeSupabase(handler);
  return { calls, orders: createSupabaseOrders(client) };
}

/** The first request to `path`; fails the test when there was none. */
function callTo(calls: readonly FakeCall[], path: string): FakeCall {
  return calls.find((call) => call.path === path) ?? expect.unreachable(`no request to ${path}`);
}

describe('supabase orders: records', () => {
  it('adds an item with every key in snake_case, the hash untouched and added_at alongside', async () => {
    const { client, calls } = fakeSupabase(() =>
      json({ status: 'created', order_id: 'o-1', item_id: 'i-9' }),
    );

    const result = await createSupabaseOrders(client).addItem(addRecord);

    expect(calls[0].path).toBe('/rest/v1/rpc/order_item_add');
    expect(calls[0].body).toEqual({
      p: {
        ...recordBaseJson,
        table_id: 't-1',
        product_id: 'p-cafe',
        qty: 2,
        note: 'sans sucre',
        added_at: '2026-09-12T10:00:00.000Z',
      },
    });
    expect(result).toEqual({ status: 'created', orderId: 'o-1', itemId: 'i-9' });
  });

  it('returns a replayed add as it comes, so a queue can acknowledge it', async () => {
    const { client } = fakeSupabase(() =>
      json({ status: 'replayed', order_id: 'o-1', item_id: 'i-9' }),
    );

    await expect(createSupabaseOrders(client).addItem(addRecord)).resolves.toMatchObject({
      status: 'replayed',
    });
  });

  it('removes an item with the reason, and reports how many rows it touched', async () => {
    const { client, calls } = fakeSupabase(() =>
      json({ status: 'created', order_id: 'o-1', affected: 1 }),
    );

    const result = await createSupabaseOrders(client).removeItem(removeRecord);

    expect(calls[0].path).toBe('/rest/v1/rpc/order_item_remove');
    expect(calls[0].body).toEqual({
      p: { ...recordBaseJson, item_id: 'i-1', reason: 'Client changed his mind' },
    });
    expect(result).toEqual({ status: 'created', orderId: 'o-1', affected: 1 });
  });

  it('sends a table to the kitchen with sent_at alongside the record', async () => {
    const { client, calls } = fakeSupabase(() =>
      json({ status: 'created', order_id: 'o-1', affected: 3 }),
    );

    const result = await createSupabaseOrders(client).send(sendRecord);

    expect(calls[0].path).toBe('/rest/v1/rpc/order_send');
    expect(calls[0].body).toEqual({
      p: { ...recordBaseJson, table_id: 't-1', sent_at: '2026-09-12T10:00:00.000Z' },
    });
    expect(result.affected).toBe(3);
  });

  it('marks an item prepared', async () => {
    const { client, calls } = fakeSupabase(() =>
      json({ status: 'created', order_id: 'o-1', affected: 1 }),
    );

    await createSupabaseOrders(client).prepareItem(prepareRecord);

    expect(calls[0].path).toBe('/rest/v1/rpc/order_item_prepare');
    expect(calls[0].body).toEqual({ p: { ...recordBaseJson, item_id: 'i-1' } });
  });

  it('cancels an order with the reason', async () => {
    const { client, calls } = fakeSupabase(() =>
      json({ status: 'created', order_id: 'o-1', affected: 2 }),
    );

    await createSupabaseOrders(client).cancelOrder(cancelRecord);

    expect(calls[0].path).toBe('/rest/v1/rpc/order_cancel');
    expect(calls[0].body).toEqual({
      p: { ...recordBaseJson, table_id: 't-1', reason: 'Guests left' },
    });
  });

  it.each<[string, (orders: OrdersPort) => Promise<unknown>]>([
    ['a remove without a reason', (orders) => orders.removeItem({ ...removeRecord, reason: '  ' })],
    ['an add of no quantity', (orders) => orders.addItem({ ...addRecord, qty: 0 })],
    ['a record whose id is not a uuid', (orders) => orders.addItem({ ...addRecord, id: 'kc-1' })],
    [
      'a record with a hash that is not a digest',
      (orders) => orders.addItem({ ...addRecord, payloadHash: 'nope' }),
    ],
  ])('rejects %s, sending nothing', async (_case, write) => {
    const { client, calls } = fakeSupabase(() => json({}));

    const error = await failureOf(write(createSupabaseOrders(client)));

    expect(error.code).toBe('VALIDATION_ERROR');
    expect(calls).toEqual([]);
  });

  it('refuses a result the port schema cannot read as VALIDATION_ERROR', async () => {
    const { client } = fakeSupabase(() => json({ status: 'created', order_id: 'o-1' }));

    const error = await failureOf(createSupabaseOrders(client).addItem(addRecord));

    expect(error).toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(error.message).toContain('the added item');
  });
});

describe('supabase orders: the codes of the café model', () => {
  it('passes TABLE_INACTIVE on with the table in camelCase', async () => {
    const { client } = fakeSupabase(() =>
      raised('TABLE_INACTIVE', 409, { table_id: 't-1' }, 'This table is not in service.'),
    );

    const error = await failureOf(createSupabaseOrders(client).addItem(addRecord));

    expect(error).toMatchObject({
      code: 'TABLE_INACTIVE',
      message: 'This table is not in service.',
      details: { tableId: 't-1' },
    });
  });

  it('passes ITEM_NOT_FOUND on for a remove that names nothing', async () => {
    const { client } = fakeSupabase(() => raised('ITEM_NOT_FOUND', 404, { item_id: 'i-1' }));

    const error = await failureOf(createSupabaseOrders(client).removeItem(removeRecord));

    expect(error).toMatchObject({ code: 'ITEM_NOT_FOUND', details: { itemId: 'i-1' } });
  });

  it('passes ORDER_CHANGED on for a remove of an item that is already paid', async () => {
    const { client } = fakeSupabase(() =>
      raised('ORDER_CHANGED', 409, { item_id: 'i-1', table_id: 't-1' }),
    );

    const error = await failureOf(createSupabaseOrders(client).removeItem(removeRecord));

    expect(error).toMatchObject({
      code: 'ORDER_CHANGED',
      details: { itemId: 'i-1', tableId: 't-1' },
    });
  });

  it('passes ORDER_CLOSED on for a send to a table nobody sits at any more', async () => {
    const { client } = fakeSupabase(() =>
      raised('ORDER_CLOSED', 409, { table_id: 't-1', order_id: 'o-1' }),
    );

    const error = await failureOf(createSupabaseOrders(client).send(sendRecord));

    expect(error).toMatchObject({
      code: 'ORDER_CLOSED',
      details: { tableId: 't-1', orderId: 'o-1' },
    });
  });

  it('keeps a raised code that arrives with an unexpected status', async () => {
    const { client } = fakeSupabase(() => raised('TABLE_INACTIVE', 400, { table_id: 't-1' }));

    const error = await failureOf(createSupabaseOrders(client).addItem(addRecord));

    expect(error.code).toBe('TABLE_INACTIVE');
  });
});

describe('supabase orders: reads', () => {
  it('lists every table of the shop in the admin order, inactive ones included', async () => {
    const { calls, orders } = setup(
      routes({
        'GET /rest/v1/dining_tables': () =>
          json([tableRow('t-1', 'Terrasse 1', 1), tableRow('t-9', 'Réserve', 9, false)]),
      }),
    );

    const tables = await orders.listTables();

    expect(callTo(calls, '/rest/v1/dining_tables').query.get('select')).toBe(
      'id,name,sort_order,is_active',
    );
    expect(callTo(calls, '/rest/v1/dining_tables').query.get('order')).toBe(
      'sort_order.asc,id.asc',
    );
    expect(callTo(calls, '/rest/v1/dining_tables').query.has('is_active')).toBe(false);
    expect(tables).toEqual([
      { id: 't-1', name: 'Terrasse 1', sortOrder: 1, isActive: true },
      { id: 't-9', name: 'Réserve', sortOrder: 9, isActive: false },
    ]);
  });

  it('builds the board from the active tables and their open orders', async () => {
    const { calls, orders } = setup(
      routes({
        'GET /rest/v1/dining_tables': () =>
          json([tableRow('t-1', 'Terrasse 1', 1), tableRow('t-2', 'Salle 2', 2)]),
        'GET /rest/v1/open_orders': () =>
          json([
            {
              id: 'o-1',
              table_id: 't-1',
              status: 'open',
              opened_at: '2026-09-12T08:00:00.000Z',
              closed_at: null,
              open_order_items: [
                itemRow({ id: 'i-unsent', qty: 2, unit_price_millimes: 1500 }),
                itemRow({
                  id: 'i-sent',
                  qty: 1,
                  unit_price_millimes: 2500,
                  sent_at: '2026-09-12T08:05:00.000Z',
                }),
                itemRow({
                  id: 'i-paid',
                  qty: 1,
                  unit_price_millimes: 4000,
                  sent_at: '2026-09-12T08:05:00.000Z',
                  paid_sale_id: 'sale-1',
                }),
                itemRow({
                  id: 'i-removed',
                  qty: 1,
                  unit_price_millimes: 9000,
                  sent_at: '2026-09-12T08:05:00.000Z',
                  removed_at: '2026-09-12T08:10:00.000Z',
                  removed_by: 'user-waiter',
                  removed_reason: 'Wrong table',
                }),
              ],
            },
          ]),
      }),
    );

    const board = await orders.board();

    expect(callTo(calls, '/rest/v1/dining_tables').query.get('is_active')).toBe('eq.true');
    expect(callTo(calls, '/rest/v1/open_orders').query.get('select')).toBe(ORDER_COLUMNS);
    expect(callTo(calls, '/rest/v1/open_orders').query.get('status')).toBe('eq.open');
    expect(board).toEqual([
      {
        table: { id: 't-1', name: 'Terrasse 1', sortOrder: 1, isActive: true },
        orderId: 'o-1',
        openedAt: '2026-09-12T08:00:00.000Z',
        // 2 × 1500 unsent + 2500 sent; the paid one is settled and the removed one owes nothing.
        dueMillimes: 5500,
        activeCount: 3,
        unsentCount: 1,
        unpaidCount: 2,
      },
      {
        table: { id: 't-2', name: 'Salle 2', sortOrder: 2, isActive: true },
        orderId: null,
        openedAt: null,
        dueMillimes: 0,
        activeCount: 0,
        unsentCount: 0,
        unpaidCount: 0,
      },
    ]);
  });

  it('shows a free table when the shop has no open order at all', async () => {
    const { orders } = setup(
      routes({
        'GET /rest/v1/dining_tables': () => json([tableRow('t-1', 'Terrasse 1', 1)]),
        'GET /rest/v1/open_orders': () => json([]),
      }),
    );

    await expect(orders.board()).resolves.toMatchObject([{ orderId: null, dueMillimes: 0 }]);
  });

  it('reads the open order of one table with its items oldest first', async () => {
    const { calls, orders } = setup(
      routes({
        'GET /rest/v1/open_orders': () =>
          json([
            {
              id: 'o-1',
              table_id: 't-1',
              status: 'open',
              opened_at: '2026-09-12T08:00:00.000Z',
              closed_at: null,
              open_order_items: [
                itemRow({ id: 'i-late', added_at: '2026-09-12T08:30:00.000Z' }),
                itemRow({
                  id: 'i-early',
                  added_at: '2026-09-12T08:00:00.000Z',
                  note: 'sans sucre',
                  qty: 2,
                }),
              ],
            },
          ]),
      }),
    );

    const order = await orders.openOrder('t-1');

    expect(callTo(calls, '/rest/v1/open_orders').query.get('table_id')).toBe('eq.t-1');
    expect(callTo(calls, '/rest/v1/open_orders').query.get('status')).toBe('eq.open');
    expect(order).toEqual({
      id: 'o-1',
      tableId: 't-1',
      status: 'open',
      openedAt: '2026-09-12T08:00:00.000Z',
      closedAt: null,
      items: [
        {
          id: 'i-early',
          orderId: 'o-1',
          productId: 'p-cafe',
          nameSnapshot: 'Express',
          unitPriceMillimes: 1500,
          qty: 2,
          note: 'sans sucre',
          addedBy: 'user-waiter',
          addedAt: '2026-09-12T08:00:00.000Z',
          sentAt: null,
          preparedAt: null,
          removedAt: null,
          removedBy: null,
          removedReason: null,
          paidSaleId: null,
        },
        {
          id: 'i-late',
          orderId: 'o-1',
          productId: 'p-cafe',
          nameSnapshot: 'Express',
          unitPriceMillimes: 1500,
          qty: 1,
          note: '',
          addedBy: 'user-waiter',
          addedAt: '2026-09-12T08:30:00.000Z',
          sentAt: null,
          preparedAt: null,
          removedAt: null,
          removedBy: null,
          removedReason: null,
          paidSaleId: null,
        },
      ],
    });
  });

  it('is null for a free table', async () => {
    const { orders } = setup(routes({ 'GET /rest/v1/open_orders': () => json([]) }));

    await expect(orders.openOrder('t-2')).resolves.toBeNull();
  });

  it('groups sent, unprepared items into one ticket per send, oldest ticket first', async () => {
    const { calls, orders } = setup(
      routes({
        'GET /rest/v1/open_order_items': () =>
          json([
            itemWithTable({ id: 'i-b', sent_at: '2026-09-12T09:00:00.000Z', added_at: 'b' }),
            itemWithTable({ id: 'i-a', sent_at: '2026-09-12T09:00:00.000Z', added_at: 'a' }),
            itemWithTable(
              { id: 'i-other', order_id: 'o-2', sent_at: '2026-09-12T09:15:00.000Z' },
              { name: 'Salle 2' },
            ),
            itemWithTable({ id: 'i-later', sent_at: '2026-09-12T09:30:00.000Z' }),
          ]),
      }),
    );

    const tickets = await orders.kitchenTickets();

    const call = callTo(calls, '/rest/v1/open_order_items');
    expect(call.query.get('select')).toBe(ITEM_WITH_TABLE_COLUMNS);
    expect(call.query.get('sent_at')).toBe('not.is.null');
    expect(call.query.get('prepared_at')).toBe('is.null');
    expect(call.query.get('removed_at')).toBe('is.null');
    expect(call.query.get('open_orders.status')).toBe('neq.cancelled');
    expect(call.query.get('order')).toBe('sent_at.asc,added_at.asc');
    expect(
      tickets.map((ticket) => [
        ticket.orderId,
        ticket.tableId,
        ticket.tableName,
        ticket.sentAt,
        ticket.items.map((item) => item.id),
      ]),
    ).toEqual([
      ['o-1', 't-1', 'Terrasse 1', '2026-09-12T09:00:00.000Z', ['i-a', 'i-b']],
      ['o-2', 't-2', 'Salle 2', '2026-09-12T09:15:00.000Z', ['i-other']],
      ['o-1', 't-1', 'Terrasse 1', '2026-09-12T09:30:00.000Z', ['i-later']],
    ]);
  });

  it('has no ticket when nothing is waiting in the kitchen', async () => {
    const { orders } = setup(routes({ 'GET /rest/v1/open_order_items': () => json([]) }));

    await expect(orders.kitchenTickets()).resolves.toEqual([]);
  });

  // The report goes through its RPC, not the tables: naming who took an item off means reading
  // other members' names, so the admin check has to be the server's and not this client's.
  it('reports items removed after they were sent, newest first, with who removed them', async () => {
    const { calls, orders } = setup(
      routes({
        'POST /rest/v1/rpc/removed_after_sent': () =>
          json([
            {
              item_id: 'i-late',
              table_name: 'Terrasse 1',
              product_name: 'Express',
              qty: 2,
              unit_price_millimes: 1500,
              sent_at: '2026-09-12T09:00:00.000Z',
              removed_at: '2026-09-12T11:00:00.000Z',
              removed_by: 'user-waiter',
              removed_by_name: 'Sonia',
              removed_reason: 'Guest cancelled',
            },
            {
              item_id: 'i-early',
              table_name: 'Salle 2',
              product_name: 'Express',
              qty: 1,
              unit_price_millimes: 1500,
              sent_at: '2026-09-12T09:05:00.000Z',
              removed_at: '2026-09-12T10:00:00.000Z',
              removed_by: 'user-other',
              removed_by_name: 'Hedi',
              removed_reason: 'Spilled',
            },
          ]),
      }),
    );

    const removed = await orders.removedAfterSent({
      from: '2026-09-12T00:00:00.000Z',
      to: '2026-09-12T23:59:59.999Z',
    });

    expect(calls[0].body).toEqual({
      p_from: '2026-09-12T00:00:00.000Z',
      p_to: '2026-09-12T23:59:59.999Z',
    });
    expect(removed).toEqual([
      {
        itemId: 'i-late',
        tableName: 'Terrasse 1',
        productName: 'Express',
        qty: 2,
        unitPriceMillimes: 1500,
        sentAt: '2026-09-12T09:00:00.000Z',
        removedAt: '2026-09-12T11:00:00.000Z',
        removedBy: 'user-waiter',
        removedByName: 'Sonia',
        removedReason: 'Guest cancelled',
      },
      {
        itemId: 'i-early',
        tableName: 'Salle 2',
        productName: 'Express',
        qty: 1,
        unitPriceMillimes: 1500,
        sentAt: '2026-09-12T09:05:00.000Z',
        removedAt: '2026-09-12T10:00:00.000Z',
        removedBy: 'user-other',
        removedByName: 'Hedi',
        removedReason: 'Spilled',
      },
    ]);
  });

  it('asks once and answers nothing when nothing was removed in the period', async () => {
    const { calls, orders } = setup(
      routes({ 'POST /rest/v1/rpc/removed_after_sent': () => json([]) }),
    );

    await expect(
      orders.removedAfterSent({ from: '2026-09-01T00:00:00Z', to: '2026-09-30T00:00:00Z' }),
    ).resolves.toEqual([]);

    expect(calls).toHaveLength(1);
  });

  it('refuses a report without both ends of the period, asking for nothing', async () => {
    const { calls, orders } = setup(() => json([]));

    const error = await failureOf(orders.removedAfterSent({ from: '', to: '' }));

    expect(error.code).toBe('VALIDATION_ERROR');
    expect(calls).toEqual([]);
  });

  it('reports a row it cannot read as VALIDATION_ERROR naming the row', async () => {
    const { orders } = setup(
      routes({
        'GET /rest/v1/dining_tables': () => json([{ ...tableRow('t-1', 'Terrasse 1', 1), id: '' }]),
      }),
    );

    const error = await failureOf(orders.listTables());

    expect(error.code).toBe('VALIDATION_ERROR');
    expect(error.message).toContain('table');
  });

  // A queue must retry a board that never arrived, not stop at it as a conflict.
  it('turns a read that never got a response into NETWORK_ERROR', async () => {
    const { orders } = setup(() => unreachable());

    const error = await failureOf(orders.listTables());

    expect(error.code).toBe('NETWORK_ERROR');
  });
});
