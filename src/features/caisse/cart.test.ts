import { describe, expect, it } from 'vitest';
import { AppError, isAppError } from '@/lib/errors';
import { mm, type Millimes } from '@/lib/money';
import {
  addItem,
  cartOf as cartOfLines,
  changeDue,
  emptyCart,
  lineKey,
  offerLine,
  removeLine,
  setCartDiscount,
  setQty,
  totals,
  type Cart,
  type CartLine,
  type CartProduct,
} from './cart';

const bread: CartProduct = { id: 'bread', name: 'Baguette', priceMillimes: mm(200) };
const milk: CartProduct = { id: 'milk', name: 'Lait demi-ecreme 1 L', priceMillimes: mm(1_350) };
/** A line discount in these tests. A discount always says why, so every one here says the same. */
function discountLine(cart: Cart, key: string, discount: Millimes): Cart {
  return offerLine(cart, key, discount, 'offert');
}

const coffee: CartProduct = { id: 'coffee', name: 'Cafe moulu 250 g', priceMillimes: mm(8_750) };
const bag: CartProduct = { id: 'bag', name: 'Sac', priceMillimes: mm(0) };

function product(id: string, priceMillimes: number): CartProduct {
  return { id, name: `Product ${id}`, priceMillimes: mm(priceMillimes) };
}

function cartOf(...entries: readonly (readonly [CartProduct, number])[]): Cart {
  return entries.reduce((cart, [item, qty]) => addItem(cart, item, qty), emptyCart);
}

function lineOf(cart: Cart, productId: string): CartLine | undefined {
  return cart.lines.find((line) => line.productId === productId);
}

function thrownBy(action: () => unknown): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }
  return expect.unreachable('expected the call to throw');
}

function expectValidationError(action: () => unknown, label?: string): void {
  const error = thrownBy(action);
  expect(error, label).toBeInstanceOf(AppError);
  expect(isAppError(error) ? error.code : undefined, label).toBe('VALIDATION_ERROR');
}

/** A deep-frozen copy: any write to it throws, so a mutating implementation fails loudly. */
function frozenCopy(cart: Cart): Cart {
  return Object.freeze({
    ...cart,
    lines: Object.freeze(cart.lines.map((line) => Object.freeze({ ...line }))),
  });
}

describe('addItem', () => {
  it('adds a line with the product price, one unit by default and no line discount', () => {
    expect(addItem(emptyCart, milk)).toEqual({
      lines: [
        {
          productId: 'milk',
          name: 'Lait demi-ecreme 1 L',
          unitPriceMillimes: 1_350,
          qty: 1,
          lineDiscountMillimes: 0,
        },
      ],
      discountBasisPoints: 0,
    });
  });

  it('adds the requested number of units', () => {
    expect(lineOf(addItem(emptyCart, bread, 6), 'bread')?.qty).toBe(6);
  });

  it('merges units of the same product into its existing line and keeps the line order', () => {
    let cart = addItem(emptyCart, milk);
    cart = addItem(cart, bread, 2);
    cart = addItem(cart, milk, 3);

    expect(cart.lines.map((line) => [line.productId, line.qty])).toEqual([
      ['milk', 4],
      ['bread', 2],
    ]);
  });

  it('keeps the line discount and the cart discount when units are merged into a line', () => {
    let cart = setCartDiscount(addItem(emptyCart, coffee), 500);
    cart = discountLine(cart, 'coffee', mm(750));
    cart = addItem(cart, coffee, 2);

    expect(cart.lines).toHaveLength(1);
    expect(lineOf(cart, 'coffee')).toMatchObject({ qty: 3, lineDiscountMillimes: 750 });
    expect(cart.discountBasisPoints).toBe(500);
  });

  it('keeps the other lines and the cart discount when a new product is added', () => {
    let cart = discountLine(cartOf([coffee, 1]), 'coffee', mm(750));
    cart = setCartDiscount(cart, 500);
    cart = addItem(cart, milk);

    expect(cart).toEqual({
      lines: [
        {
          productId: 'coffee',
          name: 'Cafe moulu 250 g',
          unitPriceMillimes: 8_750,
          qty: 1,
          lineDiscountMillimes: 750,
          lineDiscountReason: 'offert',
        },
        {
          productId: 'milk',
          name: 'Lait demi-ecreme 1 L',
          unitPriceMillimes: 1_350,
          qty: 1,
          lineDiscountMillimes: 0,
        },
      ],
      discountBasisPoints: 500,
    });
  });

  it('rejects quantities below one, for a new line and for an existing one', () => {
    const cart = addItem(emptyCart, milk);
    for (const qty of [0, -1, -10]) {
      expectValidationError(() => addItem(emptyCart, bread, qty), `new line, qty ${qty}`);
      expectValidationError(() => addItem(cart, milk, qty), `existing line, qty ${qty}`);
    }
  });

  it('rejects fractional and non-finite quantities', () => {
    const cart = addItem(emptyCart, milk);
    for (const qty of [0.5, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expectValidationError(() => addItem(emptyCart, bread, qty), `new line, qty ${qty}`);
      expectValidationError(() => addItem(cart, milk, qty), `existing line, qty ${qty}`);
    }
  });
});

describe('setQty', () => {
  /** bread: 2 × 200 with 100 off; milk: 1 × 1,350 with 350 off; 5 % off the cart. */
  function discountedCart(): Cart {
    let cart = cartOf([bread, 2], [milk, 1]);
    cart = discountLine(cart, 'bread', mm(100));
    cart = discountLine(cart, 'milk', mm(350));
    return setCartDiscount(cart, 500);
  }

  const breadLine = {
    productId: 'bread',
    name: 'Baguette',
    unitPriceMillimes: 200,
    qty: 2,
    lineDiscountMillimes: 100,
    lineDiscountReason: 'offert',
  };
  const milkLine = {
    productId: 'milk',
    name: 'Lait demi-ecreme 1 L',
    unitPriceMillimes: 1_350,
    qty: 1,
    lineDiscountMillimes: 350,
    lineDiscountReason: 'offert',
  };

  it('sets the quantity of one line and leaves the other line and the cart discount alone', () => {
    expect(setQty(discountedCart(), 'milk', 5)).toEqual({
      lines: [breadLine, { ...milkLine, qty: 5 }],
      discountBasisPoints: 500,
    });
    expect(setQty(discountedCart(), 'bread', 7)).toEqual({
      lines: [{ ...breadLine, qty: 7 }, milkLine],
      discountBasisPoints: 500,
    });
  });

  it('removes the line at zero or less and keeps the other line and the cart discount', () => {
    const cart = discountedCart();
    for (const qty of [0, -3]) {
      expect(setQty(cart, 'milk', qty), `milk, qty ${qty}`).toEqual({
        lines: [breadLine],
        discountBasisPoints: 500,
      });
      expect(setQty(cart, 'bread', qty), `bread, qty ${qty}`).toEqual({
        lines: [milkLine],
        discountBasisPoints: 500,
      });
    }
  });

  it('rejects fractional and non-finite quantities', () => {
    const cart = cartOf([milk, 2]);
    for (const qty of [2.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expectValidationError(() => setQty(cart, 'milk', qty), `qty ${qty}`);
    }
  });

  it('caps the line discount at the new line amount', () => {
    let cart = discountLine(cartOf([coffee, 3]), 'coffee', mm(20_000));

    cart = setQty(cart, 'coffee', 2);
    expect(lineOf(cart, 'coffee')?.lineDiscountMillimes).toBe(17_500);

    cart = setQty(cart, 'coffee', 1);
    expect(lineOf(cart, 'coffee')?.lineDiscountMillimes).toBe(8_750);
    expect(totals(cart).lines[0]).toMatchObject({ netMillimes: 0, totalMillimes: 0 });

    // Raising the quantity again does not bring back the discount that was capped away.
    cart = setQty(cart, 'coffee', 4);
    expect(lineOf(cart, 'coffee')).toMatchObject({ qty: 4, lineDiscountMillimes: 8_750 });
  });

  it('keeps a line discount that still fits', () => {
    const cart = setQty(discountLine(cartOf([coffee, 3]), 'coffee', mm(5_000)), 'coffee', 1);

    expect(lineOf(cart, 'coffee')).toMatchObject({ qty: 1, lineDiscountMillimes: 5_000 });
  });
});

describe('removeLine', () => {
  it('removes only the given line and leaves the rest and the cart discount unchanged', () => {
    let cart = cartOf([bread, 1], [milk, 2], [coffee, 3]);
    cart = discountLine(cart, 'bread', mm(50));
    cart = discountLine(cart, 'coffee', mm(1_000));
    cart = setCartDiscount(cart, 500);

    expect(removeLine(cart, 'milk')).toEqual({
      lines: [
        {
          productId: 'bread',
          name: 'Baguette',
          unitPriceMillimes: 200,
          qty: 1,
          lineDiscountMillimes: 50,
          lineDiscountReason: 'offert',
        },
        {
          productId: 'coffee',
          name: 'Cafe moulu 250 g',
          unitPriceMillimes: 8_750,
          qty: 3,
          lineDiscountMillimes: 1_000,
          lineDiscountReason: 'offert',
        },
      ],
      discountBasisPoints: 500,
    });
  });

  it('gives an empty cart once the last line is removed', () => {
    const cart = removeLine(cartOf([milk, 2]), 'milk');

    expect(cart.lines).toEqual([]);
    expect(totals(cart)).toMatchObject({ subtotalMillimes: 0, totalMillimes: 0, itemCount: 0 });
  });
});

describe('setLineDiscount', () => {
  it('accepts a discount from zero up to the line amount, on that line only', () => {
    // milk: 2 × 1,350 = 2,700
    const cart = cartOf([milk, 2], [bread, 1]);
    for (const discount of [0, 1, 1_350, 2_700]) {
      const next = discountLine(cart, 'milk', mm(discount));
      expect(lineOf(next, 'milk')?.lineDiscountMillimes, `discount ${discount}`).toBe(discount);
      expect(lineOf(next, 'bread')?.lineDiscountMillimes, `discount ${discount}`).toBe(0);
    }
  });

  it('rejects a negative discount or one above the line amount', () => {
    const cart = cartOf([milk, 2]);

    expectValidationError(() => discountLine(cart, 'milk', mm(-1)));
    expectValidationError(() => discountLine(cart, 'milk', mm(2_701)));
  });

  it('rejects a discount that is not a whole number of millimes', () => {
    const cart = cartOf([milk, 2]);

    // mm() refuses these, so only a cast gets them here; the cart still checks.
    for (const discount of [0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expectValidationError(() => discountLine(cart, 'milk', discount as Millimes));
    }
  });

  it('measures the bound against quantity times unit price', () => {
    const cart = cartOf([milk, 2]);

    expectValidationError(() => discountLine(cart, 'milk', mm(4_050)));
    const raised = discountLine(setQty(cart, 'milk', 3), 'milk', mm(4_050));
    expect(lineOf(raised, 'milk')?.lineDiscountMillimes).toBe(4_050);
  });
});

describe('setCartDiscount', () => {
  it('accepts whole basis points from 0 to 10 000 and leaves the lines alone', () => {
    const cart = cartOf([milk, 1]);
    for (const basisPoints of [0, 1, 500, 9_999, 10_000]) {
      const next = setCartDiscount(cart, basisPoints);
      expect(next.discountBasisPoints).toBe(basisPoints);
      expect(next.lines).toEqual(cart.lines);
    }
  });

  it('rejects values outside 0 to 10 000, fractions and non-finite values', () => {
    for (const basisPoints of [-1, 10_001, 12.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expectValidationError(() => setCartDiscount(emptyCart, basisPoints), `${basisPoints} bp`);
    }
  });
});

describe('totals', () => {
  it('is all zeros for an empty cart', () => {
    expect(totals(emptyCart)).toEqual({
      lines: [],
      subtotalMillimes: 0,
      discountMillimes: 0,
      totalMillimes: 0,
      itemCount: 0,
    });
  });

  it('adds quantity times unit price when there is no discount', () => {
    expect(totals(cartOf([bread, 3], [milk, 2], [coffee, 1]))).toEqual({
      lines: [
        {
          productId: 'bread',
          grossMillimes: 600,
          lineDiscountMillimes: 0,
          netMillimes: 600,
          cartDiscountShareMillimes: 0,
          totalMillimes: 600,
        },
        {
          productId: 'milk',
          grossMillimes: 2_700,
          lineDiscountMillimes: 0,
          netMillimes: 2_700,
          cartDiscountShareMillimes: 0,
          totalMillimes: 2_700,
        },
        {
          productId: 'coffee',
          grossMillimes: 8_750,
          lineDiscountMillimes: 0,
          netMillimes: 8_750,
          cartDiscountShareMillimes: 0,
          totalMillimes: 8_750,
        },
      ],
      subtotalMillimes: 12_050,
      discountMillimes: 0,
      totalMillimes: 12_050,
      itemCount: 6,
    });
  });

  it('takes line discounts off each line before the subtotal', () => {
    let cart = cartOf([milk, 2], [coffee, 1]);
    cart = discountLine(cart, 'milk', mm(700));
    cart = discountLine(cart, 'coffee', mm(750));

    expect(totals(cart)).toEqual({
      lines: [
        {
          productId: 'milk',
          grossMillimes: 2_700,
          lineDiscountMillimes: 700,
          netMillimes: 2_000,
          cartDiscountShareMillimes: 0,
          totalMillimes: 2_000,
        },
        {
          productId: 'coffee',
          grossMillimes: 8_750,
          lineDiscountMillimes: 750,
          netMillimes: 8_000,
          cartDiscountShareMillimes: 0,
          totalMillimes: 8_000,
        },
      ],
      subtotalMillimes: 10_000,
      discountMillimes: 0,
      totalMillimes: 10_000,
      itemCount: 3,
    });
  });

  it('applies the cart discount to the subtotal after line discounts', () => {
    let cart = cartOf([milk, 2], [coffee, 1]);
    cart = discountLine(cart, 'milk', mm(700));
    cart = discountLine(cart, 'coffee', mm(750));
    const result = totals(setCartDiscount(cart, 1_000));

    expect(result).toMatchObject({
      subtotalMillimes: 10_000,
      discountMillimes: 1_000,
      totalMillimes: 9_000,
      itemCount: 3,
    });
    expect(
      result.lines.map((line) => [
        line.netMillimes,
        line.cartDiscountShareMillimes,
        line.totalMillimes,
      ]),
    ).toEqual([
      [2_000, 200, 1_800],
      [8_000, 800, 7_200],
    ]);
  });
});

describe('cart discount', () => {
  const first = product('first', 1_005);
  const second = product('second', 1_005);

  it('is rounded once on the subtotal, then shared with the tie going to the first line', () => {
    const result = totals(setCartDiscount(cartOf([first, 1], [second, 1]), 500));

    // 5 % of 2,010 is 100.5, rounded to 101. Rounding each line (50.25 to 50) would give only 100.
    expect(result).toMatchObject({
      subtotalMillimes: 2_010,
      discountMillimes: 101,
      totalMillimes: 1_909,
    });
    expect(
      result.lines.map((line) => [
        line.productId,
        line.cartDiscountShareMillimes,
        line.totalMillimes,
      ]),
    ).toEqual([
      ['first', 51, 954],
      ['second', 50, 955],
    ]);
  });

  it('gives the tie to whichever line comes first in the cart', () => {
    const result = totals(setCartDiscount(cartOf([second, 1], [first, 1]), 500));

    expect(result.lines.map((line) => [line.productId, line.cartDiscountShareMillimes])).toEqual([
      ['second', 51],
      ['first', 50],
    ]);
  });

  it.each([
    [100, 50, 1, 99],
    [80, 50, 0, 80],
    [300, 50, 2, 298],
    [250, 100, 3, 247],
    [149, 100, 1, 148],
    [150, 100, 2, 148],
  ])(
    'rounds half away from zero: %i millimes at %i bp gives a discount of %i',
    (price, basisPoints, discount, total) => {
      const result = totals(setCartDiscount(cartOf([product('item', price), 1]), basisPoints));

      expect(result.discountMillimes).toBe(discount);
      expect(result.totalMillimes).toBe(total);
    },
  );

  it.each([
    [7_493_293_762_237, 7_481, 5_605_733_063_529, 1_887_560_698_708],
    [7_652_343_534_027_539, 250, 191_308_588_350_688, 7_461_034_945_676_851],
  ])(
    'stays exact beyond floating-point precision: %i millimes at %i bp gives a discount of %i',
    (price, basisPoints, discount, total) => {
      // subtotal × basis points is above 2^53 here, and Math.round(subtotal * bp / 10_000) comes
      // out one millime too high.
      const result = totals(setCartDiscount(cartOf([product('item', price), 1]), basisPoints));

      expect(result.discountMillimes).toBe(discount);
      expect(result.totalMillimes).toBe(total);
    },
  );

  it('hands leftover millimes to the largest remainders, not to the largest lines', () => {
    // 7 bp of 6,000 is 4.2, so 4. Exact shares are 0.667, 1.333 and 2: the smallest line has the
    // largest remainder.
    const cart = cartOf(
      [product('x', 1_000), 1],
      [product('y', 2_000), 1],
      [product('z', 3_000), 1],
    );
    const result = totals(setCartDiscount(cart, 7));

    expect(result).toMatchObject({
      subtotalMillimes: 6_000,
      discountMillimes: 4,
      totalMillimes: 5_996,
    });
    expect(result.lines.map((line) => line.cartDiscountShareMillimes)).toEqual([1, 1, 2]);
  });

  it('breaks equal remainders in line order', () => {
    // 5 bp of 3,000 is 1.5, so 2, and each of the three equal lines has an exact share of 0.667.
    const cart = cartOf(
      [product('x', 1_000), 1],
      [product('y', 1_000), 1],
      [product('z', 1_000), 1],
    );
    const result = totals(setCartDiscount(cart, 5));

    expect(result.discountMillimes).toBe(2);
    expect(result.lines.map((line) => line.cartDiscountShareMillimes)).toEqual([1, 1, 0]);
  });
});

describe('lines with a zero net amount', () => {
  it('get no share of the cart discount when fully discounted', () => {
    let cart = cartOf([coffee, 1], [milk, 1]);
    cart = discountLine(cart, 'coffee', mm(8_750));
    const result = totals(setCartDiscount(cart, 1_000));

    expect(result).toMatchObject({
      subtotalMillimes: 1_350,
      discountMillimes: 135,
      totalMillimes: 1_215,
    });
    expect(
      result.lines.map((line) => [
        line.productId,
        line.netMillimes,
        line.cartDiscountShareMillimes,
        line.totalMillimes,
      ]),
    ).toEqual([
      ['coffee', 0, 0, 0],
      ['milk', 1_350, 135, 1_215],
    ]);
  });

  it('get no share when the product is free, even as the first line on a tie', () => {
    const cart = cartOf([bag, 3], [product('first', 1_005), 1], [product('second', 1_005), 1]);
    const result = totals(setCartDiscount(cart, 500));

    expect(result).toMatchObject({ discountMillimes: 101, totalMillimes: 1_909, itemCount: 5 });
    expect(result.lines.map((line) => line.cartDiscountShareMillimes)).toEqual([0, 51, 50]);
  });

  it('leave no discount at all when every line is at zero', () => {
    let cart = cartOf([coffee, 2], [bag, 1]);
    cart = discountLine(cart, 'coffee', mm(17_500));
    const result = totals(setCartDiscount(cart, 10_000));

    expect(result).toMatchObject({
      subtotalMillimes: 0,
      discountMillimes: 0,
      totalMillimes: 0,
      itemCount: 3,
    });
    expect(result.lines.map((line) => line.cartDiscountShareMillimes)).toEqual([0, 0]);
  });
});

describe('a 100 % cart discount', () => {
  it('brings the total to zero, with every line giving up its whole net amount', () => {
    let cart = cartOf([bread, 3], [milk, 2], [coffee, 1], [bag, 1]);
    cart = discountLine(cart, 'milk', mm(55));
    const result = totals(setCartDiscount(cart, 10_000));

    expect(result).toMatchObject({
      subtotalMillimes: 11_995,
      discountMillimes: 11_995,
      totalMillimes: 0,
      itemCount: 7,
    });
    expect(
      result.lines.map((line) => [
        line.netMillimes,
        line.cartDiscountShareMillimes,
        line.totalMillimes,
      ]),
    ).toEqual([
      [600, 600, 0],
      [2_645, 2_645, 0],
      [8_750, 8_750, 0],
      [0, 0, 0],
    ]);
  });
});

describe('totals over pseudo-random carts', () => {
  interface Random {
    below(limit: bigint): bigint;
    int(limit: number): number;
  }

  interface Coverage {
    merged: number;
    capped: number;
    leftoverShared: number;
    zeroNetWithDiscount: number;
    fullDiscount: number;
    beyondFloatPrecision: number;
    tieDecided: number;
  }

  /** 64-bit linear congruential generator (Knuth's MMIX constants): every run sees the same carts. */
  function createRandom(seed: bigint): Random {
    let state = seed;
    const below = (limit: bigint): bigint => {
      state = BigInt.asUintN(64, state * 6_364_136_223_846_793_005n + 1_442_695_040_888_963_407n);
      return (state >> 11n) % limit;
    };
    return { below, int: (limit) => Number(below(BigInt(limit))) };
  }

  function sum(values: readonly bigint[]): bigint {
    return values.reduce((total, value) => total + value, 0n);
  }

  /**
   * The documented sharing rule: largest remainder, ties to the earlier line, zero nets get nothing.
   * `tieDecided` says whether the tie rule chose between two lines for the last leftover millime.
   */
  function referenceShares(
    discount: bigint,
    nets: readonly bigint[],
  ): { shares: bigint[]; tieDecided: boolean } {
    const subtotal = sum(nets);
    if (subtotal === 0n) {
      return { shares: nets.map(() => 0n), tieDecided: false };
    }
    const shares = nets.map((net) => (discount * net) / subtotal);
    const remainders = nets.map((net) => (discount * net) % subtotal);
    const leftover = Number(discount - sum(shares));
    const byRemainder = nets
      .map((_, index) => index)
      .filter((index) => nets[index] > 0n)
      .sort((a, b) => {
        if (remainders[a] !== remainders[b]) {
          return remainders[a] > remainders[b] ? -1 : 1;
        }
        return a - b;
      });
    for (const index of byRemainder.slice(0, leftover)) {
      shares[index] += 1n;
    }
    const tieDecided =
      leftover > 0 &&
      leftover < byRemainder.length &&
      remainders[byRemainder[leftover - 1]] === remainders[byRemainder[leftover]];
    return { shares, tieDecided };
  }

  const PRICE_LIMITS = [1_000n, 250_000n, 900_000_000_000n] as const;

  function randomCart(random: Random, coverage: Coverage): Cart {
    const priceLimit = PRICE_LIMITS[random.int(PRICE_LIMITS.length)];
    const randomPrice = (): number =>
      random.int(8) === 0 ? 0 : Number(random.below(priceLimit + 1n));
    // One cart in four prices every product the same, adds single units and skips line changes, so
    // equal lines, and with them ties on the remainder, are common.
    const sharedPrice = random.int(4) === 0 ? randomPrice() : null;
    const products = Array.from({ length: 1 + random.int(6) }, (_, index): CartProduct => ({
      id: `p${index}`,
      name: `Product ${index}`,
      priceMillimes: mm(sharedPrice ?? randomPrice()),
    }));

    let cart = emptyCart;
    for (let step = 1 + random.int(10); step > 0; step -= 1) {
      const item = products[random.int(products.length)];
      if (lineOf(cart, item.id)) {
        coverage.merged += 1;
      }
      cart = addItem(cart, item, sharedPrice === null ? 1 + random.int(9) : 1);
    }

    if (sharedPrice !== null) {
      // Neither 0 nor 10 000 bp, so there are usually leftover millimes to hand out.
      return setCartDiscount(cart, 1 + random.int(9_999));
    }

    const undiscounted = cart.lines;
    for (const line of undiscounted) {
      const gross = BigInt(line.unitPriceMillimes) * BigInt(line.qty);
      const choice = random.int(4);
      if (choice === 0) {
        cart = discountLine(cart, line.productId, mm(Number(random.below(gross + 1n))));
      } else if (choice === 1) {
        cart = discountLine(cart, line.productId, mm(Number(gross)));
      }
    }

    const discounted = cart.lines;
    for (const line of discounted) {
      const choice = random.int(6);
      if (choice === 0) {
        // Zero removes the line; a lower quantity may cap the line discount.
        const qty = random.int(line.qty + 1);
        const newGross = BigInt(line.unitPriceMillimes) * BigInt(qty);
        if (qty > 0 && BigInt(line.lineDiscountMillimes) > newGross) {
          coverage.capped += 1;
        }
        cart = setQty(cart, line.productId, qty);
      } else if (choice === 1) {
        cart = setQty(cart, line.productId, line.qty + 1 + random.int(5));
      } else if (choice === 2) {
        cart = removeLine(cart, line.productId);
      }
    }

    const basisPoints = [0, 10_000, random.int(10_001), random.int(10_001)][random.int(4)];
    return setCartDiscount(cart, basisPoints);
  }

  it('always adds line totals up to the cart total, with every figure exact', () => {
    const random = createRandom(20_260_911n);
    const coverage: Coverage = {
      merged: 0,
      capped: 0,
      leftoverShared: 0,
      zeroNetWithDiscount: 0,
      fullDiscount: 0,
      beyondFloatPrecision: 0,
      tieDecided: 0,
    };

    for (let round = 0; round < 1_000; round += 1) {
      const cart = randomCart(random, coverage);
      const result = totals(cart);
      const label = `cart #${round}: ${JSON.stringify(cart)}`;

      const gross = cart.lines.map((line) => BigInt(line.unitPriceMillimes) * BigInt(line.qty));
      const nets = cart.lines.map(
        (line, index) => gross[index] - BigInt(line.lineDiscountMillimes),
      );
      const subtotal = sum(nets);
      // Round half away from zero; the subtotal is never negative.
      const discount = (subtotal * BigInt(cart.discountBasisPoints) + 5_000n) / 10_000n;
      const { shares, tieDecided } = referenceShares(discount, nets);

      expect(result, label).toEqual({
        lines: cart.lines.map((line, index) => ({
          productId: line.productId,
          grossMillimes: Number(gross[index]),
          lineDiscountMillimes: line.lineDiscountMillimes,
          netMillimes: Number(nets[index]),
          cartDiscountShareMillimes: Number(shares[index]),
          totalMillimes: Number(nets[index] - shares[index]),
        })),
        subtotalMillimes: Number(subtotal),
        discountMillimes: Number(discount),
        totalMillimes: Number(subtotal - discount),
        itemCount: cart.lines.reduce((count, line) => count + line.qty, 0),
      });

      // The invariants, read from the returned figures alone.
      const lineTotals = sum(result.lines.map((line) => BigInt(line.totalMillimes)));
      const lineShares = sum(result.lines.map((line) => BigInt(line.cartDiscountShareMillimes)));
      expect(lineTotals, label).toBe(BigInt(result.totalMillimes));
      expect(lineShares, label).toBe(BigInt(result.discountMillimes));
      for (const line of result.lines) {
        const net = BigInt(line.netMillimes);
        const share = BigInt(line.cartDiscountShareMillimes);
        expect(line.lineDiscountMillimes, label).toBeGreaterThanOrEqual(0);
        expect(BigInt(line.lineDiscountMillimes) <= BigInt(line.grossMillimes), label).toBe(true);
        expect(share >= 0n && share <= net, label).toBe(true);
        if (subtotal > 0n) {
          // Proportional: within one millime of the exact share.
          const error = share * subtotal - discount * net;
          expect(error > -subtotal && error < subtotal, label).toBe(true);
        }
      }
      if (cart.discountBasisPoints === 10_000) {
        expect(result.totalMillimes, label).toBe(0);
      }

      if (shares.some((share, index) => share * subtotal !== discount * nets[index])) {
        coverage.leftoverShared += 1;
      }
      if (discount > 0n && nets.some((net) => net === 0n)) {
        coverage.zeroNetWithDiscount += 1;
      }
      if (cart.discountBasisPoints === 10_000 && subtotal > 0n) {
        coverage.fullDiscount += 1;
      }
      if (subtotal * 10_000n > BigInt(Number.MAX_SAFE_INTEGER)) {
        coverage.beyondFloatPrecision += 1;
      }
      if (tieDecided) {
        coverage.tieDecided += 1;
      }
    }

    // The generator must actually reach the interesting cases, or the loop above proves little.
    for (const [name, count] of Object.entries(coverage)) {
      expect(count, name).toBeGreaterThan(10);
    }
  });
});

describe('changeDue', () => {
  it('gives exact change in millimes', () => {
    // In floating point, 20 - 12.345 is 7.654999999999999 and 10 - 8.1 is 1.9000000000000004.
    expect(changeDue(mm(12_345), mm(20_000))).toBe(7_655);
    expect(changeDue(mm(8_100), mm(10_000))).toBe(1_900);
  });

  it('gives change on a discounted cart total', () => {
    const { totalMillimes } = totals(
      setCartDiscount(cartOf([product('first', 1_005), 1], [product('second', 1_005), 1]), 500),
    );

    expect(changeDue(totalMillimes, mm(5_000))).toBe(3_091);
  });

  it('gives zero, not negative zero, when the tender matches the total', () => {
    expect(changeDue(mm(9_000), mm(9_000))).toBe(0);
    expect(changeDue(mm(0), mm(0))).toBe(0);
  });

  it('stays exact at the largest safe amounts', () => {
    expect(changeDue(mm(1), mm(Number.MAX_SAFE_INTEGER))).toBe(9_007_199_254_740_990);
    expect(changeDue(mm(9_007_199_254_740_990), mm(Number.MAX_SAFE_INTEGER))).toBe(1);
  });

  it('throws VALIDATION_ERROR when the tender is short, even by one millime', () => {
    expectValidationError(() => changeDue(mm(10_000), mm(9_999)));
    expectValidationError(() => changeDue(mm(1), mm(0)));
  });
});

describe('immutability', () => {
  function sampleCart(): Cart {
    const cart = discountLine(cartOf([bread, 2], [milk, 3]), 'milk', mm(500));
    return setCartDiscount(cart, 250);
  }

  it('never changes the cart or the product it is given', () => {
    const cart = frozenCopy(sampleCart());
    const snapshot = structuredClone(cart);
    const item = Object.freeze({ ...coffee });

    const changed = [
      addItem(cart, item),
      addItem(cart, milk, 2),
      setQty(cart, 'milk', 1),
      setQty(cart, 'milk', 0),
      removeLine(cart, 'bread'),
      discountLine(cart, 'bread', mm(100)),
      setCartDiscount(cart, 1_000),
    ];
    totals(cart);

    expect(cart).toEqual(snapshot);
    expect(item).toEqual(coffee);
    for (const [index, next] of changed.entries()) {
      expect(next, `operation #${index}`).not.toBe(cart);
      expect(next, `operation #${index}`).not.toEqual(snapshot);
    }
  });

  it('caps a line discount without touching the original line', () => {
    const cart = frozenCopy(discountLine(cartOf([coffee, 3]), 'coffee', mm(20_000)));
    const snapshot = structuredClone(cart);

    expect(lineOf(setQty(cart, 'coffee', 1), 'coffee')?.lineDiscountMillimes).toBe(8_750);
    expect(cart).toEqual(snapshot);
  });

  it('leaves the cart unchanged when an operation is rejected', () => {
    const cart = frozenCopy(sampleCart());
    const snapshot = structuredClone(cart);

    expectValidationError(() => addItem(cart, milk, 0));
    expectValidationError(() => addItem(cart, coffee, 1.5));
    expectValidationError(() => setQty(cart, 'milk', 2.5));
    expectValidationError(() => discountLine(cart, 'milk', mm(-1)));
    expectValidationError(() => discountLine(cart, 'milk', mm(4_051)));
    expectValidationError(() => setCartDiscount(cart, 10_001));

    expect(cart).toEqual(snapshot);
  });

  it('never changes the shared empty cart', () => {
    const withBread = addItem(emptyCart, bread);
    const withMilk = setCartDiscount(addItem(emptyCart, milk, 2), 500);

    expect(emptyCart).toEqual({ lines: [], discountBasisPoints: 0 });
    expect(withBread.lines.map((line) => line.productId)).toEqual(['bread']);
    expect(withMilk.lines.map((line) => line.productId)).toEqual(['milk']);
    expect(withBread.discountBasisPoints).toBe(0);
  });
});

describe('lines that pay a table', () => {
  /** Two rows of the same product on one table: ordered separately, so paid separately. */
  function tableLine(orderItemId: string, qty = 1): CartLine {
    return {
      productId: 'coffee',
      name: 'Cafe moulu 250 g',
      unitPriceMillimes: mm(8_750),
      qty,
      lineDiscountMillimes: mm(0),
      orderItemId,
    };
  }

  it('names a line by its order item when there is one, and by its product otherwise', () => {
    expect(lineKey(tableLine('item-1'))).toBe('item-1');
    expect(lineKey(addItem(emptyCart, coffee).lines[0])).toBe('coffee');
  });

  it('keeps two rows of the same product apart', () => {
    const cart = cartOfLines([tableLine('item-1'), tableLine('item-2')]);

    expect(totals(cart).totalMillimes).toBe(17_500);
    expect(removeLine(cart, 'item-1').lines.map(lineKey)).toEqual(['item-2']);
  });

  it('discounts the row that was chosen, not every row of that product', () => {
    const cart = offerLine(
      cartOfLines([tableLine('item-1'), tableLine('item-2')]),
      'item-2',
      mm(8_750),
      'offert au client',
    );

    expect(cart.lines.map((line) => line.lineDiscountMillimes)).toEqual([0, 8_750]);
    expect(totals(cart).totalMillimes).toBe(8_750);
  });

  it('never merges a counter line into a row of the table', () => {
    const cart = addItem(cartOfLines([tableLine('item-1')]), coffee, 2);

    expect(cart.lines.map((line) => [lineKey(line), line.qty])).toEqual([
      ['item-1', 1],
      ['coffee', 2],
    ]);
  });

  it('shares the cart discount across rows of the same product line by line', () => {
    const cart = setCartDiscount(cartOfLines([tableLine('item-1'), tableLine('item-2')]), 1_000);
    const result = totals(cart);

    expect(result.discountMillimes).toBe(1_750);
    expect(result.lines.map((line) => line.cartDiscountShareMillimes)).toEqual([875, 875]);
  });
});

describe('offerLine', () => {
  const table = cartOfLines([
    {
      productId: 'coffee',
      name: 'Cafe moulu 250 g',
      unitPriceMillimes: mm(8_750),
      qty: 1,
      lineDiscountMillimes: mm(0),
      orderItemId: 'item-1',
    },
  ]);

  it('keeps the reason on the line', () => {
    const cart = offerLine(table, 'item-1', mm(8_750), 'offert : erreur cuisine');

    expect(cart.lines[0]).toMatchObject({
      lineDiscountMillimes: 8_750,
      lineDiscountReason: 'offert : erreur cuisine',
    });
  });

  it('trims the reason', () => {
    expect(offerLine(table, 'item-1', mm(500), '  geste  ').lines[0].lineDiscountReason).toBe(
      'geste',
    );
  });

  it('refuses a discount with no reason', () => {
    expectValidationError(() => offerLine(table, 'item-1', mm(500), ''));
    expectValidationError(() => offerLine(table, 'item-1', mm(500), '   '));
  });

  it('takes the reason away with the discount', () => {
    const offered = offerLine(table, 'item-1', mm(8_750), 'offert');
    const taken = offerLine(offered, 'item-1', mm(0), '');

    expect(taken.lines[0].lineDiscountMillimes).toBe(0);
    expect(taken.lines[0].lineDiscountReason).toBeUndefined();
  });

  it('still refuses a discount above the line amount', () => {
    expectValidationError(() => offerLine(table, 'item-1', mm(8_751), 'offert'));
  });

  it('leaves the cart alone when it is refused', () => {
    const cart = frozenCopy(table);
    const snapshot = structuredClone(cart);

    expectValidationError(() => offerLine(cart, 'item-1', mm(500), ''));

    expect(cart).toEqual(snapshot);
  });
});
