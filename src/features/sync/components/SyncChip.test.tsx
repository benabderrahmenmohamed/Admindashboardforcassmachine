import { screen } from '@testing-library/react';
import type { RouteObject } from 'react-router';
import { describe, expect, it } from 'vitest';
import { createHarness, type Harness } from '@/test/harness';
import { SyncChip } from './SyncChip';

/** A session id no server has ever heard of, so the record naming it is refused. */
const STRANDED_SESSION = '00000000-0000-4000-8000-0000000000f2';

function showChip(harness: Harness): void {
  const routes: RouteObject[] = [
    { path: '/pos', element: <SyncChip conflictsPath="/pos/conflicts" /> },
  ];
  harness.renderRoutes(routes, '/pos');
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
    expect(chip.getAttribute('href')).toBe('/pos/conflicts');
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
});
