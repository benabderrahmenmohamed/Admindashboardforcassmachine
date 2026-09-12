import { describe } from 'vitest';
import { AppError } from '@/lib/errors';
import {
  hasRole,
  type AuthUser,
  type Backend,
  type Credentials,
  type DiningTable,
  type Role,
} from '@/ports';
import {
  describeBackendContract,
  freshTerminalCode,
  type ContractFixture,
} from '@/ports/__contracts__';
import { createMemoryBackend, type MemoryBackend } from './index';

interface Member {
  readonly credentials: Credentials;
  readonly user: AuthUser;
}

/**
 * The memory backend has one signed-in user per store, while the contract talks to one shop as each
 * of its four roles. All four views share the store: every call first signs its own member in again
 * when another one is signed in. The suites make one call at a time, so switches never interleave.
 */
function actingAs(backend: Backend, member: Member): Backend {
  async function as<T>(call: () => Promise<T>): Promise<T> {
    const state = await backend.auth.getState();
    if (state.status !== 'authenticated' || state.user.id !== member.user.id) {
      await backend.auth.signIn(member.credentials);
    }
    return call();
  }

  return {
    kind: backend.kind,
    auth: {
      getState: () => as(() => backend.auth.getState()),
      signIn: (credentials) => backend.auth.signIn(credentials),
      signOut: () => backend.auth.signOut(),
      onStateChange: (listener) => backend.auth.onStateChange(listener),
    },
    catalog: {
      listProducts: () => as(() => backend.catalog.listProducts()),
      createProduct: (input) => as(() => backend.catalog.createProduct(input)),
      updateProduct: (id, input) => as(() => backend.catalog.updateProduct(id, input)),
      deleteProduct: (id) => as(() => backend.catalog.deleteProduct(id)),
      setAvailability: (productId, isAvailable) =>
        as(() => backend.catalog.setAvailability(productId, isAvailable)),
      adjustStock: (adjustment) => as(() => backend.catalog.adjustStock(adjustment)),
      listCategories: () => as(() => backend.catalog.listCategories()),
      createCategory: (input) => as(() => backend.catalog.createCategory(input)),
      deleteCategory: (id) => as(() => backend.catalog.deleteCategory(id)),
    },
    orders: {
      listTables: () => as(() => backend.orders.listTables()),
      createTable: (input) => as(() => backend.orders.createTable(input)),
      updateTable: (id, input) => as(() => backend.orders.updateTable(id, input)),
      board: () => as(() => backend.orders.board()),
      openOrder: (tableId) => as(() => backend.orders.openOrder(tableId)),
      kitchenTickets: () => as(() => backend.orders.kitchenTickets()),
      removedAfterSent: (query) => as(() => backend.orders.removedAfterSent(query)),
      addItem: (record) => as(() => backend.orders.addItem(record)),
      removeItem: (record) => as(() => backend.orders.removeItem(record)),
      send: (record) => as(() => backend.orders.send(record)),
      prepareItem: (record) => as(() => backend.orders.prepareItem(record)),
      cancelOrder: (record) => as(() => backend.orders.cancelOrder(record)),
    },
    realtime: {
      subscribe: (shopId, listener) => backend.realtime.subscribe(shopId, listener),
    },
    sales: {
      recordSale: (record) => as(() => backend.sales.recordSale(record)),
      listSales: (query) => as(() => backend.sales.listSales(query)),
      getSale: (id) => as(() => backend.sales.getSale(id)),
      voidReceipt: (input) => as(() => backend.sales.voidReceipt(input)),
    },
    sessions: {
      open: (record) => as(() => backend.sessions.open(record)),
      close: (record) => as(() => backend.sessions.close(record)),
      current: (terminalId) => as(() => backend.sessions.current(terminalId)),
      zReport: (sessionId) => as(() => backend.sessions.zReport(sessionId)),
    },
    settings: {
      getSettings: () => as(() => backend.settings.getSettings()),
      updateSettings: (settings) => as(() => backend.settings.updateSettings(settings)),
    },
    terminals: {
      register: (code) => as(() => backend.terminals.register(code)),
    },
  };
}

function configError(what: string): AppError {
  return new AppError(
    'CONFIG_ERROR',
    `The memory backend offers no ${what} to run the contract as.`,
  );
}

/**
 * Hands out the shop's tables one at a time, so no two tests of a run share a board. It reads them
 * on a client of its own, so asking for a table never moves the sign-in a test is working under.
 */
async function tableSource(
  backend: MemoryBackend,
  admin: Member,
): Promise<(active: boolean) => Promise<DiningTable>> {
  const client = backend.connect();
  await client.auth.signIn(admin.credentials);
  let taken = 0;
  return async function next(active: boolean): Promise<DiningTable> {
    const tables = await client.orders.listTables();
    const matching = tables.filter((table) => table.isActive === active);
    const table = active ? matching[taken++] : matching[0];
    if (!table) {
      throw configError(`${active ? 'unused active' : 'retired'} table`);
    }
    return table;
  };
}

/** A fresh memory backend, seen as one member per role of the shop its demo accounts sign in to. */
async function makeFixture(): Promise<ContractFixture> {
  const backend = createMemoryBackend();
  const members: Member[] = [];
  for (const account of backend.demoAccounts) {
    const credentials = { email: account.email, password: account.password };
    members.push({ credentials, user: await backend.auth.signIn(credentials) });
  }
  const shopId = members[0]?.user.shopId;
  /** The member of that shop who holds `role` and nothing else, so a refusal is unambiguous. */
  function only(role: Role): Member {
    const member = members.find(
      (candidate) =>
        candidate.user.shopId === shopId &&
        candidate.user.roles.length === 1 &&
        hasRole(candidate.user, [role]),
    );
    if (!member) {
      throw configError(`member of one shop whose only role is ${role}`);
    }
    return member;
  }
  const admin = members.find(
    (member) => member.user.shopId === shopId && hasRole(member.user, ['admin']),
  );
  if (!admin) {
    throw configError('admin of a shop');
  }
  const cashier = only('cashier');
  const waiter = only('waiter');
  const kitchen = only('kitchen');
  const nextTable = await tableSource(backend, admin);

  return {
    admin: actingAs(backend, admin),
    cashier: actingAs(backend, cashier),
    waiter: actingAs(backend, waiter),
    kitchen: actingAs(backend, kitchen),
    adminUser: admin.user,
    cashierUser: cashier.user,
    waiterUser: waiter.user,
    kitchenUser: kitchen.user,
    newTerminalCode: freshTerminalCode,
    newTable: () => nextTable(true),
    retiredTable: () => nextTable(false),
  };
}

describe('memory backend', () => {
  describeBackendContract(makeFixture);
});
