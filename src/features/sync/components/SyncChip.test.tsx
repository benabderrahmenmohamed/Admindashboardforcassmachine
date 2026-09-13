import { screen, within } from '@testing-library/react';
import type { RouteObject } from 'react-router';
import { describe, expect, it } from 'vitest';
import { buildOrderItemAddRecord } from '@/features/orders/records';
import { AppError } from '@/lib/errors';
import { createHarness, type Harness } from '@/test/harness';
import { SyncChip } from './SyncChip';

/** A session id no server has ever heard of, so the record naming it is refused. */
const STRANDED_SESSION = '00000000-0000-4000-8000-0000000000f2';

function showChip(harness: Harness): void {
  const routes: RouteObject[] = [
    { path: '/caisse', element: <SyncChip conflictsPath="/caisse/conflicts" /> },
  ];
  harness.renderRoutes(routes, '/caisse');
}

describe('SyncChip', () => {
  it('counts what this device is still holding', async () => {
    const harness = await createHarness({
      signedInAs: 'Cashier',
      terminalCode: 'T1',
      // An expired sign-in: the records are written and kept, and nothing goes out.
      canSend: false,
    });
    const [product] = await harness.backend.catalog.listProducts();
    const session = await harness.openSession();
    await harness.sell(session.sessionId, product);
    await harness.runtime.sync();

    showChip(harness);

    const chip = await screen.findByRole('link', { name: /2 to send/ });
    expect(chip.getAttribute('href')).toBe('/caisse/conflicts');
    expect(screen.getByText('nothing sent yet')).toBeDefined();
  });

  it('says everything is synced once the server has taken it', async () => {
    const harness = await createHarness({ signedInAs: 'Cashier', terminalCode: 'T1' });
    const [product] = await harness.backend.catalog.listProducts();
    const session = await harness.openSession();
    await harness.sell(session.sessionId, product);
    await harness.runtime.sync();

    showChip(harness);

    expect(await screen.findByRole('link', { name: /Synced/ })).toBeDefined();
    expect(screen.getByText('last sent just now')).toBeDefined();
  });

  it('leads with the conflict when the server refused a record', async () => {
    const harness = await createHarness({ signedInAs: 'Cashier', terminalCode: 'T1' });
    const [product] = await harness.backend.catalog.listProducts();
    await harness.sell(STRANDED_SESSION, product);
    await harness.runtime.sync();

    showChip(harness);

    expect(await screen.findByRole('link', { name: /1 conflict/ })).toBeDefined();
  });

  it('counts the dead-letter list on a waiter’s phone, quietly beside the state', async () => {
    const harness = await createHarness({ signedInAs: 'Waiter' });
    const retired = (await harness.backend.orders.listTables()).find((table) => !table.isActive);
    const [product] = await harness.backend.catalog.listProducts();
    if (!retired) {
      throw new AppError('NOT_FOUND', 'The demo café needs a table taken out of service.');
    }
    // An item for a table taken out of service: refused, then given up on with a reason.
    const stale = await harness.outbox.appendOrder('order_item_add', () =>
      buildOrderItemAddRecord(
        { id: crypto.randomUUID(), deviceId: 'waiter-phone', createdAt: new Date().toISOString() },
        { tableId: retired.id, productId: product.id, qty: 1, note: '' },
      ),
    );
    await harness.runtime.sync();
    await harness.outbox.discard(stale.id, {
      reason: 'The guests moved inside',
      discardedBy: harness.user?.id ?? null,
      discardedByName: harness.user?.name ?? null,
    });
    await harness.runtime.sync();

    harness.renderRoutes(
      [{ path: '/serveur', element: <SyncChip conflictsPath="/serveur/conflicts" /> }],
      '/serveur',
    );

    // The queue is through, so the chip says so, and counts what was discarded beside it.
    const chip = await screen.findByRole('link', { name: /^Sync: Synced .* 1 discarded\./ });
    expect(chip.getAttribute('href')).toBe('/serveur/conflicts');
    expect(within(chip).getByText('1')).toBeDefined();
    expect(within(chip).getByText('discarded')).toBeDefined();
  });
});
