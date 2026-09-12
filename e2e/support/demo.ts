/**
 * The demo as a person drives it. Every helper here works the screens the way a cashier or an admin
 * does — roles and the words on screen, never a class name — so a rewrite of the markup that keeps
 * the app usable keeps these tests passing.
 *
 * Nothing reloads the page after the first load on purpose: with `VITE_BACKEND=memory` the backend,
 * this device's queue and its terminal registration all live in the tab, and a reload starts them
 * empty again.
 */
import { expect, type Locator, type Page } from '@playwright/test';

/** Products of the demo seed (`src/adapters/memory/seed.ts`), by the barcode a scanner sends. */
export const WATER = { barcode: '6194000100015', name: 'Eau minérale 1,5 L' } as const;
export const MILK = { barcode: '6194000200012', name: 'Lait demi-écrémé 1 L' } as const;
/** The only product the seed leaves low enough for the grid to print what is left of it. */
export const YOGHURT = { barcode: '6194000200029', name: 'Yaourt nature x4', stock: 8 } as const;

/** Loads the demo and waits for the credential-free sign-in to be there. */
export async function openDemo(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Continue as Admin' })).toBeVisible();
}

export async function signInAs(page: Page, who: 'Admin' | 'Cashier'): Promise<void> {
  await page.getByRole('button', { name: `Continue as ${who}` }).click();
}

export async function signOut(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Logout' }).click();
  await expect(page.getByRole('button', { name: 'Continue as Admin' })).toBeVisible();
}

/** Admin only: registers the browser this test drives as terminal `code`, from Settings. */
export async function registerThisDeviceAs(page: Page, code: string): Promise<void> {
  // Exact: the dashboard also has a "POS Settings" shortcut to the same screen.
  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
  await page.getByLabel('Register As').fill(code);
  // The card asks before registering, and Playwright dismisses a dialog nobody handles.
  page.once('dialog', (dialog) => void dialog.accept());
  await page.getByRole('button', { name: 'Register Device' }).click();

  await expect(page.getByText(`This device is now terminal ${code}`)).toBeVisible();
  await expect(page.getByText('Last Receipt')).toBeVisible();
  await expect(page.getByText(code, { exact: true })).toBeVisible();
}

/** Cashier: opens the terminal's session with a counted float, in dinars. */
export async function openSessionWithFloat(page: Page, float: string): Promise<void> {
  await expect(page.getByRole('heading', { name: 'Open a session' })).toBeVisible();
  await page.getByLabel('Opening float (DT)').fill(float);
  await page.getByRole('button', { name: 'Open session' }).click();
  // The register is on screen once the session is on this device; it never waits for the server.
  await expect(page.getByRole('button', { name: 'Close session' })).toBeVisible();
  await expect(page.getByPlaceholder('Scan or enter barcode...')).toBeVisible();
}

/** The receipt the register puts on screen the moment a sale is written; it is the only dialog with
 * a Done button. */
export function receiptDialog(page: Page): Locator {
  return page
    .getByRole('dialog')
    .filter({ has: page.getByRole('button', { name: 'Done' }) })
    .first();
}

/**
 * Scans `barcode`, pays the exact total in cash and leaves the receipt on screen for the caller to
 * read. Nothing here waits for the network: the receipt is written and numbered on the device.
 */
export async function sellOne(page: Page, barcode: string): Promise<Locator> {
  const scanner = page.getByPlaceholder('Scan or enter barcode...');
  await scanner.fill(barcode);
  await scanner.press('Enter');

  await page.getByRole('button', { name: 'Checkout' }).click();
  await expect(page.getByRole('heading', { name: 'Complete Payment' })).toBeVisible();
  await page.getByRole('button', { name: 'Confirm' }).click();

  const receipt = receiptDialog(page);
  await expect(receipt).toBeVisible();
  return receipt;
}

export async function closeReceipt(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Done' }).click();
  await expect(receiptDialog(page)).toBeHidden();
}

/** The chip in the top bar: the one place a cashier reads whether their sales have gone out. */
export function syncChip(page: Page): Locator {
  return page.getByRole('link', { name: /^Sync:/ });
}

/** Opens this terminal's sales, which lists what the server holds and what is still on the way. */
export async function openSales(page: Page): Promise<Locator> {
  await page.getByRole('button', { name: 'Sales' }).click();
  const sheet = page
    .getByRole('dialog')
    .filter({ hasText: 'Recent sales and refunds of this terminal' });
  await expect(sheet).toBeVisible();
  return sheet;
}

export async function closeSales(page: Page): Promise<void> {
  await page.keyboard.press('Escape');
  await expect(page.getByText('Recent sales and refunds of this terminal')).toBeHidden();
}

/** Follows the sync chip to the Conflicts screen and comes back. */
export async function readConflictsScreen(page: Page): Promise<Locator> {
  await syncChip(page).click();
  await expect(page.getByRole('heading', { name: 'Conflicts' })).toBeVisible();
  return page.getByRole('main');
}

export async function leaveConflictsScreen(page: Page): Promise<void> {
  await page.getByRole('link', { name: 'Back' }).click();
  await expect(page.getByRole('heading', { name: 'Conflicts' })).toBeHidden();
}
