import { AppError } from './errors';

declare const millimesBrand: unique symbol;

/**
 * An amount of Tunisian dinars in millimes (1 DT = 1000 millimes), always a safe integer.
 * Create values with `mm` or `parseTND`; never do arithmetic on dinars as floating point.
 */
export type Millimes = number & { readonly [millimesBrand]: true };

const MIN_SAFE = BigInt(Number.MIN_SAFE_INTEGER);
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

function invalid(message: string): AppError {
  return new AppError('VALIDATION_ERROR', message);
}

export function isMillimes(value: unknown): value is Millimes {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

/** Brands a whole number of millimes. Throws VALIDATION_ERROR for fractions and unsafe integers. */
export function mm(value: number): Millimes {
  if (!Number.isSafeInteger(value)) {
    throw invalid(`Not a whole number of millimes: ${value}`);
  }
  // Normalise -0 so equality checks and serialisation never see it.
  return (value === 0 ? 0 : value) as Millimes;
}

export const ZERO: Millimes = mm(0);

function fromBigInt(value: bigint): Millimes {
  if (value < MIN_SAFE || value > MAX_SAFE) {
    throw invalid('Amount is out of range');
  }
  return mm(Number(value));
}

export function add(...amounts: readonly Millimes[]): Millimes {
  return fromBigInt(amounts.reduce((sum, amount) => sum + BigInt(amount), 0n));
}

export function sub(a: Millimes, b: Millimes): Millimes {
  return fromBigInt(BigInt(a) - BigInt(b));
}

export function neg(amount: Millimes): Millimes {
  return sub(ZERO, amount);
}

/** `amount` times a whole number of units. */
export function mulQty(amount: Millimes, qty: number): Millimes {
  if (!Number.isSafeInteger(qty)) {
    throw invalid(`Quantity must be a whole number: ${qty}`);
  }
  return fromBigInt(BigInt(amount) * BigInt(qty));
}

/** `numerator / denominator` rounded half away from zero. `denominator` must be positive. */
export function divRoundHalfAwayFromZero(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) {
    throw invalid('Denominator must be positive');
  }
  const magnitude = numerator < 0n ? -numerator : numerator;
  const rounded = (2n * magnitude + denominator) / (2n * denominator);
  return numerator < 0n ? -rounded : rounded;
}

/**
 * `amount × basisPoints / 10 000`, rounded half away from zero to the millime (100 basis points
 * = 1 %). This is the only place a percentage is rounded; see docs/adr/0002.
 */
export function pct(amount: Millimes, basisPoints: number): Millimes {
  if (!Number.isSafeInteger(basisPoints)) {
    throw invalid(`Basis points must be a whole number: ${basisPoints}`);
  }
  return fromBigInt(divRoundHalfAwayFromZero(BigInt(amount) * BigInt(basisPoints), 10_000n));
}

/**
 * Splits `total` across `weights` in proportion, in whole millimes, so the parts add up to exactly
 * `total` (largest remainder method). Leftover millimes go to the largest remainders, ties to the
 * lower index, and zero weights get nothing. `total` and every weight must be zero or positive.
 */
export function allocate(total: Millimes, weights: readonly Millimes[]): Millimes[] {
  if (total < 0 || weights.some((weight) => weight < 0)) {
    throw invalid('Allocation needs a total and weights that are zero or positive');
  }
  const sumOfWeights = weights.reduce((sum, weight) => sum + BigInt(weight), 0n);
  if (sumOfWeights === 0n) {
    if (total !== 0) {
      throw invalid('Cannot allocate an amount across weights that are all zero');
    }
    return weights.map(() => ZERO);
  }
  const target = BigInt(total);
  const shares = weights.map((weight) => (target * BigInt(weight)) / sumOfWeights);
  const remainders = weights.map((weight) => (target * BigInt(weight)) % sumOfWeights);
  let leftover = target - shares.reduce((sum, share) => sum + share, 0n);
  const byRemainder = weights
    .map((_, index) => index)
    .filter((index) => weights[index] > 0)
    .sort((a, b) =>
      remainders[a] === remainders[b] ? a - b : remainders[a] > remainders[b] ? -1 : 1,
    );
  for (const index of byRemainder) {
    if (leftover === 0n) {
      break;
    }
    shares[index] += 1n;
    leftover -= 1n;
  }
  return shares.map(fromBigInt);
}

const DINARS_PATTERN = /^(-)?(?:(\d+)(?:[.,](\d{1,3}))?|[.,](\d{1,3}))$/;

/**
 * Reads dinars typed by a person or stored as text: an optional minus sign, digits, and up to three
 * decimals after "." or ",". Returns null for anything else (thousands separators, a fourth decimal,
 * exponents), so no caller ever rounds a value it was given.
 */
export function tryParseTND(input: string): Millimes | null {
  const match = DINARS_PATTERN.exec(input.trim());
  if (!match) {
    return null;
  }
  const negative = match[1] === '-';
  const whole = match[2] ?? '0';
  const fraction = match[3] ?? match[4] ?? '';
  const magnitude = BigInt(whole) * 1000n + BigInt(fraction.padEnd(3, '0'));
  const value = negative ? -magnitude : magnitude;
  if (value < MIN_SAFE || value > MAX_SAFE) {
    return null;
  }
  return mm(Number(value));
}

/** Like `tryParseTND`, but throws VALIDATION_ERROR instead of returning null. */
export function parseTND(input: string): Millimes {
  const amount = tryParseTND(input);
  if (amount === null) {
    throw invalid(`Not an amount in dinars: "${input}"`);
  }
  return amount;
}

/** Plain decimal text with exactly three decimals and "." as separator, e.g. "12.500", "-0.050". */
export function toDinarsString(amount: Millimes): string {
  const magnitude = Math.abs(amount);
  const millimes = magnitude % 1000;
  const dinars = (magnitude - millimes) / 1000;
  return `${amount < 0 ? '-' : ''}${dinars}.${String(millimes).padStart(3, '0')}`;
}

const tndFormat = new Intl.NumberFormat('fr-TN', {
  style: 'currency',
  currency: 'TND',
  minimumFractionDigits: 3,
  maximumFractionDigits: 3,
});

/** Display text such as "12,500 DT". Formats the exact decimal, never a float. */
export function formatTND(amount: Millimes): string {
  // Intl.NumberFormat reads a decimal string exactly (ECMA-402 NumberFormat v3).
  return tndFormat.format(toDinarsString(amount) as unknown as number);
}
