import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { Product } from '@/ports';
import { createHarness, type Harness } from '@/test/harness';
import { PRICE_FORMAT_MESSAGE } from '../schema';
import { ProductsPage } from './ProductsPage';

const MILK = 'Lait demi-écrémé 1 L';

async function productNamed(harness: Harness, name: string): Promise<Product> {
  const product = (await harness.backend.catalog.listProducts()).find(
    (candidate) => candidate.name === name,
  );
  if (!product) {
    throw new Error(`The seeded catalog has no product called ${name}`);
  }
  return product;
}

function field(dialog: HTMLElement, label: string): HTMLInputElement {
  const input = within(dialog).getByLabelText(label);
  if (!(input instanceof HTMLInputElement)) {
    throw new Error(`${label} is not a text field`);
  }
  return input;
}

describe('the product form', () => {
  it('says what is wrong with each field instead of saving it', async () => {
    const harness = await createHarness({ signedInAs: 'Admin' });
    const before = (await harness.backend.catalog.listProducts()).length;

    harness.renderScreen(<ProductsPage />, { allow: ['admin'] });
    fireEvent.click(await screen.findByRole('button', { name: /Add Product/ }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create Product' }));

    // An empty form: the two fields that have no sensible default.
    expect(await within(dialog).findByText('Product name is required')).toBeDefined();
    expect(within(dialog).getByText('Price is required')).toBeDefined();

    fireEvent.change(field(dialog, 'Product Name *'), { target: { value: 'Café moulu 250 g' } });
    fireEvent.change(field(dialog, 'Price *'), { target: { value: '8,750 DT' } });
    fireEvent.change(field(dialog, 'Opening Stock'), { target: { value: '1.5' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create Product' }));

    expect(await within(dialog).findByText(PRICE_FORMAT_MESSAGE)).toBeDefined();
    expect(within(dialog).getByText('Stock must be a whole number')).toBeDefined();
    // The name is good now, so its message is gone.
    expect(within(dialog).queryByText('Product name is required')).toBeNull();

    expect(await harness.backend.catalog.listProducts()).toHaveLength(before);
  });

  it('saves an edited stock as the change from the stock the form opened with', async () => {
    const harness = await createHarness({ signedInAs: 'Admin', terminalCode: 'T1' });
    const milk = await productNamed(harness, MILK);
    expect(milk.stock).toBe(60);

    harness.renderScreen(<ProductsPage />, { allow: ['admin'] });
    const row = await screen.findByRole('row', { name: new RegExp(MILK) });
    // The edit and archive buttons carry no accessible name: the pencil is the row's first button.
    fireEvent.click(within(row).getAllByRole('button')[0]);
    const dialog = await screen.findByRole('dialog');
    expect(field(dialog, 'Stock Quantity').value).toBe('60');

    // Two are sold on this device while the form is open, and reach the ledger.
    const session = await harness.openSession();
    await harness.runtime.sync();
    await harness.sell(session.sessionId, milk, 2);
    await harness.runtime.sync();
    expect((await productNamed(harness, MILK)).stock).toBe(58);

    // The stocktake counted 65 against the 60 the form showed: five more than it opened with.
    fireEvent.change(field(dialog, 'Stock Quantity'), { target: { value: '65' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Update Product' }));

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect((await productNamed(harness, MILK)).stock).toBe(63);
  });
});
