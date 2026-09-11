import { AppError } from '@/lib/errors';
import { toDinarsString, tryParseTND, type Millimes } from '@/lib/money';
import { MAX_PRICE_MILLIMES } from '@/ports';
import { describeValue } from './validate';

/**
 * Reads a price from the legacy key-value store, which keeps DINARS: a JSON number when the create
 * route wrote it, a string when the old edit form sent its text and the update route stored it as
 * is. The value is read as decimal text, so it is exact or rejected: negatives, non-numeric values,
 * exponent forms, a fourth decimal and prices above MAX_PRICE_MILLIMES (where a JSON number no longer
 * holds every millime) throw VALIDATION_ERROR. Nothing is rounded and nothing is guessed from
 * magnitude.
 */
export function dinarsToMillimes(value: unknown): Millimes {
  let amount: Millimes | null = null;
  if (typeof value === 'number' && Number.isFinite(value)) {
    // String() gives the shortest text that reads back as this number, e.g. 1.8 -> "1.8", and an
    // exponent for very large or very small numbers, which tryParseTND rejects.
    amount = tryParseTND(String(value));
  } else if (typeof value === 'string') {
    amount = tryParseTND(value);
  }
  if (amount === null || amount < 0 || amount > MAX_PRICE_MILLIMES) {
    throw new AppError('VALIDATION_ERROR', `Not a price in dinars: ${describeValue(value)}`, {
      details: { value },
    });
  }
  return amount;
}

/**
 * Dinars as a JSON number for the legacy routes, e.g. 12345 millimes -> 12.345. No arithmetic: the
 * decimal text is read as a number, which is exact for every price from 0 to MAX_PRICE_MILLIMES.
 */
export function millimesToDinars(amount: Millimes): number {
  if (amount < 0 || amount > MAX_PRICE_MILLIMES) {
    throw new AppError('VALIDATION_ERROR', `Not a price the server can store: ${amount} millimes`, {
      details: { amount },
    });
  }
  return Number(toDinarsString(amount));
}
