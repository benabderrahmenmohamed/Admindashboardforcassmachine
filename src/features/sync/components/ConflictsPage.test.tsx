import { fireEvent, screen, within } from '@testing-library/react';
import type { RouteObject } from 'react-router';
import { describe, expect, it } from 'vitest';
import type { Role } from '@/ports';
import { createHarness, type Harness } from '@/test/harness';
import { ConflictsPage } from './ConflictsPage';

/** A session id no server has ever heard of, so the record naming it is refused. */
const STRANDED_SESSION = '00000000-0000-4000-8000-0000000000f3';

/** The two faces that carry a queue: the counter, and the back office where a void is possible. */
const GUARDS: Record<'Cashier' | 'Owner', { readonly role: Role; readonly home: string }> = {
  Cashier: { role: 'cashier', home: '/caisse' },
  Owner: { role: 'admin', home: '/admin' },
};

type QueueLabel = keyof typeof GUARDS;

/**
 * A device whose queue has stopped: it wrote a sale in a session the server does not have, so the
 * server refused it and nothing behind it can go out either.
 */
async function stoppedQueue(signedInAs: QueueLabel): Promise<Harness> {
  const harness = await createHarness({ signedInAs, terminalCode: 'T1' });
  const [product] = await harness.backend.catalog.listProducts();
  await harness.sell(STRANDED_SESSION, product);
  await harness.runtime.sync();
  return harness;
}

function showConflicts(harness: Harness, signedInAs: QueueLabel): void {
  const { role, home } = GUARDS[signedInAs];
  const routes: RouteObject[] = [{ path: home, element: <p>Back at work</p> }];
  harness.renderScreen(<ConflictsPage home={home} />, {
    allow: [role],
    allowOffline: true,
    path: `${home}/conflicts`,
    routes,
  });
}

describe('ConflictsPage', () => {
  it('shows the refused record and sends it again once the cause is gone', async () => {
    const harness = await stoppedQueue('Cashier');

    showConflicts(harness, 'Cashier');

    const card = (await screen.findByText('Sale T1-1')).closest('div[data-slot="card"]');
    expect(card).toBeInstanceOf(HTMLElement);
    const conflict = card as HTMLElement;
    expect(within(conflict).getByText('NOT_FOUND')).toBeDefined();
    expect(within(conflict).getByText('Needs attention')).toBeDefined();

    // The session it names is opened on the server after all, so the record can be recorded now.
    await harness.openSessionOnServer(STRANDED_SESSION);
    fireEvent.click(within(conflict).getByRole('button', { name: /Send again/ }));

    // Not merely "no conflicts": a retried record is out of conflict the moment it is sent again,
    // so what proves it went through is that nothing is left waiting either.
    expect(
      await screen.findByText('Every record written on this device has reached the server.'),
    ).toBeDefined();
    expect(screen.getByText('Nothing needs a decision')).toBeDefined();
    expect(screen.queryByText('Sale T1-1')).toBeNull();
    const sale = (await harness.outbox.list())[0];
    expect(sale.status).toBe('acked');
  });

  it('lists what is held up behind the refused record', async () => {
    const harness = await stoppedQueue('Cashier');
    const [product] = await harness.backend.catalog.listProducts();
    await harness.sell(STRANDED_SESSION, product);
    await harness.runtime.sync();

    showConflicts(harness, 'Cashier');

    expect(await screen.findByText('Sale T1-2')).toBeDefined();
    expect(screen.getByText('Waiting to send')).toBeDefined();
    // Only the record the queue stopped at can be acted on.
    expect(screen.getAllByRole('button', { name: /Send again/ })).toHaveLength(1);
  });

  it('does not offer a cashier the void', async () => {
    const harness = await stoppedQueue('Cashier');

    showConflicts(harness, 'Cashier');

    expect(await screen.findByText('Sale T1-1')).toBeDefined();
    expect(screen.getByRole('button', { name: /Send again/ })).toBeDefined();
    expect(screen.queryByRole('button', { name: /Void receipt/ })).toBeNull();
  });

  it('offers an admin the void, on the record and with a reason', async () => {
    const harness = await stoppedQueue('Owner');

    showConflicts(harness, 'Owner');

    fireEvent.click(await screen.findByRole('button', { name: /Void receipt/ }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/Void receipt T1-1\?/)).toBeDefined();
    // A void has to say why, so an empty reason is refused rather than sent.
    fireEvent.click(within(dialog).getByRole('button', { name: 'Void receipt' }));
    expect(await within(dialog).findByText('Say why this receipt is being voided')).toBeDefined();
    expect((await harness.outbox.list())[0].status).toBe('conflict');
  });
});
