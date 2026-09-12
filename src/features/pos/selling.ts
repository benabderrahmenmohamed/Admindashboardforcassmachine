/**
 * Reading the cash a person types — an opening float, counted cash, the amount tendered — kept out
 * of the components so it runs without a DOM. The messages here are the field messages the cashier
 * sees, and no caller ever rounds a value it was given: anything ambiguous is a problem to show.
 */
import { changeDue } from '@/features/caisse/cart';
import { tryParseTND, type Millimes } from '@/lib/money';
import type { PaymentMethod } from '@/ports';

/** How a sale is paid, as the checkout dialog confirms it. Card is always exactly the total. */
export interface CheckoutPayment {
  readonly method: PaymentMethod;
  readonly tenderedMillimes: Millimes;
}

export type CashAmount =
  | { readonly ok: true; readonly millimes: Millimes }
  | { readonly ok: false; readonly problem: string };

/**
 * A cash amount the cashier typed: dinars with up to three decimals after "." or ",", zero or more.
 * Never rounded: anything else is a problem to show.
 */
export function readCashAmount(text: string): CashAmount {
  const millimes = tryParseTND(text);
  if (millimes === null) {
    return { ok: false, problem: 'Enter an amount in dinars, e.g. 50 or 12,500' };
  }
  if (millimes < 0) {
    return { ok: false, problem: 'The amount cannot be negative' };
  }
  return { ok: true, millimes };
}

export type CashTender =
  | { readonly ok: true; readonly tenderedMillimes: Millimes; readonly changeMillimes: Millimes }
  | { readonly ok: false; readonly problem: string };

/** The cash handed over for a total of `totalMillimes`, and the change to give back. */
export function readCashTender(totalMillimes: Millimes, tenderedText: string): CashTender {
  const amount = readCashAmount(tenderedText);
  if (!amount.ok) {
    return amount;
  }
  if (amount.millimes < totalMillimes) {
    return { ok: false, problem: 'The amount tendered is less than the total' };
  }
  return {
    ok: true,
    tenderedMillimes: amount.millimes,
    changeMillimes: changeDue(totalMillimes, amount.millimes),
  };
}
