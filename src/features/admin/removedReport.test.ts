import { describe, expect, it } from 'vitest';
import { mm } from '@/lib/money';
import type { RemovedAfterSent } from '@/ports';
import {
  dayBounds,
  isoDay,
  minutesBeforeRemoval,
  otherSender,
  removalTotals,
  removalValue,
  removalsByWaiter,
} from './removedReport';

function row(overrides: Partial<RemovedAfterSent> & { itemId: string }): RemovedAfterSent {
  return {
    tableName: 'T1',
    productName: 'Express',
    qty: 1,
    unitPriceMillimes: mm(2_500),
    sentAt: '2026-09-12T10:05:00.000Z',
    removedAt: '2026-09-12T10:25:00.000Z',
    removedBy: 'waiter-1',
    removedByName: 'Amine',
    removedReason: 'guest left',
    submittedBy: 'waiter-1',
    submittedByName: 'Amine',
    ...overrides,
  };
}

describe('removalValue', () => {
  it('is the quantity at the price the item was ordered at', () => {
    expect(removalValue(row({ itemId: 'a', qty: 3, unitPriceMillimes: mm(2_500) }))).toBe(
      mm(7_500),
    );
  });
});

describe('removalTotals', () => {
  it('counts rows, units and what they were worth', () => {
    expect(
      removalTotals([
        row({ itemId: 'a', qty: 2 }),
        row({ itemId: 'b', unitPriceMillimes: mm(4_000) }),
      ]),
    ).toEqual({ count: 2, units: 3, valueMillimes: mm(9_000) });
  });

  it('is all zeros for a period with nothing in it', () => {
    expect(removalTotals([])).toEqual({ count: 0, units: 0, valueMillimes: mm(0) });
  });
});

describe('removalsByWaiter', () => {
  it('groups by whoever took the items off, worth the most first', () => {
    const groups = removalsByWaiter([
      row({ itemId: 'a', removedBy: 'w1', removedByName: 'Amine', unitPriceMillimes: mm(2_000) }),
      row({ itemId: 'b', removedBy: 'w2', removedByName: 'Sonia', unitPriceMillimes: mm(9_000) }),
      row({ itemId: 'c', removedBy: 'w1', removedByName: 'Amine', unitPriceMillimes: mm(1_000) }),
    ]);

    expect(groups.map((group) => [group.name, group.count, group.valueMillimes])).toEqual([
      ['Sonia', 1, mm(9_000)],
      ['Amine', 2, mm(3_000)],
    ]);
  });

  it('keeps two waiters with the same total in a stable order', () => {
    const groups = removalsByWaiter([
      row({ itemId: 'a', removedBy: 'w2', removedByName: 'Sonia' }),
      row({ itemId: 'b', removedBy: 'w1', removedByName: 'Amine' }),
    ]);

    expect(groups.map((group) => group.name)).toEqual(['Amine', 'Sonia']);
  });

  it('keeps the rows under each waiter, so the admin can read what they were', () => {
    const groups = removalsByWaiter([row({ itemId: 'a' }), row({ itemId: 'b' })]);

    expect(groups[0].rows.map((entry) => entry.itemId)).toEqual(['a', 'b']);
  });

  it('has nothing to group in a clean period', () => {
    expect(removalsByWaiter([])).toEqual([]);
  });
});

describe('otherSender', () => {
  it('names the login a removal was sent under when it is not the person the removal names', () => {
    expect(
      otherSender(row({ itemId: 'a', submittedBy: 'owner-1', submittedByName: 'Leila' })),
    ).toBe('Leila');
  });

  it('is an empty name for another login that has no display name, not nothing', () => {
    expect(otherSender(row({ itemId: 'a', submittedBy: 'owner-1', submittedByName: '' }))).toBe('');
  });

  it('says nothing when the same person sent it, or when the login was never recorded', () => {
    expect(otherSender(row({ itemId: 'a' }))).toBeNull();
    expect(otherSender(row({ itemId: 'b', submittedBy: null, submittedByName: null }))).toBeNull();
  });
});

describe('minutesBeforeRemoval', () => {
  it('says how long the kitchen had it', () => {
    expect(minutesBeforeRemoval(row({ itemId: 'a' }))).toBe(20);
  });

  it('never goes negative on clocks that disagree', () => {
    expect(minutesBeforeRemoval(row({ itemId: 'a', removedAt: '2026-09-12T10:00:00.000Z' }))).toBe(
      0,
    );
  });
});

describe('the period', () => {
  it('writes a date the way a date input reads it', () => {
    expect(isoDay(new Date(2026, 8, 12))).toBe('2026-09-12');
  });

  it('pads a single-digit month and day', () => {
    expect(isoDay(new Date(2026, 0, 5))).toBe('2026-01-05');
  });

  it('covers the whole of both days, local time', () => {
    const { from, to } = dayBounds('2026-09-12', '2026-09-12');

    expect(new Date(from).getHours()).toBe(0);
    expect(new Date(to).getHours()).toBe(23);
    expect(new Date(to).getTime() - new Date(from).getTime()).toBe(24 * 60 * 60 * 1000 - 1);
  });
});
