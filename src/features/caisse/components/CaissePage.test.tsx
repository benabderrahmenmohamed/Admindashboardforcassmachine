import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { RouteObject } from 'react-router';
import { describe, expect, it } from 'vitest';
import { addToTable, queueAddToTable, sendTable } from '@/features/orders/__fixtures__/seedOrders';
import { formatTND, ZERO } from '@/lib/money';
import { installWebLocks, removeWebLocks, setSecureContext } from '@/test/browserEnv';
import { createHarness, type Harness } from '@/test/harness';
import { CaissePage } from './CaissePage';

/** A session id no server has ever heard of, so the record naming it is refused. */
const STRANDED_SESSION = '00000000-0000-4000-8000-0000000000f1';

const elsewhere: RouteObject[] = [{ path: '/caisse/conflicts', element: <p>Conflicts</p> }];

function showCaisse(harness: Harness): void {
  harness.renderScreen(<CaissePage />, {
    allow: ['cashier', 'admin'],
    allowOffline: true,
    path: '/caisse',
    routes: elsewhere,
  });
}

describe('the counter gate', () => {
  it('refuses to run on a page that is not served securely', async () => {
    const harness = await createHarness({ signedInAs: 'Cashier', terminalCode: 'T1' });
    setSecureContext(false);

    showCaisse(harness);

    expect(await screen.findByText('This page is not served securely')).toBeDefined();
  });

  it('asks for the device to be registered before anything can be paid for', async () => {
    const harness = await createHarness({ signedInAs: 'Cashier' });

    showCaisse(harness);

    expect(await screen.findByText('This device is not registered as a terminal')).toBeDefined();
  });

  it('will not number receipts in a browser without Web Locks', async () => {
    const harness = await createHarness({ signedInAs: 'Cashier', terminalCode: 'T1' });
    removeWebLocks();

    showCaisse(harness);

    expect(
      await screen.findByText('This browser cannot keep the register to one tab'),
    ).toBeDefined();
  });

  it('stands aside when another tab holds the terminal', async () => {
    const harness = await createHarness({ signedInAs: 'Cashier', terminalCode: 'T1' });
    installWebLocks().hold('terminal:T1');

    showCaisse(harness);

    expect(
      await screen.findByText('This register is already open in another tab or window'),
    ).toBeDefined();
  });

  it('offers to open a session on a registered terminal that has none', async () => {
    const harness = await createHarness({ signedInAs: 'Cashier', terminalCode: 'T1' });

    showCaisse(harness);

    expect(await screen.findByText('Open a session')).toBeDefined();
    expect(screen.getByLabelText('Opening float (DT)')).toBeDefined();
  });

  it('shows the room in the session this device opened, without waiting for the server', async () => {
    const harness = await createHarness({
      signedInAs: 'Cashier',
      terminalCode: 'T1',
      // Nothing can be sent, so the session is the device's own knowledge and nothing else.
      canSend: false,
    });
    await harness.openSession();

    showCaisse(harness);

    expect(await screen.findByRole('button', { name: /Salle 1/ })).toBeDefined();
    expect(screen.getByText(/Choose a table to take payment for it/)).toBeDefined();
  });

  it('stops taking payment while the server has refused a record', async () => {
    const harness = await createHarness({ signedInAs: 'Cashier', terminalCode: 'T1' });
    const [product] = await harness.backend.catalog.listProducts();
    await harness.sell(STRANDED_SESSION, product);
    await harness.runtime.sync();

    showCaisse(harness);

    expect(await screen.findByText('The queue is stopped')).toBeDefined();
    expect(screen.getByRole('link', { name: 'Review the queue' })).toBeDefined();
  });
});

/**
 * A café where a waiter has already served a table on this device, which an admin had registered as
 * a terminal. The cashier then takes it over to work the counter, as a small shop's one tablet does.
 */
async function tableToPay() {
  const harness = await createHarness({ signedInAs: 'Waiter', terminalCode: 'T1' });
  const [table] = await harness.backend.orders.listTables();
  const [first, second] = await harness.backend.catalog.listProducts();
  await addToTable(harness.backend, table.id, first);
  await addToTable(harness.backend, table.id, second);
  await sendTable(harness.backend, table.id);
  return { harness, table, first, second };
}

async function openCounter(harness: Harness): Promise<void> {
  await harness.signInAs('Cashier');
  await harness.openSession();
  showCaisse(harness);
}

describe('paying a table', () => {
  it('takes payment for only the items that were ticked, and leaves the rest on the table', async () => {
    const { harness, table, first, second } = await tableToPay();

    await openCounter(harness);
    fireEvent.click(await screen.findByRole('button', { name: new RegExp(table.name) }));

    // Nothing is ticked to start with: paying is refused until the cashier says what for.
    expect(await screen.findByText('Choose what is being paid for')).toBeDefined();

    fireEvent.click(await screen.findByRole('checkbox', { name: new RegExp(first.name) }));

    expect(
      screen.getByRole('button', { name: `Pay ${formatTND(first.priceMillimes)}` }),
    ).toBeDefined();
    const summary = screen.getByText('Left on the table').closest('div');
    expect(summary?.textContent).toContain(formatTND(second.priceMillimes));
  });

  it('pays the whole table when everything is ticked', async () => {
    const { harness, table } = await tableToPay();

    await openCounter(harness);
    fireEvent.click(await screen.findByRole('button', { name: new RegExp(table.name) }));
    fireEvent.click(await screen.findByRole('button', { name: 'Everything' }));

    expect(screen.getByRole('button', { name: 'Pay the whole table' })).toBeDefined();
    expect(screen.queryByText('Left on the table')).toBeNull();
  });

  it('takes a line discount only with a reason, and takes it off the total', async () => {
    const { harness, table, first } = await tableToPay();

    await openCounter(harness);
    fireEvent.click(await screen.findByRole('button', { name: new RegExp(table.name) }));
    fireEvent.click(await screen.findByRole('checkbox', { name: new RegExp(first.name) }));
    fireEvent.click(screen.getByRole('button', { name: `Discount ${first.name}` }));

    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Offer the whole line' }));
    // A discount with no reason is refused rather than applied.
    expect(within(dialog).getByText('Say why this line is discounted')).toBeDefined();
    expect(within(dialog).getByRole('button', { name: 'Apply' })).toHaveProperty('disabled', true);

    fireEvent.change(within(dialog).getByLabelText('Reason'), {
      target: { value: 'erreur cuisine' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Apply' }));

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(screen.getByText(/erreur cuisine/)).toBeDefined();
    expect(screen.getByRole('button', { name: `Pay ${formatTND(ZERO)}` })).toBeDefined();
  });

  it('shows an item this device has not got onto the server yet, and does not let it be paid', async () => {
    // Nothing leaves this device, so the second item exists only in its queue.
    const harness = await createHarness({
      signedInAs: 'Waiter',
      terminalCode: 'T1',
      canSend: false,
    });
    const [table] = await harness.backend.orders.listTables();
    const [first, second] = await harness.backend.catalog.listProducts();
    await addToTable(harness.backend, table.id, first);
    await queueAddToTable(harness, table.id, second);

    await openCounter(harness);
    fireEvent.click(await screen.findByRole('button', { name: new RegExp(table.name) }));

    const held = await screen.findByRole('region', { name: 'Not payable yet' });
    expect(within(held).getByText('Changed on this device, not on the server yet.')).toBeDefined();
    expect(within(held).getByText(`1× ${second.name}`)).toBeDefined();
    expect(within(held).getByText('Not synced')).toBeDefined();
    expect(within(held).queryByRole('checkbox')).toBeNull();
    expect(screen.queryByRole('checkbox', { name: new RegExp(second.name) })).toBeNull();

    // "Everything" is everything the server has: the queued item stays on the table, unpaid.
    fireEvent.click(screen.getByRole('button', { name: 'Everything' }));
    expect(
      screen.getByRole('button', { name: `Pay ${formatTND(first.priceMillimes)}` }),
    ).toBeDefined();
    const summary = screen.getByText('Left on the table').closest('div');
    expect(summary?.textContent).toContain(formatTND(second.priceMillimes));
  });

  it('cancels the order of a table nobody paid for, with the reason given', async () => {
    const { harness, table } = await tableToPay();

    await openCounter(harness);
    fireEvent.click(await screen.findByRole('button', { name: new RegExp(table.name) }));
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel order' }));

    const dialog = await screen.findByRole('dialog', {
      name: `Cancel the order of ${table.name}?`,
    });
    const confirm = within(dialog).getByRole('button', { name: 'Cancel the order' });
    // No reason, no cancel.
    expect(confirm).toHaveProperty('disabled', true);
    fireEvent.change(within(dialog).getByLabelText('Why is the order being cancelled?'), {
      target: { value: 'The guests left' },
    });
    fireEvent.click(confirm);

    expect(
      await screen.findByText('Nothing is owed on this table. Pick another one from the room.'),
    ).toBeDefined();
    await waitFor(async () => {
      await expect(harness.backend.orders.openOrder(table.id)).resolves.toBeNull();
    });
    const records = await harness.outbox.list();
    expect(records.at(-1)).toMatchObject({
      kind: 'order_cancel',
      status: 'acked',
      payload: { tableId: table.id, reason: 'The guests left' },
    });
  });

  it('does not offer to cancel a table once part of it is paid', async () => {
    const { harness, table, first } = await tableToPay();

    await openCounter(harness);
    fireEvent.click(await screen.findByRole('button', { name: new RegExp(table.name) }));
    expect(await screen.findByRole('button', { name: 'Cancel order' })).toBeDefined();
    fireEvent.click(await screen.findByRole('checkbox', { name: new RegExp(first.name) }));
    fireEvent.click(screen.getByRole('button', { name: /^Pay / }));
    const checkout = await screen.findByRole('dialog');
    fireEvent.click(within(checkout).getByRole('button', { name: /Confirm/ }));
    expect(await screen.findByText(/T1-1/)).toBeDefined();

    // Hidden elements count: the receipt on screen hides the page from the accessibility tree.
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Cancel order', hidden: true })).toBeNull();
    });
  });

  it('records the payment and shows the receipt this terminal numbered', async () => {
    const { harness, table, first } = await tableToPay();

    await openCounter(harness);
    fireEvent.click(await screen.findByRole('button', { name: new RegExp(table.name) }));
    fireEvent.click(await screen.findByRole('checkbox', { name: new RegExp(first.name) }));
    fireEvent.click(screen.getByRole('button', { name: /^Pay / }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(new RegExp(table.name))).toBeDefined();
    fireEvent.click(within(dialog).getByRole('button', { name: /Confirm/ }));

    expect(await screen.findByText(/T1-1/)).toBeDefined();
    // On this device: the session it opened, then the sale it numbered behind it.
    const records = await harness.outbox.list();
    expect(records.map((record) => record.kind)).toEqual(['session_open', 'sale']);
  });
});
