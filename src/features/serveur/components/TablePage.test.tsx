import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { addToTable, sendTable } from '@/features/orders/__fixtures__/seedOrders';
import { itemStage } from '@/features/orders/tableOrder';
import type { Backend, DiningTable } from '@/ports';
import { createHarness, type Harness } from '@/test/harness';
import { TablePage } from './TablePage';

async function firstTable(backend: Backend): Promise<DiningTable> {
  const [table] = await backend.orders.listTables();
  return table;
}

/**
 * The phone's network, as the browser reports it. The memory backend reads `navigator.onLine`
 * before every call, so with it off every request fails the way a dropped connection makes it fail.
 * No `offline` event is sent: the test is about the queue, not about TanStack pausing its reads.
 */
function setOnline(online: boolean): void {
  Object.defineProperty(window.navigator, 'onLine', { configurable: true, get: () => online });
}

afterEach(() => {
  // Back to jsdom's own answer, which lives on the prototype.
  Reflect.deleteProperty(window.navigator, 'onLine');
});

function showTable(harness: Harness, tableId: string): void {
  harness.renderScreen(<TablePage />, {
    allow: ['waiter'],
    allowOffline: true,
    path: '/serveur/table/:tableId',
    initialEntry: `/serveur/table/${tableId}`,
    routes: [{ path: '/serveur', element: <p>Back in the room</p> }],
  });
}

describe('a table on the waiter’s phone', () => {
  it('starts empty and has nothing to send', async () => {
    const harness = await createHarness({ signedInAs: 'Waiter' });
    const table = await firstTable(harness.backend);

    showTable(harness, table.id);

    expect(
      await screen.findByText('Nothing on this table yet. Add the first order below.'),
    ).toBeDefined();
    expect(screen.getByRole('button', { name: /Nothing to send/ })).toBeDefined();
  });

  it('adds an item from the menu with a note, and the kitchen has not been told yet', async () => {
    const harness = await createHarness({ signedInAs: 'Waiter' });
    const table = await firstTable(harness.backend);

    showTable(harness, table.id);
    fireEvent.click(await screen.findByRole('button', { name: /Add/ }));
    fireEvent.click(await screen.findByRole('button', { name: /Café express/ }));
    fireEvent.change(screen.getByLabelText('Note for the kitchen'), {
      target: { value: 'sans sucre' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add to the table' }));

    expect(await screen.findByText('sans sucre')).toBeDefined();
    // On the table at once; on the server once the queue has sent it.
    await waitFor(async () => {
      const order = await harness.backend.orders.openOrder(table.id);
      expect(order?.items.map((item) => [item.nameSnapshot, item.note, itemStage(item)])).toEqual([
        ['Café express', 'sans sucre', 'unsent'],
      ]);
    });
  });

  it('shows an item added with no network on the table at once, flagged, and once when it syncs', async () => {
    const harness = await createHarness({ signedInAs: 'Waiter' });
    const table = await firstTable(harness.backend);

    showTable(harness, table.id);
    fireEvent.click(await screen.findByRole('button', { name: /Add/ }));
    // The menu was read while the phone still had a network, as its catalog cache would have it.
    fireEvent.click(await screen.findByRole('button', { name: /Café express/ }));
    setOnline(false);
    fireEvent.click(screen.getByRole('button', { name: 'Add to the table' }));
    // Written: the sheet is back on the menu, ready for the next item.
    await screen.findByRole('button', { name: /Café express/ });
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));

    const toSend = await screen.findByRole('region', { name: 'To send' });
    expect(within(toSend).getByText('Café express')).toBeDefined();
    expect(within(toSend).getByText('Not synced')).toBeDefined();
    expect(
      screen.getByText('1 change on this device is not synced yet. It goes out on its own.'),
    ).toBeDefined();
    expect(screen.getByRole('button', { name: 'Send 1' })).toBeDefined();
    // It is on the phone, and the server could not be reached with it.
    await waitFor(async () => {
      const records = await harness.outbox.list();
      expect(records.map((record) => [record.kind, record.status, record.lastError?.code])).toEqual(
        [['order_item_add', 'pending', 'NETWORK_ERROR']],
      );
    });

    setOnline(true);
    harness.schedule.goOnline();

    await waitFor(() => {
      expect(screen.queryByText('Not synced')).toBeNull();
    });
    expect(screen.getAllByText('Café express')).toHaveLength(1);
    expect(screen.queryByText(/not synced yet/)).toBeNull();
    const [record] = await harness.outbox.list();
    expect(record.status).toBe('acked');
    const order = await harness.backend.orders.openOrder(table.id);
    expect(order?.items.map((item) => [item.id, item.nameSnapshot])).toEqual([
      [record.id, 'Café express'],
    ]);
  });

  it('opens the menu on a phone that never read the categories, chips aside', async () => {
    const harness = await createHarness({ signedInAs: 'Waiter' });
    const table = await firstTable(harness.backend);
    // The phone lost its network before it ever opened the menu: the categories never arrive.
    vi.spyOn(harness.backend.catalog, 'listCategories').mockReturnValue(new Promise(() => {}));

    showTable(harness, table.id);
    fireEvent.click(await screen.findByRole('button', { name: /Add/ }));

    const sheet = await screen.findByRole('dialog', { name: 'Add to the table' });
    expect(await within(sheet).findByRole('button', { name: /Café express/ })).toBeDefined();
    expect(within(sheet).getByRole('button', { name: 'All' })).toBeDefined();
    expect(within(sheet).queryByRole('button', { name: 'Boissons chaudes' })).toBeNull();
  });

  it('does not offer something that has sold out', async () => {
    const harness = await createHarness({ signedInAs: 'Waiter' });
    const table = await firstTable(harness.backend);

    showTable(harness, table.id);
    fireEvent.click(await screen.findByRole('button', { name: /Add/ }));

    expect(await screen.findByRole('button', { name: /Café express/ })).toBeDefined();
    // Assiette de bricks is seeded sold out for the day.
    expect(screen.queryByRole('button', { name: /Assiette de bricks/ })).toBeNull();
  });

  it('sends everything unsent to the kitchen in one go', async () => {
    const harness = await createHarness({ signedInAs: 'Waiter' });
    const table = await firstTable(harness.backend);
    const [product, other] = await harness.backend.catalog.listProducts();
    await addToTable(harness.backend, table.id, product);
    await addToTable(harness.backend, table.id, other);

    showTable(harness, table.id);
    fireEvent.click(await screen.findByRole('button', { name: /Send 2/ }));

    await waitFor(async () => {
      const order = await harness.backend.orders.openOrder(table.id);
      expect(order?.items.every((item) => item.sentAt !== null)).toBe(true);
    });
    // One send is one ticket: both rows carry the same moment.
    const order = await harness.backend.orders.openOrder(table.id);
    expect(new Set(order?.items.map((item) => item.sentAt)).size).toBe(1);
  });

  it('takes an item off only with a reason, and keeps the row', async () => {
    const harness = await createHarness({ signedInAs: 'Waiter' });
    const table = await firstTable(harness.backend);
    const [product] = await harness.backend.catalog.listProducts();
    const item = await addToTable(harness.backend, table.id, product);
    await sendTable(harness.backend, table.id);

    showTable(harness, table.id);
    fireEvent.click(
      await screen.findByRole('button', { name: `Take ${product.name} off the table` }),
    );
    const dialog = await screen.findByRole('dialog');
    // The kitchen already has it, so the waiter is told what removing it means.
    expect(within(dialog).getByText(/show on their screen as a void/)).toBeDefined();
    // No reason, no removal.
    expect(within(dialog).getByRole('button', { name: /Take it off/ })).toHaveProperty(
      'disabled',
      true,
    );

    fireEvent.change(within(dialog).getByLabelText('Why is it coming off?'), {
      target: { value: 'guest changed their mind' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: /Take it off/ }));

    await waitFor(async () => {
      const order = await harness.backend.orders.openOrder(table.id);
      const row = order?.items.find((candidate) => candidate.id === item.id);
      expect(row?.removedAt).not.toBeNull();
      expect(row?.removedReason).toBe('guest changed their mind');
    });
  });
});
