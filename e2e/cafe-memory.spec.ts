import { expect, test } from '@playwright/test';
import {
  addToTable,
  closeReceipt,
  closeSheet,
  confirmPayment,
  continueAs,
  openApp,
  openConflicts,
  openSales,
  openSessionWithFloat,
  openTable,
  registerThisDeviceAs,
  sendToKitchen,
  signOut,
  startPayingWholeTable,
  syncChip,
  tableRow,
  tableTile,
  ticket,
} from './support/cafe';
import {
  armCommitThenDrop,
  armRefusal,
  faultCalls,
  installMemoryFaultHook,
} from './support/memoryFaults';

/**
 * The café on one device, against the credential-free demo (`VITE_BACKEND=memory`): the waiter, the
 * kitchen and the cashier take the same browser in turn, as a small café's one tablet is passed
 * round. Nothing reloads after the first load, because the demo's backend, this device's queue and
 * its terminal registration all live in the tab.
 */
test.describe('the café on one device', () => {
  test.beforeEach(async ({ page }) => {
    await installMemoryFaultHook(page);
    await openApp(page);
  });

  test('a table goes from the waiter to the kitchen and the till, through a dropped network and a lost answer', async ({
    page,
    context,
  }) => {
    // The owner makes this browser terminal T1, so the counter can take money on it later.
    await continueAs(page, 'Owner');
    await registerThisDeviceAs(page, 'T1');
    await signOut(page);

    // The waiter walks up to the table, and the network drops before the order is taken.
    await continueAs(page, 'Waiter');
    await openTable(page, 'Salle 1');
    await expect(page.getByText('Nothing on this table yet')).toBeVisible();
    await context.setOffline(true);
    await expect(page.getByText('This device is offline. Keep taking orders')).toBeVisible();
    await addToTable(
      page,
      { product: 'Café express', qty: 2, note: 'Sans sucre' },
      { product: 'Citronnade' },
    );
    await expect(tableRow(page, 'Café express')).toContainText('Sans sucre');
    await expect(tableRow(page, 'Café express')).toContainText('Not synced');
    await sendToKitchen(page, 2);
    await expect(tableRow(page, 'Citronnade')).toContainText('Sending');
    await expect(syncChip(page)).toHaveAccessibleName(/^Sync: 3 to send/);

    // The connection comes back and the phone's queue goes out on its own, in the order it was
    // written: the adds, then the send.
    await context.setOffline(false);
    await expect(syncChip(page)).toHaveAccessibleName(/^Sync: Synced/);
    const withTheKitchen = page.getByRole('region', { name: 'With the kitchen' });
    await expect(withTheKitchen.getByRole('listitem')).toHaveCount(2);
    await expect(page.getByText('Not synced')).toHaveCount(0);
    await signOut(page);

    // The kitchen makes the coffees.
    await continueAs(page, 'Kitchen');
    const card = ticket(page, 'Salle 1');
    await expect(card).toContainText('2× Café express');
    await expect(card).toContainText('Sans sucre');
    await expect(card).toContainText('1× Citronnade');
    await card.getByRole('button', { name: 'Mark Café express prepared' }).click();
    await expect(card.getByRole('button', { name: 'Mark Café express prepared' })).toHaveCount(0);
    await expect(syncChip(page)).toHaveAccessibleName(/^Sync: Synced/);
    await signOut(page);

    // The cashier takes the table's money. The answer to the payment is lost on its way back.
    await continueAs(page, 'Cashier');
    await openSessionWithFloat(page, '50.000');
    const checkout = await startPayingWholeTable(page, 'Salle 1');
    await armCommitThenDrop(page, 'sales.recordSale');
    const receipt = await confirmPayment(page, checkout);
    await expect(receipt).toContainText('T1-1');
    await closeReceipt(page);

    // The queue sends the payment again and the backend answers with the sale it already holds:
    // sent twice, recorded once, and the table is free.
    await expect(syncChip(page)).toHaveAccessibleName(/^Sync: Synced/, { timeout: 20_000 });
    const payments = (await faultCalls(page)).filter(
      (call) => call.operation === 'sales.recordSale',
    );
    expect(payments).toEqual([
      { operation: 'sales.recordSale', effect: 'drop' },
      { operation: 'sales.recordSale', effect: 'run' },
    ]);
    await expect(tableTile(page, 'Salle 1')).toContainText('Free');

    const sales = await openSales(page);
    await expect(sales.getByRole('listitem')).toHaveCount(1);
    await expect(sales.getByText('T1-1')).toBeVisible();
    await expect(sales.getByText('Waiting to send')).toHaveCount(0);
    await closeSheet(page, sales);

    // The shift ends with the drawer counted: the float and the table's cash, to the millime.
    await page.getByRole('button', { name: 'Close session' }).click();
    const closing = page.getByRole('dialog', { name: 'Close session' });
    await closing.getByLabel('Counted cash (DT)').fill('57.750');
    await closing.getByRole('button', { name: 'Close session' }).click();
    const report = page.getByRole('dialog').filter({ hasText: 'Z-report' });
    await expect(report).toBeVisible();
    await expect(report).toContainText('balanced');
  });

  test('an order the server refuses stops the phone until it is discarded with a reason', async ({
    page,
  }) => {
    await continueAs(page, 'Waiter');
    await openTable(page, 'Salle 2');

    // The first add is refused as if the table had just been taken out of service; the second waits
    // behind it, because nothing reaches a table out of order.
    await armRefusal(page, 'orders.addItem', 'TABLE_INACTIVE');
    await addToTable(page, { product: 'Thé à la menthe' }, { product: 'Café crème' });
    await expect(syncChip(page)).toHaveAccessibleName(/^Sync: 1 conflict/);
    await expect(tableRow(page, 'Thé à la menthe')).toContainText('Needs attention');

    const conflicts = await openConflicts(page);
    await expect(conflicts).toContainText('Adding 1 × Thé à la menthe to Salle 2');
    await expect(conflicts).toContainText('Waiting to send');
    await conflicts.getByRole('button', { name: 'Discard' }).click();
    const discard = page.getByRole('dialog', { name: 'Discard this record' });
    await discard.getByLabel('Why is it being discarded?').fill('The table was out of service');
    await discard.getByRole('button', { name: 'Discard' }).click();

    // The record behind it goes out, and the one given up on stays on the phone for the admin.
    await expect(syncChip(page)).toHaveAccessibleName(/^Sync: Synced, .*1 discarded/);
    await expect(conflicts).toContainText('Nothing needs a decision');
    const deadLetters = page.getByRole('region', { name: 'Discarded on this device' });
    await expect(deadLetters).toContainText('The table was out of service');
    await expect(deadLetters).toContainText('Demo Waiter (you)');
    await expect(deadLetters).toContainText('TABLE_INACTIVE');

    await page.getByRole('link', { name: 'Back' }).click();
    await openTable(page, 'Salle 2');
    await expect(tableRow(page, 'Café crème')).toBeVisible();
    await expect(tableRow(page, 'Thé à la menthe')).toHaveCount(0);
  });
});
