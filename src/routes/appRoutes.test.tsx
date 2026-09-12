import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { FacePath } from '@/features/auth/roles';
import { buildOrderCancelRecord } from '@/features/orders/records';
import { AppError } from '@/lib/errors';
import { createHarness, type DemoLabel } from '@/test/harness';
import { appRoutes } from './appRoutes';
import { conflictsPathOf } from './conflictsPath';

/** Each face, and a demo account whose roles open it. */
const FACES: readonly { readonly face: FacePath; readonly account: DemoLabel }[] = [
  { face: '/admin', account: 'Owner' },
  { face: '/caisse', account: 'Cashier' },
  { face: '/serveur', account: 'Waiter' },
  { face: '/kitchen', account: 'Kitchen' },
];

describe('the Conflicts screen', () => {
  it.each(FACES)(
    'is at $face/conflicts, and the sync chip there leads to it',
    async ({ face, account }) => {
      const harness = await createHarness({ signedInAs: account });

      harness.renderRoutes(appRoutes, conflictsPathOf(face));

      expect(await screen.findByRole('heading', { name: 'Conflicts' })).toBeDefined();
      expect(screen.getByText('Nothing needs a decision')).toBeDefined();
      // The back office draws its chip twice, for the phone header and the sidebar; each leads here.
      const chips = screen.getAllByRole('link', { name: /^Sync: / });
      expect(chips.map((chip) => chip.getAttribute('href'))).toEqual(
        chips.map(() => `${face}/conflicts`),
      );
      expect(screen.getByRole('link', { name: /Back/ }).getAttribute('href')).toBe(face);
    },
  );
});

describe('the back office', () => {
  it('leads with the dead-letter list of this device', async () => {
    // The owner works the counter too, and cancelled an order on a table the caisse had just paid.
    const harness = await createHarness({ signedInAs: 'Owner' });
    const [table] = await harness.backend.orders.listTables();
    if (!table) {
      throw new AppError('NOT_FOUND', 'The demo café has no tables.');
    }
    const stale = await harness.outbox.appendOrder('order_cancel', () =>
      buildOrderCancelRecord(
        { id: crypto.randomUUID(), deviceId: 'owner-till', createdAt: new Date().toISOString() },
        { tableId: table.id, reason: 'The guests left' },
      ),
    );
    await harness.runtime.sync();
    await harness.outbox.discard(stale.id, {
      reason: 'The caisse had already closed the table',
      discardedBy: harness.user?.id ?? null,
      discardedByName: harness.user?.name ?? null,
    });
    await harness.runtime.sync();

    harness.renderRoutes(appRoutes, '/admin');

    const panel = await screen.findByRole('region', {
      name: '1 order record was discarded on this device',
    });
    expect(within(panel).getByText('The caisse had already closed the table')).toBeDefined();
    expect(within(panel).getByText('ORDER_CLOSED')).toBeDefined();
    expect(
      within(panel).getByRole('link', { name: 'Open the Conflicts screen' }).getAttribute('href'),
    ).toBe('/admin/conflicts');
  });

  it('shows no dead-letter list while nothing was discarded', async () => {
    const harness = await createHarness({ signedInAs: 'Owner' });

    harness.renderRoutes(appRoutes, '/admin');

    expect(await screen.findByText('Total Products')).toBeDefined();
    expect(screen.queryByText(/discarded on this device/)).toBeNull();
  });
});
