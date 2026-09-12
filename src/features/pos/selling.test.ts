import { describe, expect, it } from 'vitest';
import { mm, toDinarsString } from '@/lib/money';
import { readCashAmount, readCashTender } from './selling';

describe('readCashAmount', () => {
  it('reads dinars with "." or "," and up to three decimals, exactly', () => {
    expect(readCashAmount('50')).toEqual({ ok: true, millimes: 50_000 });
    expect(readCashAmount('12,5')).toEqual({ ok: true, millimes: 12_500 });
    expect(readCashAmount(' 0.050 ')).toEqual({ ok: true, millimes: 50 });
    expect(readCashAmount('0')).toEqual({ ok: true, millimes: 0 });
  });

  it('refuses anything it would have to guess or round', () => {
    for (const text of ['', '   ', 'abc', '1.2345', '1 000', '1,000.5', '5e3']) {
      expect(readCashAmount(text)).toEqual({
        ok: false,
        problem: 'Enter an amount in dinars, e.g. 50 or 12,500',
      });
    }
  });

  it('refuses a negative amount', () => {
    expect(readCashAmount('-1')).toEqual({ ok: false, problem: 'The amount cannot be negative' });
  });
});

describe('readCashTender', () => {
  const total = mm(5900);

  it('starts from the total, which needs no change', () => {
    expect(readCashTender(total, toDinarsString(total))).toEqual({
      ok: true,
      tenderedMillimes: 5900,
      changeMillimes: 0,
    });
  });

  it('gives back the difference for cash above the total', () => {
    expect(readCashTender(total, '10')).toEqual({
      ok: true,
      tenderedMillimes: 10_000,
      changeMillimes: 4100,
    });
  });

  it('refuses less than the total, or an amount it cannot read', () => {
    expect(readCashTender(total, '5.899')).toEqual({
      ok: false,
      problem: 'The amount tendered is less than the total',
    });
    expect(readCashTender(total, 'ten')).toMatchObject({ ok: false });
  });
});
