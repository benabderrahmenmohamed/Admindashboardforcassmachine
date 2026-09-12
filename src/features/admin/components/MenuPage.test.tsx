import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { formatTND } from '@/lib/money';
import type { Product } from '@/ports';
import { createHarness, type Harness } from '@/test/harness';
import { MenuPage } from './MenuPage';

async function soldOutProducts(harness: Harness): Promise<Product[]> {
  const products = await harness.backend.catalog.listProducts();
  return products.filter((product) => !product.isAvailable);
}

function rowOf(name: string): HTMLElement {
  const row = screen.getByText(name).closest('li');
  if (!(row instanceof HTMLElement)) {
    throw new Error(`${name} is not on a menu row`);
  }
  return row;
}

describe('the admin’s menu', () => {
  it('groups the menu by category, in the admin’s own order', async () => {
    const harness = await createHarness({ signedInAs: 'Owner' });

    harness.renderScreen(<MenuPage />, { allow: ['admin'] });

    expect(await screen.findByText('Boissons fraîches')).toBeDefined();
    const headings = screen.getAllByRole('heading', { level: 4 }).map((node) => node.textContent);
    expect(headings.indexOf('Boissons fraîches')).toBeLessThan(headings.indexOf('Snacks'));
  });

  it('marks what has sold out today, and counts it', async () => {
    const harness = await createHarness({ signedInAs: 'Owner' });
    const products = await harness.backend.catalog.listProducts();
    const soldOut = await soldOutProducts(harness);
    expect(soldOut.length).toBeGreaterThan(0);

    harness.renderScreen(<MenuPage />, { allow: ['admin'] });

    expect(
      await screen.findByText(new RegExp(`${soldOut.length} of ${products.length} sold`)),
    ).toBeDefined();
    const row = rowOf(soldOut[0].name);
    expect(
      within(row).getByRole('button', { name: `Put ${soldOut[0].name} back on` }),
    ).toBeDefined();
    // textContent, not a text matcher: the money text carries a narrow no-break space that
    // Testing Library's normaliser eats, and the point here is the exact money text.
    expect(row.textContent).toContain(formatTND(soldOut[0].priceMillimes));
  });

  it('takes an item off the menu for the day without touching its price', async () => {
    const harness = await createHarness({ signedInAs: 'Owner' });
    const [onSale] = (await harness.backend.catalog.listProducts()).filter(
      (product) => product.isAvailable,
    );

    harness.renderScreen(<MenuPage />, { allow: ['admin'] });
    fireEvent.click(await screen.findByRole('button', { name: `Mark ${onSale.name} sold out` }));

    expect(await screen.findByRole('button', { name: `Put ${onSale.name} back on` })).toBeDefined();
    await waitFor(async () => {
      const after = (await harness.backend.catalog.listProducts()).find(
        (product) => product.id === onSale.id,
      );
      expect(after?.isAvailable).toBe(false);
      expect(after?.priceMillimes).toBe(onSale.priceMillimes);
    });
  });

  it('puts a sold-out item back on', async () => {
    const harness = await createHarness({ signedInAs: 'Owner' });
    const [soldOut] = await soldOutProducts(harness);

    harness.renderScreen(<MenuPage />, { allow: ['admin'] });
    fireEvent.click(await screen.findByRole('button', { name: `Put ${soldOut.name} back on` }));

    expect(
      await screen.findByRole('button', { name: `Mark ${soldOut.name} sold out` }),
    ).toBeDefined();
  });
});
