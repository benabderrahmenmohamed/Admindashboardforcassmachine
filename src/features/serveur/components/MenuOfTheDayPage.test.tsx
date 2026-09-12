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

async function productNamed(harness: Harness, id: string): Promise<Product | undefined> {
  return (await harness.backend.catalog.listProducts()).find((product) => product.id === id);
}

describe('the waiter’s menu of the day', () => {
  it('marks a dish sold out from the phone, leaving its price alone', async () => {
    const harness = await createHarness({ signedInAs: 'Waiter' });
    const [onSale] = (await harness.backend.catalog.listProducts()).filter(
      (product) => product.isAvailable,
    );

    showMenu(harness);
    fireEvent.click(await screen.findByRole('button', { name: `Mark ${onSale.name} sold out` }));

    expect(await screen.findByRole('button', { name: `Put ${onSale.name} back on` })).toBeDefined();
    await waitFor(async () => {
      const after = await productNamed(harness, onSale.id);
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
    fireEvent.click(await screen.findByRole('button', { name: `Put ${soldOut.name} back on` }));

    expect(
      await screen.findByRole('button', { name: `Mark ${soldOut.name} sold out` }),
    ).toBeDefined();
    await waitFor(async () => {
      expect((await productNamed(harness, soldOut.id))?.isAvailable).toBe(true);
    });
  });

  it('leads back to the room', async () => {
    const harness = await createHarness({ signedInAs: 'Waiter' });

    showMenu(harness);
    fireEvent.click(await screen.findByRole('link', { name: /Room/ }));

    expect(await screen.findByText('The room')).toBeDefined();
  });
});
