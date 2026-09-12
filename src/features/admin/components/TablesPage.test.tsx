import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { addToTable } from '@/features/orders/__fixtures__/seedOrders';
import { formatTND, mulQty } from '@/lib/money';
import { createHarness, type Harness } from '@/test/harness';
import { TablesPage } from './TablesPage';

async function showTables(): Promise<Harness> {
  const harness = await createHarness({ signedInAs: 'Owner' });
  harness.renderScreen(<TablesPage />, { allow: ['admin'] });
  await screen.findByText('Salle 1');
  return harness;
}

async function tableNamed(harness: Harness, name: string) {
  const table = (await harness.backend.orders.listTables()).find(
    (candidate) => candidate.name === name,
  );
  if (!table) {
    throw new Error(`The café has no table called ${name}`);
  }
  return table;
}

describe('the admin’s tables', () => {
  it('lists every table, including one that is out of service', async () => {
    await showTables();

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

  it('adds a table at the end of the room, in service, with no live updates to show it', async () => {
    const harness = await createHarness({ signedInAs: 'Owner' });
    // A backend that pushes nothing: the screen must read the room again on its own after a save.
    vi.spyOn(harness.backend.realtime, 'subscribe').mockReturnValue(() => undefined);
    harness.renderScreen(<TablesPage />, { allow: ['admin'] });
    await screen.findByText('Salle 1');

    fireEvent.click(screen.getByRole('button', { name: 'Add table' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add a table' });
    // After Terrasse 4, the last of the seeded room.
    expect(within(dialog).getByLabelText('Position')).toHaveProperty('value', '9');
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Terrasse 5' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add table' }));

    expect(await screen.findByRole('row', { name: /Terrasse 5/ })).toBeDefined();
    await expect(tableNamed(harness, 'Terrasse 5')).resolves.toMatchObject({
      sortOrder: 9,
      isActive: true,
    });
  });

  it('renames a table, moves it and takes it out of service', async () => {
    const harness = await showTables();
    const table = await tableNamed(harness, 'Salle 2');

    fireEvent.click(screen.getByRole('button', { name: 'Edit Salle 2' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit Salle 2' });
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Mezzanine' } });
    fireEvent.change(within(dialog).getByLabelText('Position'), { target: { value: '20' } });
    fireEvent.click(within(dialog).getByLabelText('In service'));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save table' }));

    const row = await screen.findByRole('row', { name: /Mezzanine/ });
    expect(within(row).getByText('Out of service')).toBeDefined();
    await waitFor(async () => {
      const saved = (await harness.backend.orders.listTables()).find(
        (candidate) => candidate.id === table.id,
      );
      expect(saved).toEqual({ id: table.id, name: 'Mezzanine', sortOrder: 20, isActive: false });
    });
  });

  it('refuses a table with no name, or with the name of another table', async () => {
    const harness = await showTables();
    const before = await harness.backend.orders.listTables();

    fireEvent.click(screen.getByRole('button', { name: 'Add table' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add a table' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add table' }));
    expect(await within(dialog).findByText('A table needs a name')).toBeDefined();

    // A retired table still holds its name.
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Terrasse 4' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add table' }));
    expect(
      await within(dialog).findByText('There is already a table called Terrasse 4'),
    ).toBeDefined();

    await expect(harness.backend.orders.listTables()).resolves.toEqual(before);
  });

  it('says so under the name when another admin took it after the form was opened', async () => {
    const harness = await showTables();

    fireEvent.click(screen.getByRole('button', { name: 'Add table' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add a table' });
    // Meanwhile, on another device of the back office.
    await harness.backend.orders.createTable({ name: 'Terrasse 5', sortOrder: 9, isActive: true });
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Terrasse 5' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add table' }));

    expect(await within(dialog).findByText('Another table already has this name.')).toBeDefined();
    const named = (await harness.backend.orders.listTables()).filter(
      (table) => table.name === 'Terrasse 5',
    );
    expect(named).toHaveLength(1);
  });

  it('keeps a table in service while guests are at it', async () => {
    const harness = await createHarness({ signedInAs: 'Owner' });
    const table = await tableNamed(harness, 'Salle 3');
    const [product] = await harness.backend.catalog.listProducts();
    await addToTable(harness.backend, table.id, product);

    harness.renderScreen(<TablesPage />, { allow: ['admin'] });
    // The row says it is owed before the form is opened, so the board has been read.
    const row = await screen.findByRole('row', { name: /Salle 3/ });
    await waitFor(() => {
      expect(row.textContent).toContain('1 item to send');
    });
    fireEvent.click(within(row).getByRole('button', { name: 'Edit Salle 3' }));

    const dialog = await screen.findByRole('dialog', { name: 'Edit Salle 3' });
    expect(within(dialog).getByLabelText('In service')).toHaveProperty('disabled', true);
    expect(
      within(dialog).getByText(
        'Guests are at this table: pay or cancel its order before taking it out of service.',
      ),
    ).toBeDefined();
  });
});
