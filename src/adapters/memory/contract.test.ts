import { describe } from 'vitest';
import { AppError } from '@/lib/errors';
import type { AuthUser, Backend, Credentials } from '@/ports';
import {
  describeBackendContract,
  freshTerminalCode,
  type ContractFixture,
} from '@/ports/__contracts__';
import { createMemoryBackend } from './index';

interface Member {
  readonly credentials: Credentials;
  readonly user: AuthUser;
}

/**
 * The memory backend has one signed-in user per store, while the contract talks to one shop as its
 * admin and as its cashier. Both views share the store: every call first signs its own member in
 * again when the other one is signed in. The suites make one call at a time, so switches never
 * interleave.
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
      listCategories: () => as(() => backend.catalog.listCategories()),
      createCategory: (input) => as(() => backend.catalog.createCategory(input)),
      deleteCategory: (id) => as(() => backend.catalog.deleteCategory(id)),
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

/** A fresh memory backend, seen as the admin and a cashier of the shop its demo accounts sign in to. */
async function makeFixture(): Promise<ContractFixture> {
  const backend = createMemoryBackend();
  const members: Member[] = [];
  for (const account of backend.demoAccounts) {
    const credentials = { email: account.email, password: account.password };
    members.push({ credentials, user: await backend.auth.signIn(credentials) });
  }
  const admin = members.find((member) => member.user.role === 'admin');
  const cashier = members.find(
    (member) => member.user.role === 'cashier' && member.user.shopId === admin?.user.shopId,
  );
  if (!admin || !cashier) {
    throw new AppError(
      'CONFIG_ERROR',
      'The memory backend offers no demo admin and cashier of one shop to run the contract as.',
    );
  }
  return {
    admin: actingAs(backend, admin),
    cashier: actingAs(backend, cashier),
    adminUser: admin.user,
    cashierUser: cashier.user,
    newTerminalCode: freshTerminalCode,
  };
}

describe('memory backend', () => {
  describeBackendContract(makeFixture);
});
