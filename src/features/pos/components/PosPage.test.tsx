import { screen } from '@testing-library/react';
import type { RouteObject } from 'react-router';
import { describe, expect, it } from 'vitest';
import { installWebLocks, removeWebLocks, setSecureContext } from '@/test/browserEnv';
import { createHarness, type Harness } from '@/test/harness';
import { PosPage } from './PosPage';

/** A session id no server has ever heard of, so the record naming it is refused. */
const STRANDED_SESSION = '00000000-0000-4000-8000-0000000000f1';

const elsewhere: RouteObject[] = [{ path: '/pos/conflicts', element: <p>Conflicts</p> }];

function showRegister(harness: Harness): void {
  harness.renderScreen(<PosPage />, {
    allow: ['cashier'],
    allowOffline: true,
    path: '/pos',
    routes: elsewhere,
  });
}

describe('the register gate', () => {
  it('refuses to run on a page that is not served securely', async () => {
    const harness = await createHarness({ signedInAs: 'Cashier', terminalCode: 'T1' });
    setSecureContext(false);

    showRegister(harness);

    expect(await screen.findByText('This page is not served securely')).toBeDefined();
  });

  it('asks for the device to be registered before anything can be sold', async () => {
    const harness = await createHarness({ signedInAs: 'Cashier' });

    showRegister(harness);

    expect(await screen.findByText('This device is not registered as a terminal')).toBeDefined();
  });

  it('will not number receipts in a browser without Web Locks', async () => {
    const harness = await createHarness({ signedInAs: 'Cashier', terminalCode: 'T1' });
    removeWebLocks();

    showRegister(harness);

    expect(
      await screen.findByText('This browser cannot keep the register to one tab'),
    ).toBeDefined();
  });

  it('stands aside when another tab holds the terminal', async () => {
    const harness = await createHarness({ signedInAs: 'Cashier', terminalCode: 'T1' });
    installWebLocks().hold('terminal:T1');

    showRegister(harness);

    expect(
      await screen.findByText('This register is already open in another tab or window'),
    ).toBeDefined();
  });

  it('offers to open a session on a registered terminal that has none', async () => {
    const harness = await createHarness({ signedInAs: 'Cashier', terminalCode: 'T1' });

    showRegister(harness);

    expect(await screen.findByText('Open a session')).toBeDefined();
    expect(screen.getByLabelText('Opening float (DT)')).toBeDefined();
  });

  it('sells in the session this device opened, without waiting for the server', async () => {
    const harness = await createHarness({
      signedInAs: 'Cashier',
      terminalCode: 'T1',
      // Nothing can be sent, so the session is the device's own knowledge and nothing else.
      canSend: false,
    });
    await harness.openSession();

    showRegister(harness);

    expect(await screen.findByPlaceholderText('Scan or enter barcode...')).toBeDefined();
    expect(await screen.findByText('Lait demi-écrémé 1 L')).toBeDefined();
  });

  it('stops selling while the server has refused a record', async () => {
    const harness = await createHarness({ signedInAs: 'Cashier', terminalCode: 'T1' });
    const [product] = await harness.backend.catalog.listProducts();
    await harness.sell(STRANDED_SESSION, product);
    await harness.runtime.sync();

    showRegister(harness);

    expect(await screen.findByText('The queue is stopped')).toBeDefined();
    expect(screen.getByRole('link', { name: 'Review the queue' })).toBeDefined();
  });
});
