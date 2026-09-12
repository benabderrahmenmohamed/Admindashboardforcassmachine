import { describe, expect, it } from 'vitest';
import { describeRecord } from '@/features/pos/recording';
import { mm } from '@/lib/money';
import type {
  DiningTable,
  KitchenTicket,
  OpenOrder,
  OpenOrderItem,
  TableBoardEntry,
} from '@/ports';
import { ITEM_ID, storedOrder, TABLE_ID, uuid } from '../__tests__/fixtures';
import { recordNames, type CachedRoom } from './recordNames';

/** The product every order fixture puts on the table (see ../__tests__/fixtures.ts). */
const PRODUCT_ID = uuid(90_005);
const OTHER_TABLE_ID = uuid(90_010);
const AT = '2026-09-12T09:00:00.000Z';

const NOTHING_CACHED: CachedRoom = {
  tableList: undefined,
  board: undefined,
  kitchenTickets: undefined,
  products: undefined,
  openOrders: [],
};

function table(id: string, name: string, isActive = true): DiningTable {
  return { id, name, sortOrder: 1, isActive };
}

function item(id: string, name: string, qty: number): OpenOrderItem {
  return {
    id,
    orderId: 'order-1',
    productId: PRODUCT_ID,
    nameSnapshot: name,
    unitPriceMillimes: mm(1_900),
    qty,
    note: '',
    addedBy: 'user-waiter',
    addedAt: AT,
    sentAt: AT,
    preparedAt: null,
    removedAt: null,
    removedBy: null,
    removedReason: null,
    paidSaleId: null,
  };
}

function boardEntry(entry: DiningTable): TableBoardEntry {
  return {
    table: entry,
    orderId: null,
    openedAt: null,
    dueMillimes: mm(0),
    activeCount: 0,
    unsentCount: 0,
    unpaidCount: 0,
  };
}

describe('recordNames', () => {
  it('names nothing on a device that has cached nothing', () => {
    const names = recordNames(NOTHING_CACHED, []);

    expect(names.tables.size + names.products.size + names.items.size).toBe(0);
  });

  it('names tables from the list first, then the grid, then the kitchen tickets', () => {
    const ticket: KitchenTicket = {
      orderId: 'order-9',
      tableId: 'table-from-ticket',
      tableName: 'Comptoir',
      sentAt: AT,
      items: [item('item-9', 'Thé à la menthe', 1)],
    };
    const names = recordNames(
      {
        ...NOTHING_CACHED,
        tableList: [table(TABLE_ID, 'Terrasse 4', false)],
        board: [
          boardEntry(table(TABLE_ID, 'Renamed on the grid')),
          boardEntry(table(OTHER_TABLE_ID, 'Salle 2')),
        ],
        kitchenTickets: [ticket],
      },
      [],
    );

    expect(names.tables.get(TABLE_ID)).toBe('Terrasse 4');
    expect(names.tables.get(OTHER_TABLE_ID)).toBe('Salle 2');
    expect(names.tables.get('table-from-ticket')).toBe('Comptoir');
    expect(names.items.get('item-9')).toEqual({
      name: 'Thé à la menthe',
      qty: 1,
      tableId: 'table-from-ticket',
    });
  });

  it('names an item by the snapshot on the table this device opened, before the tickets', () => {
    const order: OpenOrder = {
      id: 'order-1',
      tableId: TABLE_ID,
      status: 'open',
      openedAt: AT,
      closedAt: null,
      items: [item(ITEM_ID, 'Café express', 2)],
    };
    const ticket: KitchenTicket = {
      orderId: 'order-1',
      tableId: OTHER_TABLE_ID,
      tableName: 'Salle 2',
      sentAt: AT,
      items: [item(ITEM_ID, 'Older name', 5)],
    };

    // A free table caches null next to it, which names nothing and breaks nothing.
    const names = recordNames(
      { ...NOTHING_CACHED, openOrders: [null, order], kitchenTickets: [ticket] },
      [],
    );

    expect(names.items.get(ITEM_ID)).toEqual({ name: 'Café express', qty: 2, tableId: TABLE_ID });
  });

  it('names an item this device added itself when no cached table shows it', async () => {
    const add = await storedOrder('order_item_add', 1);
    const names = recordNames(
      { ...NOTHING_CACHED, products: [{ id: PRODUCT_ID, name: 'Café moulu 250 g' }] },
      [add],
    );

    expect(names.products.get(PRODUCT_ID)).toBe('Café moulu 250 g');
    // An add's id is the id its item has on the table.
    expect(names.items.get(add.id)).toEqual({
      name: 'Café moulu 250 g',
      qty: 2,
      tableId: TABLE_ID,
    });
  });

  it('treats a cached value of another shape as not cached', async () => {
    const send = await storedOrder('order_send', 1);
    const names = recordNames(
      {
        tableList: [{ id: TABLE_ID }],
        board: 'not a board',
        kitchenTickets: { tickets: [] },
        products: [{ id: PRODUCT_ID, name: 42 }],
        openOrders: [{ tableId: TABLE_ID }],
      },
      [send],
    );

    expect(names.tables.size + names.products.size + names.items.size).toBe(0);
    expect(describeRecord(send, names)).toBe('Sending a table to the kitchen');
  });
});
