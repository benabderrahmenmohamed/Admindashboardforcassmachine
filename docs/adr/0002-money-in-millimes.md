# 2. Money is integer millimes

**Status:** Accepted. Landed in Phase 2 (`1758053`). `src/lib/money.ts` has not changed since.

## Context

The Tunisian dinar has three decimals: 1 DT = 1000 millimes. The Figma Make export kept prices as JavaScript
numbers in dinars, so a price was a float and a total was a sum of floats. `0.1 + 0.2` is not `0.3`, and a
register that prints `12,500 DT` has to be able to add the same figures a cashier adds on paper.

A register also divides: a cart-wide discount is a percentage, and a refund takes part of a line. Every such
division has to land on a whole millime and the parts have to add back up to the whole.

## Decision

**One type.** `Millimes` in `src/lib/money.ts` is `number` with a unique-symbol brand. Values come only from
`mm`, `parseTND`/`tryParseTND`, or `millimesSchema` in `src/ports/common.ts`. `mm` throws `VALIDATION_ERROR`
for a fraction or an unsafe integer and normalises `-0` to `0`, so equality and serialisation never see it.

**Arithmetic through functions.** `add`, `sub`, `neg` and `mulQty` convert to `BigInt`, compute, and come back
through `fromBigInt`, which throws `'Amount is out of range'` outside `Number.MIN_SAFE_INTEGER` …
`MAX_SAFE_INTEGER`. Nothing overflows silently.

**Rounding happens once, in one place.** `divRoundHalfAwayFromZero(numerator, denominator)` rounds a bigint
quotient half away from zero. `pct(amount, basisPoints)` is its only caller and computes
`amount × basisPoints / 10 000`; its comment states that this is the only place a percentage is rounded. Half
away from zero rather than half to even, because a cashier redoing the arithmetic by hand rounds that way.

**Shares add up to the whole.** `allocate(total, weights)` splits a total in proportion by the largest
remainder method: leftover millimes go to the largest remainders, ties to the lower index, zero weights get
nothing, and allocating a non-zero total across all-zero weights throws. The parts sum to exactly `total`.

**Parsing rejects; it never rounds.** `tryParseTND` accepts an optional minus sign, digits and at most three
decimals after `.` or `,`. A fourth decimal, a thousands separator or an exponent returns `null`, "so no
caller ever rounds a value it was given". `parseTND` throws instead. The product form
(`src/features/products/schema.ts`) calls `tryParseTND` inside a `superRefine` and shows
`PRICE_FORMAT_MESSAGE`; it does not quietly truncate what was typed.

**Display never sees a float.** `toDinarsString` builds the exact decimal by integer division;
`formatTND` hands that string to an `fr-TN` `Intl.NumberFormat`, which reads a decimal string exactly.

**One billion dinars, enforced twice.** `MAX_PRICE_MILLIMES = mm(1_000_000_000_000)` in
`src/ports/catalog.ts`, with `priceMillimesSchema` refusing anything above it — up to that bound every amount
has at most 13 significant digits and survives a JSON number exactly. The database repeats the same literal:
`products.price_millimes` and `sale_lines.unit_price_millimes` carry `<= 1000000000000` checks, and
`record_sale` raises `VALIDATION_ERROR` for a unit price above it. Only the **per-unit** price is bounded; a
line total is qty × unit price and may legitimately exceed it, as the `sale_lines` comment says, and so may
the discounts and the document totals.

### What was revised

**The cart discount is allocated across lines, not applied once on the subtotal.** `Cart.discountBasisPoints`
is still documented as "applied once to the subtotal" — that comment is a leftover and is wrong. `totals()`
rounds once on the subtotal with `pct`, then shares that single rounded amount across lines with `allocate`,
weighted by each line's net, and `CartTotals` documents it that way.

The ledger forced the change. Phase 2's port had no discount at all: `RecordSaleInput` was
`{ lines, paymentMethod }`. Phase 3 gave `saleLineSchema` a `cartDiscountShareMillimes`, gave `sale_lines` a
`cart_discount_share_millimes` column, and made `record_sale` recompute the document's discount as the sum of
the line shares (`v_discount := v_discount + v_share`) before comparing it with the claimed
`discount_millimes`. A discount that existed only on the subtotal would not match its lines, and the record
would be refused.

Refunds split a line by a different rule, for the same reason. `refundShare` in
`src/features/sales/records.ts` uses cumulative floor, `C(x) = floor(net × x / units)`, so however a line is
refunded in parts the parts add to exactly its net. The database checks the same thing from its side: a
refund of a line's last units must pay exactly what is left of it.

## Consequences

- Every amount that crosses a port or the wire is an integer. `canonicalJson` in `src/lib/payloadHash.ts`
  refuses a non-integer number, so a float can never reach a `payload_hash`.
- Cost: arithmetic is function calls, not operators, and the brand does not stop `+`. `a + b` on two
  `Millimes` type-checks and produces a wrong-but-plausible number with no lint rule against it.
- Cost: `BigInt` conversion on every addition, for amounts that would fit in a double. The register does not
  add enough numbers for that to matter, but it is not free.
- Centralising rounding in `pct` means any future percentage — a tax rate, a service charge — has to be
  expressed in basis points and go through it, or it breaks the invariant.
- `allocate` requires non-negative weights, so a negative line cannot be used as a weight.

## Alternatives rejected

- **Floats in dinars**, as exported. `0.1 + 0.2`; a total that shows `12.499999`; a receipt that cannot be
  re-added by hand.
- **`decimal.js` or `dinero.js`.** A dependency, plus a serialisation format for every record, every column
  and every hash, for a currency whose minor unit is already a fixed three decimals. Integers are exact
  without any of it.
- **`bigint` end to end.** JSON has no bigint, so every RPC payload, every REST body and the canonical JSON
  the `payload_hash` is computed over would need an encoding of its own.
- **Round each line's share independently.** The shares would not sum to the rounded total, and `record_sale`
  would refuse the record for totals that do not match its lines.
- **Round a typed price instead of refusing it.** A cashier who types a fourth decimal would be charged
  something they did not type. Refusing is the smaller surprise.
