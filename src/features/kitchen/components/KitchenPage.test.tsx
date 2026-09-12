import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { addToTable, removeFromTable, sendTable } from '@/features/orders/__fixtures__/seedOrders';
import { createHarness, type Harness } from '@/test/harness';
import { KitchenPage } from './KitchenPage';

/**
 * A cook signs in to a café where a waiter has already been working. No one account does both — a
 * waiter takes orders, the kitchen prepares them — so the set-up runs as the waiter and the screen
 * renders as the cook, which is exactly how the two devices meet in the shop.
 */
async function waitersCafe(): Promise<Harness> {
  return createHarness({ signedInAs: 'Waiter' });
}

async function showKitchen(harness: Harness): Promise<void> {
  await harness.signInAs('Kitchen');
  harness.renderScreen(<KitchenPage />, { allow: ['kitchen'], path: '/kitchen' });
}

describe('the kitchen board', () => {
  it('has nothing to make until a waiter sends something', async () => {
    const harness = await waitersCafe();

    await showKitchen(harness);

    expect(await screen.findByText('Nothing to make')).toBeDefined();
  });

  it('shows a ticket per send, with the table, the quantities and the notes', async () => {
    const harness = await waitersCafe();
    const [table] = await harness.backend.orders.listTables();
    const [product] = await harness.backend.catalog.listProducts();
    await addToTable(harness.backend, table.id, product, { qty: 2, note: 'sans glace' });
    await sendTable(harness.backend, table.id);

    await showKitchen(harness);

    expect(await screen.findByText(table.name)).toBeDefined();
    expect(screen.getByText(`2× ${product.name}`)).toBeDefined();
    expect(screen.getByText('sans glace')).toBeDefined();
    expect(screen.getByText(/1 ticket/)).toBeDefined();
  });

  it('keeps two sends of one table apart, oldest first', async () => {
    const harness = await waitersCafe();
    const [table] = await harness.backend.orders.listTables();
    const [product, other] = await harness.backend.catalog.listProducts();
    await addToTable(harness.backend, table.id, product);
    await sendTable(harness.backend, table.id);
    // A send is identified by its moment, so the two have to be at different ones; a waiter's two
    // trips to the kitchen are minutes apart, and here a few milliseconds do.
    await new Promise((resolve) => setTimeout(resolve, 5));
    await addToTable(harness.backend, table.id, other);
    await sendTable(harness.backend, table.id);

    await showKitchen(harness);

    expect(await screen.findByText(/2 tickets/)).toBeDefined();
    const cards = screen.getAllByRole('article');
    expect(cards).toHaveLength(2);
    expect(cards[0].textContent).toContain(product.name);
    expect(cards[1].textContent).toContain(other.name);
  });

  it('marks one item prepared and takes the finished ticket off the board', async () => {
    const harness = await waitersCafe();
    const [table] = await harness.backend.orders.listTables();
    const [product] = await harness.backend.catalog.listProducts();
    const item = await addToTable(harness.backend, table.id, product);
    await sendTable(harness.backend, table.id);

    await showKitchen(harness);
    fireEvent.click(await screen.findByRole('button', { name: `Mark ${product.name} prepared` }));

    await waitFor(async () => {
      const order = await harness.backend.orders.openOrder(table.id);
      expect(order?.items.find((row) => row.id === item.id)?.preparedAt).not.toBeNull();
    });
    expect(await screen.findByText('Nothing to make')).toBeDefined();
  });

  it('stops offering an item the waiter took off after it was sent', async () => {
    const harness = await waitersCafe();
    const [table] = await harness.backend.orders.listTables();
    const [product, other] = await harness.backend.catalog.listProducts();
    const item = await addToTable(harness.backend, table.id, product);
    await addToTable(harness.backend, table.id, other);
    await sendTable(harness.backend, table.id);
    await removeFromTable(harness.backend, item.id, 'guest changed their mind');

    await showKitchen(harness);

    expect(
      await screen.findByRole('button', { name: `Mark ${other.name} prepared` }),
    ).toBeDefined();
    expect(screen.queryByRole('button', { name: `Mark ${product.name} prepared` })).toBeNull();
    // The board renders such a row as a void with its reason — `ticketBoard` is tested on that —
    // but `OrdersPort.kitchenTickets()` does not carry removed rows yet, so nothing reaches it.
    expect(screen.queryByText(/^Void:/)).toBeNull();
  });
});
