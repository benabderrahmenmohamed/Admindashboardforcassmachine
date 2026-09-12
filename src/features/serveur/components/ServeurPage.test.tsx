import { fireEvent, screen } from '@testing-library/react';
import type { RouteObject } from 'react-router';
import { describe, expect, it } from 'vitest';
import { addToTable } from '@/features/orders/__fixtures__/seedOrders';
import { add, formatTND, mulQty } from '@/lib/money';
import { createHarness, type Harness } from '@/test/harness';
import { ServeurPage } from './ServeurPage';

const elsewhere: RouteObject[] = [
  { path: '/serveur/table/:tableId', element: <p>The table is open</p> },
];

function showRoom(harness: Harness): void {
  harness.renderScreen(<ServeurPage />, {
    allow: ['waiter'],
    allowOffline: true,
    path: '/serveur',
    routes: elsewhere,
  });
}

describe('the waiter’s room', () => {
  it('shows the café’s tables, and not one that is out of service', async () => {
    const harness = await createHarness({ signedInAs: 'Waiter' });

    showRoom(harness);

    expect(await screen.findByText('Salle 1')).toBeDefined();
    expect(screen.getByText('Comptoir')).toBeDefined();
    // Terrasse 4 is seeded inactive: a table out of service must not be tappable.
    expect(screen.queryByText('Terrasse 4')).toBeNull();
  });

  it('says what a table owes and what the kitchen has not been told about', async () => {
    const harness = await createHarness({ signedInAs: 'Waiter' });
    const [table] = await harness.backend.orders.listTables();
    const [product, other] = await harness.backend.catalog.listProducts();
    // Two rows, the first of two units: the tile counts rows, and the money counts units.
    await addToTable(harness.backend, table.id, product, { qty: 2 });
    await addToTable(harness.backend, table.id, other);
    const due = formatTND(add(mulQty(product.priceMillimes, 2), other.priceMillimes));

    showRoom(harness);

    const tile = await screen.findByRole('button', { name: new RegExp(table.name) });
    expect(tile.textContent).toContain('2 items to send');
    expect(tile.textContent).toContain(due);
    expect(tile.textContent).toContain('To send');
  });

  it('opens a table when it is tapped', async () => {
    const harness = await createHarness({ signedInAs: 'Waiter' });

    showRoom(harness);
    fireEvent.click(await screen.findByRole('button', { name: /Salle 1/ }));

    expect(await screen.findByText('The table is open')).toBeDefined();
  });

  it('leaves a free table saying so', async () => {
    const harness = await createHarness({ signedInAs: 'Waiter' });

    showRoom(harness);

    const tile = await screen.findByRole('button', { name: /Salle 2/ });
    expect(tile.textContent).toContain('Free');
  });
});
