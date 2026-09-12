import { expect, test } from '@playwright/test';
import {
  closeReceipt,
  closeSales,
  MILK,
  openDemo,
  openSales,
  openSessionWithFloat,
  readConflictsScreen,
  registerThisDeviceAs,
  sellOne,
  signInAs,
  signOut,
  syncChip,
  WATER,
  YOGHURT,
} from './support/demo';
import { armCommitThenDrop, faultCalls, installMemoryFaultHook } from './support/memoryFaults';

/**
 * The register against the credential-free demo (`VITE_BACKEND=memory`). Both tests set the device
 * up inside the app — sign in, register the terminal, open a session — and never reload after the
 * first load: the demo's backend, this device's queue and its registration all live in the tab.
 */
test.describe('selling with no network', () => {
  test('numbers receipts offline and sends every one of them when the connection is back', async ({
    page,
    context,
  }) => {
    await openDemo(page);

    // An admin makes this browser terminal T1, then hands it to the cashier.
    await signInAs(page, 'Admin');
    await registerThisDeviceAs(page, 'T1');
    await signOut(page);

    await signInAs(page, 'Cashier');
    await openSessionWithFloat(page, '50.000');
    await expect(syncChip(page)).toHaveAccessibleName(/Synced/);

    await context.setOffline(true);
    await expect(page.getByText('This device is offline')).toBeVisible();

    // Two sales with no network at all: each is written, numbered and shown on the spot.
    const first = await sellOne(page, WATER.barcode);
    await expect(first).toContainText('T1-1');
    await expect(first).toContainText('Waiting to send');
    await closeReceipt(page);

    const second = await sellOne(page, MILK.barcode);
    await expect(second).toContainText('T1-2');
    await expect(second).toContainText('Waiting to send');
    await closeReceipt(page);

    // Still offline: both receipts are on the device, with their numbers and where they stand.
    const offlineSales = await openSales(page);
    await expect(offlineSales.getByText('T1-1')).toBeVisible();
    await expect(offlineSales.getByText('T1-2')).toBeVisible();
    await expect(offlineSales.getByText('Waiting to send')).toHaveCount(2);
    await closeSales(page);

    await expect(syncChip(page)).toHaveAccessibleName(/2 to send/);

    await context.setOffline(false);

    // The queue goes out on its own the moment the connection is back.
    await expect(syncChip(page)).toHaveAccessibleName(/Synced/);
    await expect(page.getByText('This device is offline')).toBeHidden();

    const syncedSales = await openSales(page);
    await expect(syncedSales.getByText('T1-1')).toBeVisible();
    await expect(syncedSales.getByText('T1-2')).toBeVisible();
    await expect(syncedSales.getByText('Waiting to send')).toHaveCount(0);
    await expect(syncedSales.getByRole('listitem')).toHaveCount(2);
    await closeSales(page);

    const conflicts = await readConflictsScreen(page);
    await expect(conflicts).toContainText('Nothing needs a decision');
    await expect(conflicts).toContainText(
      'Every record written on this device has reached the server.',
    );
  });

  test('replays a sale whose answer was lost, with no duplicate and no skipped number', async ({
    page,
  }) => {
    // The backend commits the next sale and then loses the answer, as a response lost on the way
    // back: the device cannot tell whether it landed, so its only move is to send the record again.
    await installMemoryFaultHook(page);
    await openDemo(page);

    await signInAs(page, 'Admin');
    await registerThisDeviceAs(page, 'T1');
    await signOut(page);

    await signInAs(page, 'Cashier');
    await openSessionWithFloat(page, '50.000');
    await expect(syncChip(page)).toHaveAccessibleName(/Synced/);
    await expect(page.getByText(`${YOGHURT.stock} left`)).toBeVisible();

    await armCommitThenDrop(page, 'sales.recordSale');

    const receipt = await sellOne(page, YOGHURT.barcode);
    await expect(receipt).toContainText('T1-1');
    await closeReceipt(page);

    // The queue retries on its own and the backend answers with the receipt it already holds: the
    // record was sent exactly twice, once committed with its answer lost and once replayed.
    await expect(syncChip(page)).toHaveAccessibleName(/Synced/, { timeout: 20_000 });
    const sent = (await faultCalls(page)).filter((call) => call.operation === 'sales.recordSale');
    expect(sent).toEqual([
      { operation: 'sales.recordSale', effect: 'drop' },
      { operation: 'sales.recordSale', effect: 'run' },
    ]);

    // One unit left the shelf, not two: the replay was answered from the record already stored.
    await expect(page.getByText(`${YOGHURT.stock - 1} left`)).toBeVisible();
    await expect(page.getByText(`${YOGHURT.stock - 2} left`)).toBeHidden();

    // And the number behind it is the next one, so the replay spent no receipt of its own.
    const next = await sellOne(page, MILK.barcode);
    await expect(next).toContainText('T1-2');
    await closeReceipt(page);
    await expect(syncChip(page)).toHaveAccessibleName(/Synced/);

    const sales = await openSales(page);
    await expect(sales.getByRole('listitem')).toHaveCount(2);
    await expect(sales.getByText('T1-1')).toBeVisible();
    await expect(sales.getByText('T1-2')).toBeVisible();
    await expect(sales.getByText('Waiting to send')).toHaveCount(0);
    await closeSales(page);

    const conflicts = await readConflictsScreen(page);
    await expect(conflicts).toContainText('Nothing needs a decision');
    await expect(conflicts).toContainText(
      'Every record written on this device has reached the server.',
    );
  });
});
