import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { RouteObject } from 'react-router';
import { describe, expect, it } from 'vitest';
import { orderEnvelope } from '@/features/orders/__fixtures__/seedOrders';
import { useTables } from '@/features/orders/hooks/useOrders';
import { buildOrderItemAddRecord } from '@/features/orders/records';
import { useProducts } from '@/features/products/hooks/useProducts';
import { AppError } from '@/lib/errors';
import type { DiningTable, Product, Role } from '@/ports';
import { createHarness, type Harness } from '@/test/harness';
import type { OrderOutboxRecord } from '../types';
import { ConflictsPage } from './ConflictsPage';

/** A session id no server has ever heard of, so the record naming it is refused. */
const STRANDED_SESSION = '00000000-0000-4000-8000-0000000000f3';

/** The two faces that carry a queue: the counter, and the back office where a void is possible. */
const GUARDS: Record<'Cashier' | 'Owner', { readonly role: Role; readonly home: string }> = {
  Cashier: { role: 'cashier', home: '/caisse' },
  Owner: { role: 'admin', home: '/admin' },
};

type QueueLabel = keyof typeof GUARDS;

/**
 * A device whose queue has stopped: it wrote a sale in a session the server does not have, so the
 * server refused it and nothing behind it can go out either.
 */
async function stoppedQueue(signedInAs: QueueLabel): Promise<Harness> {
  const harness = await createHarness({ signedInAs, terminalCode: 'T1' });
  const [product] = await harness.backend.catalog.listProducts();
  await harness.sell(STRANDED_SESSION, product);
  await harness.runtime.sync();
  return harness;
}

function showConflicts(harness: Harness, signedInAs: QueueLabel): void {
  const { role, home } = GUARDS[signedInAs];
  const routes: RouteObject[] = [{ path: home, element: <p>Back at work</p> }];
  harness.renderScreen(<ConflictsPage home={home} />, {
    allow: [role],
    allowOffline: true,
    path: `${home}/conflicts`,
    routes,
  });
}

describe('ConflictsPage', () => {
  it('shows the refused record and sends it again once the cause is gone', async () => {
    const harness = await stoppedQueue('Cashier');

    showConflicts(harness, 'Cashier');

    const card = (await screen.findByText('Sale T1-1')).closest('div[data-slot="card"]');
    expect(card).toBeInstanceOf(HTMLElement);
    const conflict = card as HTMLElement;
    expect(within(conflict).getByText('NOT_FOUND')).toBeDefined();
    expect(within(conflict).getByText('Needs attention')).toBeDefined();

    // The session it names is opened on the server after all, so the record can be recorded now.
    await harness.openSessionOnServer(STRANDED_SESSION);
    fireEvent.click(within(conflict).getByRole('button', { name: /Send again/ }));

    // Not merely "no conflicts": a retried record is out of conflict the moment it is sent again,
    // so what proves it went through is that nothing is left waiting either.
    expect(
      await screen.findByText('Every record written on this device has reached the server.'),
    ).toBeDefined();
    expect(screen.getByText('Nothing needs a decision')).toBeDefined();
    expect(screen.queryByText('Sale T1-1')).toBeNull();
    const sale = (await harness.outbox.list())[0];
    expect(sale.status).toBe('acked');
  });

  it('lists what is held up behind the refused record', async () => {
    const harness = await stoppedQueue('Cashier');
    const [product] = await harness.backend.catalog.listProducts();
    await harness.sell(STRANDED_SESSION, product);
    await harness.runtime.sync();

    showConflicts(harness, 'Cashier');

    expect(await screen.findByText('Sale T1-2')).toBeDefined();
    expect(screen.getByText('Waiting to send')).toBeDefined();
    // Only the record the queue stopped at can be acted on.
    expect(screen.getAllByRole('button', { name: /Send again/ })).toHaveLength(1);
  });

  it('does not offer a cashier the void', async () => {
    const harness = await stoppedQueue('Cashier');

    showConflicts(harness, 'Cashier');

    expect(await screen.findByText('Sale T1-1')).toBeDefined();
    expect(screen.getByRole('button', { name: /Send again/ })).toBeDefined();
    expect(screen.queryByRole('button', { name: /Void receipt/ })).toBeNull();
  });

  it('offers an admin the void, on the record and with a reason', async () => {
    const harness = await stoppedQueue('Owner');

    showConflicts(harness, 'Owner');

    fireEvent.click(await screen.findByRole('button', { name: /Void receipt/ }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/Void receipt T1-1\?/)).toBeDefined();
    // A void has to say why, so an empty reason is refused rather than sent.
    fireEvent.click(within(dialog).getByRole('button', { name: 'Void receipt' }));
    expect(await within(dialog).findByText('Say why this receipt is being voided')).toBeDefined();
    expect((await harness.outbox.list())[0].status).toBe('conflict');
  });

  it('never offers to discard a sale, and says why where the button would be', async () => {
    const harness = await stoppedQueue('Owner');

    showConflicts(harness, 'Owner');

    const card = await findCard('Sale T1-1');
    expect(within(card).getByRole('button', { name: /Send again/ })).toBeDefined();
    expect(within(card).getByRole('button', { name: /Void receipt/ })).toBeDefined();
    expect(within(card).queryByRole('button', { name: /Discard/ })).toBeNull();
    expect(within(card).getByText(/^A sale cannot be discarded: /)).toBeDefined();
  });
});

/** Finds the card a record is shown on by its title. */
async function findCard(title: string): Promise<HTMLElement> {
  const card = (await screen.findByText(title)).closest('div[data-slot="card"]');
  if (!(card instanceof HTMLElement)) {
    throw new AppError('NOT_FOUND', `No card titled ${title}`);
  }
  return card;
}

/** What the waiter's screens load before anything goes wrong: the tables and the menu. */
function RoomLoaded() {
  useTables();
  useProducts();
  return null;
}

interface StoppedPhone {
  readonly harness: Harness;
  /** Two of `product`, put on a table taken out of service: the record the queue stopped at. */
  readonly stale: OrderOutboxRecord;
  /** One of `product` for a table in service, written after it. */
  readonly behind: OrderOutboxRecord;
  readonly retired: DiningTable;
  readonly open: DiningTable;
  readonly product: Product;
}

/** Puts `qty` of a product on a table from this phone, through its queue. */
function putOnTable(
  harness: Harness,
  tableId: string,
  productId: string,
  qty: number,
): Promise<OrderOutboxRecord> {
  return harness.outbox.appendOrder('order_item_add', async () =>
    buildOrderItemAddRecord(await orderEnvelope(harness.backend, 'waiter-phone'), {
      tableId,
      productId,
      qty,
      note: '',
    }),
  );
}

/**
 * A waiter's phone whose queue stopped: it put an item on a table the admin had just taken out of
 * service, so the server refused it with TABLE_INACTIVE, and the next item waits behind it.
 */
async function stoppedPhone(): Promise<StoppedPhone> {
  const harness = await createHarness({ signedInAs: 'Waiter' });
  const tables = await harness.backend.orders.listTables();
  const retired = tables.find((table) => !table.isActive);
  const open = tables.find((table) => table.isActive);
  const [product] = await harness.backend.catalog.listProducts();
  if (!retired || !open || !product) {
    throw new AppError('NOT_FOUND', 'The demo café needs a retired table, an open one and a menu.');
  }
  const stale = await putOnTable(harness, retired.id, product.id, 2);
  const behind = await putOnTable(harness, open.id, product.id, 1);
  await harness.runtime.sync();
  return { harness, stale, behind, retired, open, product };
}

function showPhoneConflicts(harness: Harness): void {
  harness.renderScreen(
    <>
      <RoomLoaded />
      <ConflictsPage home="/serveur" />
    </>,
    {
      allow: ['waiter'],
      allowOffline: true,
      path: '/serveur/conflicts',
      routes: [{ path: '/serveur', element: <p>Back in the room</p> }],
    },
  );
}

describe('ConflictsPage on a waiter’s phone', () => {
  it('offers to discard an order record, named from the room it loaded', async () => {
    const { harness, retired, product } = await stoppedPhone();
    expect((await harness.outbox.list()).map((record) => record.status)).toEqual([
      'conflict',
      'pending',
    ]);

    showPhoneConflicts(harness);

    const summary = `Adding 2 × ${product.name} to ${retired.name}`;
    const card = (await screen.findByText(summary)).closest('div[data-slot="card"]');
    expect(card).toBeInstanceOf(HTMLElement);
    const conflict = card as HTMLElement;
    expect(within(conflict).getByText('TABLE_INACTIVE')).toBeDefined();
    expect(within(conflict).getByText(/taken out of service/)).toBeDefined();
    expect(within(conflict).getByRole('button', { name: /Discard/ })).toBeDefined();
    // An order record is working state: nothing on it says a sale's reasons apply.
    expect(within(conflict).queryByText(/cannot be discarded/)).toBeNull();
    // Only the record the queue stopped at can be discarded, not the one waiting behind it.
    expect(screen.getAllByRole('button', { name: /Discard/ })).toHaveLength(1);
  });

  it('will not discard without a reason', async () => {
    const { harness, stale } = await stoppedPhone();

    showPhoneConflicts(harness);
    fireEvent.click(await screen.findByRole('button', { name: /Discard/ }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Why is it being discarded?'), {
      target: { value: '   ' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Discard' }));

    expect(await within(dialog).findByText('Say why this record is being discarded')).toBeDefined();
    const [record] = await harness.outbox.list();
    expect(record).toMatchObject({ id: stale.id, status: 'conflict', discard: null });
  });

  it('moves the queue on after a discard, and keeps the record in the dead-letter list', async () => {
    const { harness, stale, behind, retired, open, product } = await stoppedPhone();

    showPhoneConflicts(harness);
    fireEvent.click(await screen.findByRole('button', { name: /Discard/ }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Why is it being discarded?'), {
      target: { value: 'The guests moved inside' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Discard' }));

    // The queue goes on: the item written after it reaches its table.
    expect(
      await screen.findByText('Every record written on this device has reached the server.'),
    ).toBeDefined();
    await waitFor(async () => {
      const order = await harness.backend.orders.openOrder(open.id);
      expect(order?.items.map((item) => item.id)).toEqual([behind.id]);
    });

    const deadLetters = screen.getByRole('region', { name: 'Discarded on this device' });
    expect(
      within(deadLetters).getByText(`Adding 2 × ${product.name} to ${retired.name}`),
    ).toBeDefined();
    expect(within(deadLetters).getByText('The guests moved inside')).toBeDefined();
    expect(within(deadLetters).getByText('Demo Waiter (you)')).toBeDefined();
    expect(within(deadLetters).getByText('TABLE_INACTIVE')).toBeDefined();

    const kept = (await harness.outbox.list()).find((record) => record.id === stale.id);
    expect(kept).toMatchObject({
      status: 'discarded',
      discard: { reason: 'The guests moved inside', discardedBy: harness.user?.id },
    });
  });
});
