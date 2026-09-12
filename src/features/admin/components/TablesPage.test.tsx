import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { addToTable } from '@/features/orders/__fixtures__/seedOrders';
import { formatTND, mulQty } from '@/lib/money';
import { createHarness } from '@/test/harness';
import { TablesPage } from './TablesPage';

describe('the admin’s tables', () => {
  it('lists every table, including one that is out of service', async () => {
    const harness = await createHarness({ signedInAs: 'Owner' });

    harness.renderScreen(<TablesPage />, { allow: ['admin'] });

    expect(await screen.findByText('Salle 1')).toBeDefined();
    const retired = screen.getByRole('row', { name: /Terrasse 4/ });
    expect(within(retired).getByText('Out of service')).toBeDefined();
    expect(within(retired).getByText('Not in the room')).toBeDefined();
  });

  it('says what each table is doing right now', async () => {
    const harness = await createHarness({ signedInAs: 'Owner' });
    const [table] = await harness.backend.orders.listTables();
    const [product] = await harness.backend.catalog.listProducts();
    await addToTable(harness.backend, table.id, product, { qty: 3 });

    harness.renderScreen(<TablesPage />, { allow: ['admin'] });

    const row = await screen.findByRole('row', { name: new RegExp(table.name) });
    expect(row.textContent).toContain('1 item to send');
    expect(row.textContent).toContain(formatTND(mulQty(product.priceMillimes, 3)));
  });
});
