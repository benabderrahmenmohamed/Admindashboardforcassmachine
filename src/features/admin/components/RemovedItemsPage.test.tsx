import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { addToTable, removeFromTable, sendTable } from '@/features/orders/__fixtures__/seedOrders';
import { formatTND, mulQty } from '@/lib/money';
import { createHarness, type Harness } from '@/test/harness';
import { RemovedItemsPage } from './RemovedItemsPage';

async function showReport(harness: Harness): Promise<void> {
  await harness.signInAs('Owner');
  harness.renderScreen(<RemovedItemsPage />, { allow: ['admin'] });
}

describe('the report of items removed after they were sent', () => {
  it('says so when nothing was taken off', async () => {
    const harness = await createHarness({ signedInAs: 'Waiter' });

    await showReport(harness);

    expect(
      await screen.findByText(
        'Nothing was taken off a table after the kitchen had been told, over this period.',
      ),
    ).toBeDefined();
  });

  it('names the waiter, the table, the reason and what it was worth', async () => {
    const harness = await createHarness({ signedInAs: 'Waiter' });
    const [table] = await harness.backend.orders.listTables();
    const [product] = await harness.backend.catalog.listProducts();
    const item = await addToTable(harness.backend, table.id, product, { qty: 2 });
    await sendTable(harness.backend, table.id);
    await removeFromTable(harness.backend, item.id, 'guest changed their mind');

    await showReport(harness);

    expect(await screen.findByText(/Demo Waiter/)).toBeDefined();
    expect(screen.getByText('guest changed their mind')).toBeDefined();
    const row = screen.getByRole('row', { name: new RegExp(product.name) });
    expect(row.textContent).toContain(table.name);
    // 2 units at the price they were ordered at. textContent, not a text matcher: the money text
    // carries a narrow no-break space that Testing Library's normaliser eats.
    expect(screen.getByText(/2 units/)).toBeDefined();
    expect(row.textContent).toContain(formatTND(mulQty(product.priceMillimes, 2)));
  });

  it('leaves out an item taken off before the kitchen was told', async () => {
    const harness = await createHarness({ signedInAs: 'Waiter' });
    const [table] = await harness.backend.orders.listTables();
    const [product] = await harness.backend.catalog.listProducts();
    const item = await addToTable(harness.backend, table.id, product);
    await removeFromTable(harness.backend, item.id, 'ordered by mistake');

    await showReport(harness);

    expect(
      await screen.findByText(
        'Nothing was taken off a table after the kitchen had been told, over this period.',
      ),
    ).toBeDefined();
  });
});
