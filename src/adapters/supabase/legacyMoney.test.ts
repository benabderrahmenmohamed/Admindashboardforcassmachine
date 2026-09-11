import { describe, expect, it } from 'vitest';
import { AppError } from '@/lib/errors';
import { mm } from '@/lib/money';
import { MAX_PRICE_MILLIMES } from '@/ports';
import { dinarsToMillimes, millimesToDinars } from './legacyMoney';

function errorCodeOf(action: () => unknown): string | null {
  try {
    action();
  } catch (error) {
    return error instanceof AppError ? error.code : 'not an AppError';
  }
  return null;
}

describe('dinarsToMillimes', () => {
  it.each<[unknown, number]>([
    [1.8, 1800],
    ['1.8', 1800],
    [12.345, 12345],
    ['12,345', 12345],
    [0, 0],
    ['0', 0],
    [0.35, 350],
    ['2.4', 2400],
    [18, 18000],
    ['  7.5 ', 7500],
    // Large amounts are still dinars: nothing is guessed from magnitude.
    [1000, 1_000_000],
    [1500, 1_500_000],
    ['2500', 2_500_000],
    [123456.789, 123_456_789],
    ['123456,789', 123_456_789],
    [999_999_999.999, 999_999_999_999],
    [1_000_000_000, 1_000_000_000_000],
  ])('reads %j as %i millimes', (value, expected) => {
    expect(dinarsToMillimes(value)).toBe(expected);
  });

  it.each<[unknown]>([
    [0.30000000000000004],
    [-1],
    ['-0.5'],
    ['abc'],
    ['1e3'],
    [1e21],
    [1e-7],
    ['1.2345'],
    ['12.'],
    [''],
    [NaN],
    [Infinity],
    [null],
    [undefined],
    [true],
    [{ amount: 1 }],
    // Above one billion dinars a JSON number no longer holds every millime.
    [1_000_000_000.001],
    ['1000000000.001'],
    // 2^43 dinars and a millime: its nearest double already reads back as a different amount.
    [2 ** 43 + 0.001],
  ])('rejects %j with VALIDATION_ERROR', (value) => {
    expect(errorCodeOf(() => dinarsToMillimes(value))).toBe('VALIDATION_ERROR');
  });
});

describe('millimesToDinars', () => {
  it.each<[number, number]>([
    [12345, 12.345],
    [1800, 1.8],
    [1350, 1.35],
    [5, 0.005],
    [0, 0],
    [999_999_999_999, 999_999_999.999],
    [1_000_000_000_000, 1_000_000_000],
  ])('gives %i millimes as %d dinars', (millimes, dinars) => {
    expect(millimesToDinars(mm(millimes))).toBe(dinars);
  });

  it.each([-50, -1, 1_000_000_000_001, Number.MAX_SAFE_INTEGER])(
    'refuses %i millimes with VALIDATION_ERROR',
    (millimes) => {
      expect(errorCodeOf(() => millimesToDinars(mm(millimes)))).toBe('VALIDATION_ERROR');
    },
  );

  it('round-trips through dinarsToMillimes exactly', () => {
    for (let millimes = 0; millimes <= 250_000; millimes += 7) {
      expect(dinarsToMillimes(millimesToDinars(mm(millimes)))).toBe(millimes);
    }
    for (
      let millimes = MAX_PRICE_MILLIMES - 250_000;
      millimes <= MAX_PRICE_MILLIMES;
      millimes += 7
    ) {
      expect(dinarsToMillimes(millimesToDinars(mm(millimes)))).toBe(millimes);
    }
    expect(dinarsToMillimes(millimesToDinars(MAX_PRICE_MILLIMES))).toBe(MAX_PRICE_MILLIMES);
  });
});
