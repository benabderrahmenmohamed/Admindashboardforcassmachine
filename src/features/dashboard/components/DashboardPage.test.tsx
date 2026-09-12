import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { createHarness } from '@/test/harness';
import { DashboardPage } from './DashboardPage';

function statNamed(title: string): HTMLElement {
  const card = screen.getByText(title).closest('a');
  if (!card) {
    throw new Error(`The ${title} card is not a link to its page`);
  }
  return card;
}

describe('DashboardPage', () => {
  it('counts what the backend holds', async () => {
    const harness = await createHarness({ signedInAs: 'Owner' });
    const products = await harness.backend.catalog.listProducts();
    const categories = await harness.backend.catalog.listCategories();

    harness.renderScreen(<DashboardPage />, { allow: ['admin'] });

    expect(await screen.findByText('Total Products')).toBeDefined();
    expect(within(statNamed('Total Products')).getByText(String(products.length))).toBeDefined();
    expect(within(statNamed('Categories')).getByText(String(categories.length))).toBeDefined();
    expect(statNamed('Total Products').getAttribute('href')).toBe('/admin/products');
  });
});
