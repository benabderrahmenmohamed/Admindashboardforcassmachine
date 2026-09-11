import { describe, expect, it } from 'vitest';

import { AppError } from './errors';
import {
  add,
  allocate,
  divRoundHalfAwayFromZero,
  formatTND,
  isMillimes,
  mm,
  mulQty,
  neg,
  parseTND,
  pct,
  sub,
  toDinarsString,
  tryParseTND,
  ZERO,
  type Millimes,
} from './money';

// Black-box tests of the money contract. `toBe` compares with Object.is, so every
// `toBe(0)` below also fails if the result is -0.

const MAX = Number.MAX_SAFE_INTEGER;
const MIN = Number.MIN_SAFE_INTEGER;

/** Runs `fn` and returns what it threw, or undefined when it returned normally. */
function thrownBy(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return undefined;
}

function expectValidationError(fn: () => unknown): void {
  const error = thrownBy(fn);
  expect(error).toBeInstanceOf(AppError);
  expect(error).toHaveProperty('code', 'VALIDATION_ERROR');
}

/**
 * Deterministic pseudo-random whole numbers for property-style loops: a 32-bit linear
 * congruential generator with the Numerical Recipes constants and a fixed seed. Only the high 16
 * bits of each state are used, because the low bits of a power-of-two LCG cycle quickly.
 */
function createRandom(seed: number) {
  let state = seed >>> 0;
  const high16 = (): number => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state >>> 16;
  };
  return {
    /** A whole number from 0 up to, but excluding, `bound` (at most 2^32). */
    below(bound: number): number {
      return (high16() * 0x1_0000 + high16()) % bound;
    },
  };
}

type Random = ReturnType<typeof createRandom>;

/** A whole number of millimes below 1 DT, 1 000 DT, 1 000 000 DT or 10^12 DT. */
function randomMagnitude(random: Random): number {
  switch (random.below(4)) {
    case 0:
      return random.below(1_000);
    case 1:
      return random.below(1_000_000);
    case 2:
      return random.below(1_000_000_000);
    default:
      return random.below(1_000_000) * 1_000_000_000 + random.below(1_000_000_000);
  }
}

function randomAmount(random: Random): Millimes {
  const magnitude = randomMagnitude(random);
  return mm(random.below(2) === 0 ? magnitude : -magnitude);
}

/** formatTND output with U+202F and U+00A0 turned into plain spaces. */
function plainSpaces(text: string): string {
  return text
    .replaceAll(String.fromCharCode(0x202f), ' ')
    .replaceAll(String.fromCharCode(0xa0), ' ');
}

/** Reads formatTND output back: strips " DT" and every space, then parses the dinars. */
function parseFormatted(text: string): Millimes | null {
  return tryParseTND(plainSpaces(text).replace(/ DT$/, '').replaceAll(' ', ''));
}

describe('mm', () => {
  it('brands whole numbers of millimes unchanged', () => {
    expect(mm(12_500)).toBe(12_500);
    expect(mm(-50)).toBe(-50);
    expect(mm(MAX)).toBe(MAX);
    expect(mm(MIN)).toBe(MIN);
  });

  it('normalises -0 to 0', () => {
    expect(mm(-0)).toBe(0);
    expect(ZERO).toBe(0);
  });

  it.each([0.5, -0.5, 1.001, NaN, Infinity, -Infinity, 2 ** 53, -(2 ** 53), Number.MAX_VALUE])(
    'rejects %s',
    (value) => {
      expectValidationError(() => mm(value));
    },
  );
});

describe('isMillimes', () => {
  it('accepts safe integers only', () => {
    expect(isMillimes(0)).toBe(true);
    expect(isMillimes(-12_500)).toBe(true);
    expect(isMillimes(MAX)).toBe(true);
    expect(isMillimes(MIN)).toBe(true);
    for (const value of [1.5, NaN, Infinity, 2 ** 53, '12', 12n, null, undefined]) {
      expect(isMillimes(value)).toBe(false);
    }
  });
});

describe('add', () => {
  it('sums any number of amounts', () => {
    expect(add()).toBe(0);
    expect(add(mm(1_350))).toBe(1_350);
    expect(add(mm(1_350), mm(2_650), mm(-500))).toBe(3_500);
    expect(add(mm(-5), mm(5))).toBe(0);
  });

  it('is exact at the edges of the safe range', () => {
    expect(add(mm(MAX - 1), mm(1))).toBe(MAX);
    expect(add(mm(2 ** 52), mm(2 ** 52 - 1))).toBe(MAX);
    expect(add(mm(MIN + 1), mm(-1))).toBe(MIN);
    expect(add(mm(MAX), mm(MIN))).toBe(0);
  });

  it('stays exact when a running total leaves the safe range but the sum does not', () => {
    // As floats, MAX + 2 rounds to 2^53, so subtracting 2 again would give MAX - 1.
    expect(add(mm(MAX), mm(2), mm(-2))).toBe(MAX);
  });

  it('throws when the sum is out of range', () => {
    expectValidationError(() => add(mm(MAX), mm(1)));
    expectValidationError(() => add(mm(MIN), mm(-1)));
    expectValidationError(() => add(mm(MAX), mm(MAX)));
  });
});

describe('sub', () => {
  it('is exact at the edges of the safe range', () => {
    expect(sub(mm(MAX), mm(MAX - 1))).toBe(1);
    expect(sub(mm(MIN + 1), mm(1))).toBe(MIN);
    expect(sub(ZERO, mm(MIN))).toBe(MAX);
    expect(sub(mm(MAX), mm(MAX))).toBe(0);
    expect(sub(mm(-5), mm(-5))).toBe(0);
  });

  it('throws when the difference is out of range', () => {
    expectValidationError(() => sub(mm(MIN), mm(1)));
    expectValidationError(() => sub(mm(MAX), mm(-1)));
    expectValidationError(() => sub(mm(MAX), mm(MIN)));
  });
});

describe('neg', () => {
  it('negates exactly, including both ends of the safe range', () => {
    expect(neg(mm(1_350))).toBe(-1_350);
    expect(neg(mm(-50))).toBe(50);
    expect(neg(mm(MAX))).toBe(MIN);
    expect(neg(mm(MIN))).toBe(MAX);
  });

  it('never returns -0', () => {
    expect(neg(ZERO)).toBe(0);
  });
});

describe('mulQty', () => {
  it('multiplies by a whole quantity exactly', () => {
    expect(mulQty(mm(1_350), 3)).toBe(4_050);
    expect(mulQty(mm(-250), 4)).toBe(-1_000);
    expect(mulQty(mm(250), -4)).toBe(-1_000);
    expect(mulQty(mm(MAX), 1)).toBe(MAX);
    expect(mulQty(mm(MAX), -1)).toBe(MIN);
    expect(mulQty(mm(3_002_399_751_580_330), 3)).toBe(9_007_199_254_740_990);
  });

  it('never returns -0', () => {
    expect(mulQty(mm(-5), 0)).toBe(0);
    expect(mulQty(ZERO, -3)).toBe(0);
  });

  it('throws when the product is out of range', () => {
    expectValidationError(() => mulQty(mm(2 ** 52), 2));
    expectValidationError(() => mulQty(mm(-(2 ** 52)), 2));
    expectValidationError(() => mulQty(mm(3_002_399_751_580_331), 3));
    expectValidationError(() => mulQty(mm(MAX), MAX));
  });

  it.each([1.5, -0.5, NaN, Infinity, 2 ** 53])('rejects the quantity %s', (qty) => {
    expectValidationError(() => mulQty(mm(1_000), qty));
  });
});

describe('divRoundHalfAwayFromZero', () => {
  it.each<[bigint, bigint, bigint]>([
    [1n, 2n, 1n], // 0.5
    [3n, 2n, 2n], // 1.5
    [2n, 5n, 0n], // 0.4
    [5n, 2n, 3n], // 2.5
    [3n, 5n, 1n], // 0.6
    [7n, 4n, 2n], // 1.75
    [10n, 5n, 2n],
    [0n, 7n, 0n],
  ])('rounds %s / %s to %s, and mirrors the sign for a negative numerator', (n, d, expected) => {
    expect(divRoundHalfAwayFromZero(n, d)).toBe(expected);
    expect(divRoundHalfAwayFromZero(-n, d)).toBe(-expected);
  });

  it('is exact beyond the safe integer range', () => {
    expect(divRoundHalfAwayFromZero(2n ** 70n + 1n, 2n)).toBe(2n ** 69n + 1n);
    expect(divRoundHalfAwayFromZero(-(2n ** 70n) - 1n, 2n)).toBe(-(2n ** 69n) - 1n);
    expect(divRoundHalfAwayFromZero(2n ** 70n - 1n, 2n)).toBe(2n ** 69n);
  });

  it('throws for a zero or negative denominator', () => {
    expectValidationError(() => divRoundHalfAwayFromZero(1n, 0n));
    expectValidationError(() => divRoundHalfAwayFromZero(1n, -2n));
  });
});

describe('pct', () => {
  it.each<[number, number, number]>([
    [5, 1_000, 1], // 0.5
    [-5, 1_000, -1], // -0.5
    [15, 1_000, 2], // 1.5
    [-15, 1_000, -2],
    [25, 1_000, 3], // 2.5
    [-25, 1_000, -3],
    [4, 1_000, 0], // 0.4
    [-4, 1_000, 0],
    [6, 1_000, 1], // 0.6
    [-6, 1_000, -1],
    [2_010, 500, 101], // 100.5
    [1_005, 500, 50], // 50.25
    [19_990, 1_900, 3_798], // 3 798.1
  ])('%i millimes at %i bp rounds half away from zero to %i', (amount, basisPoints, expected) => {
    expect(pct(mm(amount), basisPoints)).toBe(expected);
  });

  it('gives 0 at 0 bp', () => {
    expect(pct(mm(12_345), 0)).toBe(0);
    expect(pct(mm(-12_345), 0)).toBe(0);
    expect(pct(mm(MAX), 0)).toBe(0);
  });

  it('gives the whole amount at 10 000 bp', () => {
    expect(pct(mm(12_345), 10_000)).toBe(12_345);
    expect(pct(mm(-12_345), 10_000)).toBe(-12_345);
    expect(pct(mm(MAX), 10_000)).toBe(MAX);
    expect(pct(mm(MIN), 10_000)).toBe(MIN);
  });

  it('rounds 1 bp half away from zero', () => {
    expect(pct(mm(4_999), 1)).toBe(0); // 0.4999
    expect(pct(mm(5_000), 1)).toBe(1); // 0.5
    expect(pct(mm(12_345), 1)).toBe(1); // 1.2345
    expect(pct(mm(15_000), 1)).toBe(2); // 1.5
    expect(pct(mm(-4_999), 1)).toBe(0);
    expect(pct(mm(-5_000), 1)).toBe(-1);
    expect(pct(mm(-15_000), 1)).toBe(-2);
  });

  it('is exact for amounts whose product with the basis points leaves the safe range', () => {
    // MAX / 2 is 4 503 599 627 370 495.5.
    expect(pct(mm(MAX), 5_000)).toBe(4_503_599_627_370_496);
    expect(pct(mm(MIN), 5_000)).toBe(-4_503_599_627_370_496);
  });

  it('throws when the result is out of range', () => {
    expectValidationError(() => pct(mm(MAX), 10_001));
    expectValidationError(() => pct(mm(MIN), 20_000));
  });

  it.each([2.5, NaN, Infinity])('rejects %s basis points', (basisPoints) => {
    expectValidationError(() => pct(mm(10_000), basisPoints));
  });
});

/** Every way `parts` breaks the allocate contract for `total` and `weights`, as text. */
function allocationProblems(
  total: Millimes,
  weights: readonly Millimes[],
  parts: readonly Millimes[],
): string[] {
  if (parts.length !== weights.length) {
    return [`${parts.length} parts for ${weights.length} weights`];
  }
  const problems: string[] = [];
  const target = BigInt(total);
  const sumOfWeights = weights.reduce((sum, weight) => sum + BigInt(weight), 0n);
  const sumOfParts = parts.reduce((sum, part) => sum + BigInt(part), 0n);
  if (sumOfParts !== target) {
    problems.push(`parts add up to ${String(sumOfParts)}`);
  }
  // The exact share of part i is floors[i] + remainders[i] / sumOfWeights.
  const exact = weights.map((weight) => target * BigInt(weight));
  const floors = exact.map((value) => (sumOfWeights === 0n ? 0n : value / sumOfWeights));
  const remainders = exact.map((value) => (sumOfWeights === 0n ? 0n : value % sumOfWeights));
  const roundedUp = parts.map((part, index) => BigInt(part) - floors[index]);
  parts.forEach((part, index) => {
    if (!Number.isSafeInteger(part)) {
      problems.push(`part ${index} is not a safe integer`);
    }
    if (weights[index] === 0 && part !== 0) {
      problems.push(`part ${index} has weight 0 but got ${String(part)}`);
    }
    const isFloor = roundedUp[index] === 0n;
    const isCeiling = roundedUp[index] === 1n && remainders[index] > 0n;
    if (!isFloor && !isCeiling) {
      problems.push(`part ${index} is not the floor or ceiling of its exact share`);
    }
  });
  // Largest remainder: a part rounded up never has a smaller remainder than a part with a
  // positive weight left at its floor, and on equal remainders it has the lower index.
  for (let up = 0; up < parts.length; up += 1) {
    if (roundedUp[up] !== 1n) {
      continue;
    }
    for (let down = 0; down < parts.length; down += 1) {
      if (roundedUp[down] !== 0n || weights[down] === 0) {
        continue;
      }
      const fair =
        remainders[up] > remainders[down] || (remainders[up] === remainders[down] && up < down);
      if (!fair) {
        problems.push(`part ${up} was rounded up ahead of part ${down}`);
      }
    }
  }
  return problems;
}

describe('allocate', () => {
  it('splits in proportion when the shares are whole', () => {
    expect(allocate(mm(10), [mm(1), mm(2), mm(3), mm(4)])).toEqual([1, 2, 3, 4]);
    expect(allocate(mm(1_000), [mm(3), mm(7)])).toEqual([300, 700]);
  });

  it('gives leftover millimes to the largest remainders', () => {
    expect(allocate(mm(100), [mm(1), mm(2)])).toEqual([33, 67]);
    expect(allocate(mm(10), [mm(1), mm(1), mm(1), mm(4)])).toEqual([2, 1, 1, 6]);
    expect(allocate(mm(2), [mm(1), mm(2), mm(2)])).toEqual([0, 1, 1]);
    // Shares 1.2 and 0.8: the smaller weight has the larger remainder, so it gets the millime.
    expect(allocate(mm(2), [mm(3), mm(2)])).toEqual([1, 1]);
  });

  it('breaks ties toward the lower index', () => {
    expect(allocate(mm(100), [mm(1), mm(1), mm(1)])).toEqual([34, 33, 33]);
    expect(allocate(mm(2), [mm(1), mm(1), mm(1)])).toEqual([1, 1, 0]);
    expect(allocate(mm(101), [mm(1_005), mm(1_005)])).toEqual([51, 50]);
    expect(allocate(mm(1), [mm(2), mm(1), mm(2)])).toEqual([1, 0, 0]);
    // Shares 0.5 and 1.5 tie on remainder with unequal weights: the index decides, not the weight.
    expect(allocate(mm(2), [mm(1), mm(3)])).toEqual([1, 1]);
  });

  it('gives nothing to zero weights, even at a lower index', () => {
    expect(allocate(mm(2), [mm(0), mm(1), mm(0), mm(1), mm(1)])).toEqual([0, 1, 0, 1, 0]);
    expect(allocate(mm(7), [mm(0), mm(5), mm(0)])).toEqual([0, 7, 0]);
    expect(allocate(mm(1_001), [mm(3), mm(0), mm(7)])).toEqual([300, 0, 701]);
  });

  it('returns zeros for a zero total', () => {
    expect(allocate(ZERO, [mm(3), mm(5)])).toEqual([0, 0]);
  });

  it('works for all-zero weights with a zero total', () => {
    expect(allocate(ZERO, [ZERO, ZERO, ZERO])).toEqual([0, 0, 0]);
    expect(allocate(ZERO, [])).toEqual([]);
  });

  it('throws for a negative total or a negative weight', () => {
    expectValidationError(() => allocate(mm(-1), [mm(1), mm(1)]));
    expectValidationError(() => allocate(mm(10), [mm(5), mm(-1)]));
  });

  it('throws for a non-zero total over weights that are all zero', () => {
    expectValidationError(() => allocate(mm(1), [ZERO, ZERO]));
    expectValidationError(() => allocate(mm(1), []));
  });

  it('is exact when total times weight leaves the safe range', () => {
    expect(allocate(mm(MAX), [mm(MAX), mm(MAX)])).toEqual([
      4_503_599_627_370_496, 4_503_599_627_370_495,
    ]);
    expect(allocate(mm(MAX), [mm(1), mm(MAX - 1)])).toEqual([1, MAX - 1]);
    // Every share is whole, but as floats (MAX - 1) * 3 / 6 floors to 4 503 599 627 370 494.
    expect(allocate(mm(MAX - 1), [mm(1), mm(2), mm(3)])).toEqual([
      1_501_199_875_790_165, 3_002_399_751_580_330, 4_503_599_627_370_495,
    ]);
  });

  it('leaves the weights untouched', () => {
    const weights = Object.freeze([mm(3), mm(0), mm(7)]);
    allocate(mm(1_001), weights);
    expect(weights).toEqual([3, 0, 7]);
  });

  it('holds its contract over many pseudo-random cases', () => {
    const random = createRandom(0x5eed);
    const runs = 2_000;
    const failures: string[] = [];
    for (let run = 0; run < runs; run += 1) {
      // Small weights and totals make ties and zero weights common; large ones overflow floats.
      const small = random.below(2) === 0;
      const weights = Array.from({ length: 1 + random.below(8) }, () => {
        if (small) {
          return mm(random.below(4));
        }
        return random.below(4) === 0 ? ZERO : mm(randomMagnitude(random));
      });
      const allZero = weights.every((weight) => weight === 0);
      let total = ZERO;
      if (!allZero && random.below(10) !== 0) {
        total = mm(small ? random.below(20) : randomMagnitude(random));
      }

      const parts = allocate(total, weights);
      const problems = allocationProblems(total, weights, parts);

      // Largest remainder depends only on the ratios between the weights.
      const factor = 2 + random.below(3);
      const scaled = allocate(
        total,
        weights.map((weight) => mulQty(weight, factor)),
      );
      if (scaled.some((part, index) => part !== parts[index])) {
        problems.push(`scaling the weights by ${factor} changed the parts to [${scaled.join()}]`);
      }

      if (problems.length > 0) {
        failures.push(JSON.stringify({ total, weights, parts, problems }));
      }
    }
    expect(failures.slice(0, 5), `${failures.length} of ${runs} cases failed`).toEqual([]);
  });
});

const ACCEPTED: [string, number][] = [
  ['12', 12_000],
  ['12.5', 12_500],
  ['12,5', 12_500],
  ['12.500', 12_500],
  ['.5', 500],
  [',5', 500],
  ['-3.250', -3_250],
  ['  7 ', 7_000],
  ['0', 0],
  ['-0', 0],
  ['0.001', 1],
  ['1,35', 1_350],
  ['-0,05', -50],
  ['9007199254740.991', MAX],
  ['-9007199254740.991', MIN],
];

const REJECTED: string[] = [
  '',
  '   ',
  '-',
  '.',
  ',',
  '1.2345',
  '1,2345',
  '1 000',
  '1,000.5',
  '1.000,5',
  '1e3',
  '1E3',
  'abc',
  '12.',
  '12,',
  '12..5',
  '1.2.3',
  '--1',
  'NaN',
  'Infinity',
  '0x10',
  '12 DT',
  // Out of range: one millime past either end, and far beyond.
  '9007199254740.992',
  '-9007199254740.992',
  '9007199254741',
  '99999999999999999999',
];

describe('tryParseTND', () => {
  it.each(ACCEPTED)('reads %j as %i millimes', (input, expected) => {
    expect(tryParseTND(input)).toBe(expected);
  });

  it.each(REJECTED)('returns null for %j', (input) => {
    expect(tryParseTND(input)).toBeNull();
  });
});

describe('parseTND', () => {
  it.each(ACCEPTED)('reads %j as %i millimes', (input, expected) => {
    expect(parseTND(input)).toBe(expected);
  });

  it.each(REJECTED)('throws VALIDATION_ERROR for %j', (input) => {
    expectValidationError(() => parseTND(input));
  });
});

describe('toDinarsString', () => {
  it.each<[number, string]>([
    [0, '0.000'],
    [1, '0.001'],
    [-1, '-0.001'],
    [-50, '-0.050'],
    [1_000, '1.000'],
    [1_350, '1.350'],
    [12_500, '12.500'],
    [-12_345, '-12.345'],
    [123_456_789, '123456.789'],
    [-1_000_000_000_000_000, '-1000000000000.000'],
    [9_007_199_254_740_989, '9007199254740.989'],
    [MAX, '9007199254740.991'],
    [MIN, '-9007199254740.991'],
  ])('writes %i millimes as %j', (amount, expected) => {
    expect(toDinarsString(mm(amount))).toBe(expected);
  });

  it('never writes a negative zero', () => {
    expect(toDinarsString(mm(-0))).toBe('0.000');
  });

  it('round-trips through tryParseTND over many pseudo-random amounts', () => {
    const random = createRandom(20_260_911);
    const runs = 2_000;
    const failures: string[] = [];
    for (let run = 0; run < runs; run += 1) {
      const amount = randomAmount(random);
      const text = toDinarsString(amount);
      if (!/^-?(0|[1-9]\d*)\.\d{3}$/.test(text) || tryParseTND(text) !== amount) {
        failures.push(`${String(amount)} -> ${text}`);
      }
    }
    expect(failures.slice(0, 5), `${failures.length} of ${runs} amounts failed`).toEqual([]);
  });
});

describe('formatTND', () => {
  it('shows dinars with a decimal comma, three decimals and DT', () => {
    expect(plainSpaces(formatTND(mm(12_500)))).toBe('12,500 DT');
    expect(plainSpaces(formatTND(mm(1_350)))).toBe('1,350 DT');
    expect(plainSpaces(formatTND(mm(50)))).toBe('0,050 DT');
    expect(plainSpaces(formatTND(ZERO))).toBe('0,000 DT');
  });

  it.each([-12_500, -50, -1, -1_234_567, MIN])(
    'shows three decimals for %i millimes and reads back exactly',
    (amount) => {
      const text = plainSpaces(formatTND(mm(amount)));
      expect(text).toMatch(/,\d{3} DT$/);
      expect(parseFormatted(text)).toBe(amount);
    },
  );

  it('formats the exact decimal, not a float approximation', () => {
    // 9 007 199 254 740.989 is not a double: as a float it would show as ...740,988.
    const amount = mm(9_007_199_254_740_989);
    expect(plainSpaces(formatTND(amount))).toMatch(/,989 DT$/);
    expect(parseFormatted(formatTND(amount))).toBe(amount);
  });

  it('reads back exactly over many pseudo-random amounts', () => {
    const random = createRandom(1_350);
    const runs = 1_000;
    const failures: string[] = [];
    for (let run = 0; run < runs; run += 1) {
      const amount = randomAmount(random);
      const text = plainSpaces(formatTND(amount));
      if (!/,\d{3} DT$/.test(text) || parseFormatted(text) !== amount) {
        failures.push(`${String(amount)} -> ${JSON.stringify(text)}`);
      }
    }
    expect(failures.slice(0, 5), `${failures.length} of ${runs} amounts failed`).toEqual([]);
  });
});
