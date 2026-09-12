import { fireEvent, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { createHarness } from '@/test/harness';
import { ProductsPage } from './ProductsPage';

describe('ProductsPage', () => {
  it('lists what the catalog holds', async () => {
    const harness = await createHarness({ signedInAs: 'Owner' });
    const products = await harness.backend.catalog.listProducts();

    harness.renderScreen(<ProductsPage />, { allow: ['admin'] });

    expect(await screen.findByText(`Products (${products.length})`)).toBeDefined();
    const row = screen.getByRole('row', { name: /Eau minérale 50 cl/ });
    // Its category and barcode come from the backend too, not from the row's own name.
    expect(within(row).getByText('Boissons fraîches')).toBeDefined();
    expect(within(row).getByText('6194000100015')).toBeDefined();
  });

  it('searches the list the backend gave it', async () => {
    const harness = await createHarness({ signedInAs: 'Owner' });

    harness.renderScreen(<ProductsPage />, { allow: ['admin'] });
    const search = await screen.findByPlaceholderText(
      'Search products by name, category, or barcode...',
    );
    fireEvent.change(search, { target: { value: 'citronnade' } });

    expect(await screen.findByText('Products (1)')).toBeDefined();
    expect(screen.getByText('Citronnade')).toBeDefined();
    expect(screen.queryByText('Eau minérale 50 cl')).toBeNull();
  });
});
