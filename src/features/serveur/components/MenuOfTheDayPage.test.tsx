import { fireEvent, screen, waitFor } from '@testing-library/react';
import type { RouteObject } from 'react-router';
import { describe, expect, it } from 'vitest';
import type { Product } from '@/ports';
import { createHarness, type Harness } from '@/test/harness';
import { MenuOfTheDayPage } from './MenuOfTheDayPage';

const elsewhere: RouteObject[] = [{ path: '/serveur', element: <p>The room</p> }];

function showMenu(harness: Harness): void {
  harness.renderScreen(<MenuOfTheDayPage />, {
    allow: ['waiter'],
    allowOffline: true,
    path: '/serveur/menu',
    routes: elsewhere,
  });
}

async function productWithId(harness: Harness, id: string): Promise<Product | undefined> {
  return (await harness.backend.catalog.listProducts()).find((product) => product.id === id);
}

/** The switch of one item, named by the item and its visible label. */
function switchOf(name: string): Promise<HTMLElement> {
  return screen.findByRole('switch', { name: `${name} On the menu` });
}

describe('the waiter’s menu of the day', () => {
  it('marks a dish sold out from the phone, leaving its price alone', async () => {
    const harness = await createHarness({ signedInAs: 'Waiter' });
    const [onSale] = (await harness.backend.catalog.listProducts()).filter(
      (product) => product.isAvailable,
    );

    showMenu(harness);
    fireEvent.click(await switchOf(onSale.name));

    await waitFor(async () => {
      expect((await switchOf(onSale.name)).getAttribute('aria-checked')).toBe('false');
    });
    await waitFor(async () => {
      const after = await productWithId(harness, onSale.id);
      expect(after?.isAvailable).toBe(false);
      expect(after?.priceMillimes).toBe(onSale.priceMillimes);
    });
  });

  it('puts a dish back on the menu when the kitchen has it again', async () => {
    const harness = await createHarness({ signedInAs: 'Waiter' });
    const [soldOut] = (await harness.backend.catalog.listProducts()).filter(
      (product) => !product.isAvailable,
    );

    showMenu(harness);
    expect(await screen.findByText('1 item is sold out.', { exact: false })).toBeDefined();
    // A category's heading sits under the screen's own, which sits under the phone's header.
    expect(screen.getByRole('heading', { level: 2, name: 'Menu of the day' })).toBeDefined();
    expect(screen.getAllByRole('heading', { level: 3 }).length).toBeGreaterThan(0);
    fireEvent.click(await switchOf(soldOut.name));

    await waitFor(async () => {
      expect((await switchOf(soldOut.name)).getAttribute('aria-checked')).toBe('true');
    });
    await waitFor(async () => {
      expect((await productWithId(harness, soldOut.id))?.isAvailable).toBe(true);
    });
  });

  it('leads back to the room', async () => {
    const harness = await createHarness({ signedInAs: 'Waiter' });

    showMenu(harness);
    fireEvent.click(await screen.findByRole('link', { name: /Room/ }));

    expect(await screen.findByText('The room')).toBeDefined();
  });
});
