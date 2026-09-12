import { beforeEach, describe, expect, it } from 'vitest';
import { mm, ZERO } from '@/lib/money';
import {
  MAX_PRICE_MILLIMES,
  type Payment,
  type Product,
  type Sale,
  type SaleRecord,
} from '@/ports';
import type { ContractFixture, MakeFixture } from './fixture';
import {
  cartOf,
  closeRecord,
  contextOf,
  createProduct,
  failure,
  newId,
  openTill,
  receipt,
  recordCreated,
  refunded,
  refundRecord,
  refundWith,
  rewrite,
  saleRecord,
} from './support';

function receiptsOf(sales: readonly Sale[]): string[] {
  return sales.map((sale) => sale.receiptNumber);
}

/** The sales ledger: idempotent recording, gapless numbering, refunds, payments and voids. */
export function describeSalesPortContract(makeFixture: MakeFixture): void {
  describe('SalesPort contract', () => {
    let fixture: ContractFixture;

    beforeEach(async () => {
      fixture = await makeFixture();
    });

    it('records a sale once: created, then replayed with the same receipt, no second document and the same Z-report', async () => {
      const product = await createProduct(fixture, 'olive oil', 18_500, 20);
      const till = await openTill(fixture);
      const record = await saleRecord(till, 1, cartOf([[product, 2]]), {
        method: 'cash',
        tenderedMillimes: mm(40_000),
      });

      await expect(fixture.cashier.sales.recordSale(record)).resolves.toEqual({
        saleId: record.id,
        receiptNumber: receipt(till, 1),
        status: 'created',
      });
      const listed = await fixture.cashier.sales.listSales({ sessionId: till.sessionId });
      const report = await fixture.cashier.sessions.zReport(till.sessionId);

      const replayed = { saleId: record.id, receiptNumber: receipt(till, 1), status: 'replayed' };
      await expect(fixture.cashier.sales.recordSale(record)).resolves.toEqual(replayed);
      // Synced later under another login, the record answers the same.
      await expect(fixture.admin.sales.recordSale(record)).resolves.toEqual(replayed);

      expect(listed).toHaveLength(1);
      await expect(fixture.cashier.sales.listSales({ sessionId: till.sessionId })).resolves.toEqual(
        listed,
      );
      await expect(fixture.cashier.sessions.zReport(till.sessionId)).resolves.toEqual(report);
      const products = await fixture.cashier.catalog.listProducts();
      expect(products.find((candidate) => candidate.id === product.id)).toMatchObject({
        stockQty: 18,
      });

      const sale = await fixture.cashier.sales.getSale(record.id);
      expect(sale).toMatchObject({
        id: record.id,
        kind: 'sale',
        receiptNumber: receipt(till, 1),
        seq: 1,
        terminalId: till.terminalId,
        terminalCode: till.terminal.terminalCode,
        sessionId: till.sessionId,
        tableId: null,
        tableName: null,
        refundsSaleId: null,
        paymentMethod: 'cash',
        cartDiscountMillimes: 0,
        totalMillimes: 37_000,
        tenderedMillimes: 40_000,
        changeMillimes: 3_000,
      });
      // A stored line is the recorded line — id included, since the device names its own rows —
      // with how much of it has been given back.
      expect(sale.lines).toEqual(
        record.lines.map((line) => ({ ...line, refundedQty: 0, refundedMillimes: 0 })),
      );
      expect(listed[0]).toEqual(sale);
    });

    it('refuses the same record id with another payload with IDEMPOTENCY_CONFLICT, before the number', async () => {
      const product = await createProduct(fixture, 'harissa', 2_400);
      const till = await openTill(fixture);
      const record = await saleRecord(till, 1, cartOf([[product, 1]]), { method: 'card' });
      await recordCreated(fixture, record);

      const changed = await saleRecord(
        till,
        1,
        cartOf([[product, 2]]),
        { method: 'card' },
        {
          id: record.id,
        },
      );
      const conflict = await failure(
        fixture.cashier.sales.recordSale(changed),
        'IDEMPOTENCY_CONFLICT',
      );
      expect(conflict.details).toMatchObject({ id: record.id });
      const renumbered = await saleRecord(
        till,
        2,
        cartOf([[product, 1]]),
        { method: 'card' },
        {
          id: record.id,
        },
      );
      await failure(fixture.cashier.sales.recordSale(renumbered), 'IDEMPOTENCY_CONFLICT');

      await expect(fixture.cashier.sales.getSale(record.id)).resolves.toMatchObject({
        totalMillimes: 2_400,
        lines: [{ qty: 1 }],
      });
      await expect(
        fixture.cashier.sales.listSales({ sessionId: till.sessionId }),
      ).resolves.toHaveLength(1);
    });

    it('numbers receipts without gaps: SEQUENCE_GAP names the expected number', async () => {
      const product = await createProduct(fixture, 'milk', 1_350);
      const till = await openTill(fixture);
      const cart = cartOf([[product, 1]]);

      const early = await failure(
        fixture.cashier.sales.recordSale(await saleRecord(till, 2, cart)),
        'SEQUENCE_GAP',
      );
      expect(early.details).toMatchObject({ expectedSeq: 1, receivedSeq: 2 });
      await recordCreated(fixture, await saleRecord(till, 1, cart));

      const duplicate = await failure(
        fixture.cashier.sales.recordSale(await saleRecord(till, 1, cart)),
        'SEQUENCE_GAP',
      );
      expect(duplicate.details).toMatchObject({ expectedSeq: 2, receivedSeq: 1 });
      const ahead = await failure(
        fixture.cashier.sales.recordSale(await saleRecord(till, 3, cart)),
        'SEQUENCE_GAP',
      );
      expect(ahead.details).toMatchObject({ expectedSeq: 2, receivedSeq: 3 });
      await recordCreated(fixture, await saleRecord(till, 2, cart));

      const sales = await fixture.cashier.sales.listSales({ terminalId: till.terminalId });
      expect(receiptsOf(sales)).toEqual([receipt(till, 2), receipt(till, 1)]);
      await expect(
        fixture.admin.terminals.register(till.terminal.terminalCode),
      ).resolves.toMatchObject({ lastSeq: 2 });
    });

    it('refuses new records of a superseded registration with TERMINAL_SUPERSEDED, before the number, while replays still answer', async () => {
      const product = await createProduct(fixture, 'bread', 190);
      const till = await openTill(fixture);
      const cart = cartOf([[product, 4]]);
      const first = await saleRecord(till, 1, cart);
      await recordCreated(fixture, first);

      const registration = await fixture.admin.terminals.register(till.terminal.terminalCode);
      expect(registration).toMatchObject({ lastSeq: 1, epoch: till.terminal.epoch + 1 });

      const superseded = await failure(
        fixture.cashier.sales.recordSale(await saleRecord(till, 2, cart)),
        'TERMINAL_SUPERSEDED',
      );
      expect(superseded.details).toMatchObject({
        terminalCode: till.terminal.terminalCode,
        currentEpoch: registration.epoch,
      });
      await failure(
        fixture.cashier.sales.recordSale(await saleRecord(till, 7, cart)),
        'TERMINAL_SUPERSEDED',
      );
      await expect(fixture.cashier.sales.recordSale(first)).resolves.toEqual({
        saleId: first.id,
        receiptNumber: receipt(till, 1),
        status: 'replayed',
      });

      // The device registered now continues the open session and the numbering.
      await recordCreated(
        fixture,
        await saleRecord(till, 2, cart, { method: 'cash' }, { terminal: contextOf(registration) }),
      );
    });

    it('refuses records for a closed session with SESSION_CLOSED, before the number, while replays still answer', async () => {
      const product = await createProduct(fixture, 'tea', 4_200);
      const till = await openTill(fixture, mm(10_000));
      const cart = cartOf([[product, 1]]);
      const first = await saleRecord(till, 1, cart);
      await recordCreated(fixture, first);
      await fixture.cashier.sessions.close(
        await closeRecord(till.terminal, till.sessionId, fixture.cashierUser.id, mm(14_200)),
      );

      const closed = await failure(
        fixture.cashier.sales.recordSale(await saleRecord(till, 2, cart)),
        'SESSION_CLOSED',
      );
      expect(closed.details).toMatchObject({ sessionId: till.sessionId });
      await failure(
        fixture.cashier.sales.recordSale(await saleRecord(till, 9, cart)),
        'SESSION_CLOSED',
      );
      await expect(fixture.cashier.sales.recordSale(first)).resolves.toMatchObject({
        status: 'replayed',
        receiptNumber: receipt(till, 1),
      });
    });

    it('answers NOT_FOUND for an unknown session or product, and FORBIDDEN for another terminal or its session', async () => {
      const product = await createProduct(fixture, 'coffee', 6_700);
      const till = await openTill(fixture);
      const other = await openTill(fixture);
      const cart = cartOf([[product, 1]]);

      // The session is checked before the number.
      const unknownSession = newId();
      const noSession = await failure(
        fixture.cashier.sales.recordSale(
          await saleRecord(till, 5, cart, { method: 'card' }, { sessionId: unknownSession }),
        ),
        'NOT_FOUND',
      );
      expect(noSession.details).toMatchObject({ sessionId: unknownSession });

      const foreign = await failure(
        fixture.cashier.sales.recordSale(
          await saleRecord(till, 1, cart, { method: 'card' }, { sessionId: other.sessionId }),
        ),
        'FORBIDDEN',
      );
      expect(foreign.details).toMatchObject({ sessionId: other.sessionId });

      const ghost: Product = { ...product, id: newId(), name: 'Ghost' };
      const noProduct = await failure(
        fixture.cashier.sales.recordSale(
          await saleRecord(
            till,
            1,
            cartOf([
              [product, 1],
              [ghost, 1],
            ]),
            { method: 'card' },
          ),
        ),
        'NOT_FOUND',
      );
      expect(noProduct.details).toMatchObject({ productId: ghost.id });

      const unregistered = { terminalCode: fixture.newTerminalCode(), epoch: 0 };
      const noTerminal = await failure(
        fixture.cashier.sales.recordSale(
          await saleRecord(till, 1, cart, { method: 'card' }, { terminal: unregistered }),
        ),
        'FORBIDDEN',
      );
      expect(noTerminal.details).toMatchObject({ terminalCode: unregistered.terminalCode });

      await failure(fixture.cashier.sales.getSale(newId()), 'NOT_FOUND');

      // None of the refused records used a number.
      await recordCreated(fixture, await saleRecord(till, 1, cart, { method: 'card' }));
    });

    it('applies the payment rules: cash covers the total and gives change, card and refunds pay exactly the total', async () => {
      const product = await createProduct(fixture, 'dates', 1_500);
      const till = await openTill(fixture);
      const cart = cartOf([[product, 2]]);
      const cash = await saleRecord(till, 1, cart, {
        method: 'cash',
        tenderedMillimes: mm(5_000),
      });
      const card = await saleRecord(till, 1, cart, { method: 'card' });

      const refused: SaleRecord[] = [
        // Cash below the total of 3 000.
        await rewrite(cash, {
          id: newId(),
          payment: { method: 'cash', tenderedMillimes: mm(2_999), changeMillimes: mm(0) },
        }),
        // Change that is not tendered minus total.
        await rewrite(cash, {
          id: newId(),
          payment: { method: 'cash', tenderedMillimes: mm(5_000), changeMillimes: mm(1_000) },
        }),
        // Card above the total, with change.
        await rewrite(card, {
          id: newId(),
          payment: { method: 'card', tenderedMillimes: mm(3_500), changeMillimes: mm(500) },
        }),
        // Card below the total.
        await rewrite(card, {
          id: newId(),
          payment: { method: 'card', tenderedMillimes: mm(2_500), changeMillimes: mm(0) },
        }),
        // Totals that do not match the lines, paid as stated.
        await rewrite(card, {
          id: newId(),
          totalMillimes: mm(2_900),
          payment: { method: 'card', tenderedMillimes: mm(2_900), changeMillimes: mm(0) },
        }),
      ];
      for (const record of refused) {
        await failure(fixture.cashier.sales.recordSale(record), 'VALIDATION_ERROR');
      }

      await recordCreated(fixture, cash);
      await recordCreated(fixture, await saleRecord(till, 2, cart, { method: 'cash' }));
      await recordCreated(fixture, await saleRecord(till, 3, cart, { method: 'card' }));
      const sale = await fixture.cashier.sales.getSale(cash.id);
      expect(sale).toMatchObject({
        paymentMethod: 'cash',
        totalMillimes: 3_000,
        tenderedMillimes: 5_000,
        changeMillimes: 2_000,
      });

      const refund = await refundRecord(till, 4, sale, [{ lineNo: 1, qty: 1 }], 'cash');
      const refusedPayments: Payment[] = [
        { method: 'cash', tenderedMillimes: mm(0), changeMillimes: mm(0) },
        { method: 'cash', tenderedMillimes: mm(-1_500), changeMillimes: mm(100) },
        { method: 'card', tenderedMillimes: mm(-1_400), changeMillimes: mm(0) },
      ];
      for (const payment of refusedPayments) {
        await failure(
          fixture.cashier.sales.recordSale(await rewrite(refund, { id: newId(), payment })),
          'VALIDATION_ERROR',
        );
      }
      await recordCreated(fixture, refund);
      await expect(fixture.cashier.sales.getSale(refund.id)).resolves.toMatchObject({
        kind: 'refund',
        refundsSaleId: sale.id,
        paymentMethod: 'cash',
        totalMillimes: -1_500,
        tenderedMillimes: -1_500,
        changeMillimes: 0,
      });
    });

    it('refuses a sale line above the price cap and records one exactly at it', async () => {
      const product = await createProduct(fixture, 'gold bar', MAX_PRICE_MILLIMES, 2);
      const till = await openTill(fixture);
      const atCap = await saleRecord(till, 1, cartOf([[product, 1]]), { method: 'card' });
      expect(atCap.totalMillimes).toBe(MAX_PRICE_MILLIMES);

      // A unit price is a product price, so a record cannot carry one above the bound either.
      const overCap = mm(MAX_PRICE_MILLIMES + 1);
      const above = await rewrite(atCap, {
        id: newId(),
        lines: [{ ...atCap.lines[0], unitPriceMillimes: overCap, netMillimes: overCap }],
        totalMillimes: overCap,
        payment: { method: 'card', tenderedMillimes: overCap, changeMillimes: ZERO },
      });
      await failure(fixture.cashier.sales.recordSale(above), 'VALIDATION_ERROR');

      // The refused record took no number.
      await recordCreated(fixture, atCap);
      await expect(fixture.cashier.sales.getSale(atCap.id)).resolves.toMatchObject({
        totalMillimes: MAX_PRICE_MILLIMES,
        lines: [{ unitPriceMillimes: MAX_PRICE_MILLIMES }],
      });
    });

    it('refunds within what is left of each line and refuses more units or more money than that', async () => {
      const a = await createProduct(fixture, 'A', 1_500, 10);
      const c = await createProduct(fixture, 'C', 1_000, 10);
      const till = await openTill(fixture);
      // 2 × 1 500 + 3 × 1 000 = 6 000, less 0.05 % (3) shared as 2 and 1: lines of 2 998 and 2 999.
      const record = await saleRecord(
        till,
        1,
        cartOf(
          [
            [a, 2],
            [c, 3],
          ],
          5,
        ),
      );
      expect(record.lines.map((line) => line.netMillimes)).toEqual([2_998, 2_999]);
      await recordCreated(fixture, record);

      // One unit of line 2: floor(2 999 × 1 / 3) = 999. A refund line names the stored line it gives
      // back by its id, not by its number, so it survives being read back in any order.
      const stored = await fixture.cashier.sales.getSale(record.id);
      const first = await refundRecord(till, 2, stored, [{ lineNo: 2, qty: 1 }]);
      expect(first.lines).toMatchObject([
        { lineNo: 1, refundsSaleLineId: stored.lines[1].id, qty: -1, netMillimes: -999 },
      ]);
      await recordCreated(fixture, first);
      const sale = await fixture.cashier.sales.getSale(record.id);
      expect(refunded(sale)).toEqual([
        [0, 0],
        [1, 999],
      ]);

      // Three more units of line 2, where two are left, even for no more than the 2 000 left.
      const tooMany = await refundWith(first, 3, [
        { ...first.lines[0], qty: -3, netMillimes: mm(-2_000) },
      ]);
      const units = await failure(fixture.cashier.sales.recordSale(tooMany), 'VALIDATION_ERROR');
      expect(units.details).toMatchObject({ lineNo: 1, remainingQty: 2, remainingMillimes: 2_000 });
      // One unit of line 2 for 2 001, where 2 000 are left.
      const tooMuch = await refundWith(first, 3, [
        { ...first.lines[0], qty: -1, netMillimes: mm(-2_001) },
      ]);
      const money = await failure(fixture.cashier.sales.recordSale(tooMuch), 'VALIDATION_ERROR');
      expect(money.details).toMatchObject({ lineNo: 1, remainingQty: 2, remainingMillimes: 2_000 });

      // One unit of line 1 (1 499) and the two units left of line 2 (1 000 + 1 000), paid by card.
      const second = await refundRecord(
        till,
        3,
        sale,
        [
          { lineNo: 1, qty: 1 },
          { lineNo: 2, qty: 2 },
        ],
        'card',
      );
      expect(second.lines).toMatchObject([
        { lineNo: 1, refundsSaleLineId: stored.lines[0].id, qty: -1, netMillimes: -1_499 },
        { lineNo: 2, refundsSaleLineId: stored.lines[1].id, qty: -2, netMillimes: -2_000 },
      ]);
      await recordCreated(fixture, second);
      expect(refunded(await fixture.cashier.sales.getSale(record.id))).toEqual([
        [1, 1_499],
        [3, 2_999],
      ]);

      // Line 2 is fully refunded: the error names the line of the refund that asks for more.
      const nothingLeft = await refundWith(second, 4, [
        { ...second.lines[0], qty: -1, netMillimes: mm(-1_499) },
        { ...second.lines[1], qty: -1, netMillimes: mm(-1) },
      ]);
      const empty = await failure(
        fixture.cashier.sales.recordSale(nothingLeft),
        'VALIDATION_ERROR',
      );
      expect(empty.details).toMatchObject({ lineNo: 2, remainingQty: 0, remainingMillimes: 0 });

      // The refused refunds took nothing and used no number.
      await recordCreated(
        fixture,
        await refundRecord(till, 4, await fixture.cashier.sales.getSale(record.id), [
          { lineNo: 1, qty: 1 },
        ]),
      );
      expect(refunded(await fixture.cashier.sales.getSale(record.id))).toEqual([
        [2, 2_998],
        [3, 2_999],
      ]);
      await expect(fixture.cashier.sales.getSale(first.id)).resolves.toMatchObject({
        kind: 'refund',
        refundsSaleId: record.id,
        totalMillimes: -999,
        lines: [{ refundsSaleLineId: stored.lines[1].id, refundedQty: 0, refundedMillimes: 0 }],
      });
      await expect(
        fixture.cashier.sales.listSales({ sessionId: till.sessionId }),
      ).resolves.toHaveLength(4);
      const products = await fixture.cashier.catalog.listProducts();
      expect(
        products
          .filter((candidate) => candidate.id === a.id || candidate.id === c.id)
          .map((candidate) => candidate.stockQty),
      ).toEqual([10, 10]);
    });

    it('makes a refund of the last units of a line pay exactly what is left of it', async () => {
      const c = await createProduct(fixture, 'C', 1_000);
      const till = await openTill(fixture);
      // 3 × 1 000 less 0.05 % (2): one line of 2 998, refunded unit by unit as 999, 999 and 1 000.
      const record = await saleRecord(till, 1, cartOf([[c, 3]], 5));
      await recordCreated(fixture, record);

      const all = await refundRecord(till, 2, await fixture.cashier.sales.getSale(record.id), [
        { lineNo: 1, qty: 3 },
      ]);
      expect(all.totalMillimes).toBe(-2_998);
      const short = await failure(
        fixture.cashier.sales.recordSale(
          await refundWith(all, 2, [{ ...all.lines[0], netMillimes: mm(-2_997) }]),
        ),
        'VALIDATION_ERROR',
      );
      expect(short.details).toMatchObject({ lineNo: 1, remainingQty: 3, remainingMillimes: 2_998 });

      for (const seq of [2, 3]) {
        const refund = await refundRecord(
          till,
          seq,
          await fixture.cashier.sales.getSale(record.id),
          [{ lineNo: 1, qty: 1 }],
        );
        expect(refund.totalMillimes).toBe(-999);
        await recordCreated(fixture, refund);
      }

      // The last unit: 999, what each earlier unit paid, is short of the 1 000 left.
      const last = await refundRecord(till, 4, await fixture.cashier.sales.getSale(record.id), [
        { lineNo: 1, qty: 1 },
      ]);
      expect(last.totalMillimes).toBe(-1_000);
      const underpaid = await failure(
        fixture.cashier.sales.recordSale(
          await refundWith(last, 4, [{ ...last.lines[0], netMillimes: mm(-999) }]),
        ),
        'VALIDATION_ERROR',
      );
      expect(underpaid.details).toMatchObject({
        lineNo: 1,
        remainingQty: 1,
        remainingMillimes: 1_000,
      });

      await recordCreated(fixture, last);
      expect(refunded(await fixture.cashier.sales.getSale(record.id))).toEqual([[3, 2_998]]);
    });

    it('voids a record that can never be accepted, keeping numbering gapless, and a resend returns voided', async () => {
      const product = await createProduct(fixture, 'water', 750);
      const till = await openTill(fixture);
      const sale = await saleRecord(till, 1, cartOf([[product, 2]]));
      await recordCreated(fixture, sale);

      // Refunded twice while offline: three units of a two-unit line can never be accepted.
      const valid = await refundRecord(till, 2, await fixture.cashier.sales.getSale(sale.id), [
        { lineNo: 1, qty: 2 },
      ]);
      const stuck = await refundWith(valid, 2, [
        { ...valid.lines[0], qty: -3, netMillimes: mm(-2_250) },
      ]);
      await failure(fixture.cashier.sales.recordSale(stuck), 'VALIDATION_ERROR');

      const input = {
        record: stuck,
        errorCode: 'VALIDATION_ERROR',
        reason: 'Refunded twice while offline',
      };
      await failure(fixture.cashier.sales.voidReceipt(input), 'FORBIDDEN');
      const voided = { saleId: stuck.id, receiptNumber: receipt(till, 2), status: 'voided' };
      await expect(fixture.admin.sales.voidReceipt(input)).resolves.toEqual(voided);
      await expect(fixture.admin.sales.voidReceipt(input)).resolves.toEqual({
        ...voided,
        status: 'replayed',
      });
      const conflict = await failure(
        fixture.admin.sales.voidReceipt({
          ...input,
          record: await rewrite(stuck, { createdAt: '2020-01-01T00:00:00.000Z' }),
        }),
        'IDEMPOTENCY_CONFLICT',
      );
      expect(conflict.details).toMatchObject({ id: stuck.id });

      // The register resends the record and learns that it was voided.
      await expect(fixture.cashier.sales.recordSale(stuck)).resolves.toEqual(voided);

      // Numbering continues after the voided number.
      const gap = await failure(
        fixture.cashier.sales.recordSale(await saleRecord(till, 2, cartOf([[product, 1]]))),
        'SEQUENCE_GAP',
      );
      expect(gap.details).toMatchObject({ expectedSeq: 3, receivedSeq: 2 });
      await recordCreated(fixture, await saleRecord(till, 3, cartOf([[product, 1]])));

      // A record that reached the ledger is not voided but reported as recorded, if it is the same record.
      await expect(fixture.admin.sales.voidReceipt({ ...input, record: sale })).resolves.toEqual({
        saleId: sale.id,
        receiptNumber: receipt(till, 1),
        status: 'recorded',
      });
      await failure(
        fixture.admin.sales.voidReceipt({
          ...input,
          record: await rewrite(sale, { createdAt: '2020-01-01T00:00:00.000Z' }),
        }),
        'IDEMPOTENCY_CONFLICT',
      );
      // Only the next number can be voided.
      const skipped = await failure(
        fixture.admin.sales.voidReceipt({
          ...input,
          record: await saleRecord(till, 9, cartOf([[product, 1]])),
        }),
        'SEQUENCE_GAP',
      );
      expect(skipped.details).toMatchObject({ expectedSeq: 4, receivedSeq: 9 });

      const sales = await fixture.cashier.sales.listSales({ sessionId: till.sessionId });
      expect(receiptsOf(sales)).toEqual([receipt(till, 3), receipt(till, 1)]);
      await expect(fixture.cashier.sessions.zReport(till.sessionId)).resolves.toMatchObject({
        salesCount: 2,
        refundsCount: 0,
        voidsCount: 1,
      });
      await expect(
        fixture.admin.terminals.register(till.terminal.terminalCode),
      ).resolves.toMatchObject({ lastSeq: 3 });
    });

    it('lists sales newest first, by terminal or by session, up to a limit', async () => {
      const product = await createProduct(fixture, 'baguette', 190);
      const till = await openTill(fixture);
      const other = await openTill(fixture);
      for (const seq of [1, 2, 3]) {
        await recordCreated(
          fixture,
          await saleRecord(till, seq, cartOf([[product, seq]]), { method: 'card' }),
        );
      }
      await recordCreated(
        fixture,
        await saleRecord(other, 1, cartOf([[product, 5]]), { method: 'card' }),
      );

      const byTerminal = await fixture.cashier.sales.listSales({ terminalId: till.terminalId });
      expect(receiptsOf(byTerminal)).toEqual([
        receipt(till, 3),
        receipt(till, 2),
        receipt(till, 1),
      ]);
      const limited = await fixture.cashier.sales.listSales({
        terminalId: till.terminalId,
        limit: 2,
      });
      expect(receiptsOf(limited)).toEqual([receipt(till, 3), receipt(till, 2)]);
      const bySession = await fixture.admin.sales.listSales({ sessionId: other.sessionId });
      expect(receiptsOf(bySession)).toEqual([receipt(other, 1)]);
      await expect(fixture.cashier.sales.getSale(byTerminal[0].id)).resolves.toEqual(byTerminal[0]);
    });

    it('still records sales and refunds of an archived product', async () => {
      const product = await createProduct(fixture, 'seasonal', 4_200, 5);
      const till = await openTill(fixture);
      const sale = await saleRecord(till, 1, cartOf([[product, 2]]));
      await recordCreated(fixture, sale);

      await fixture.admin.catalog.deleteProduct(product.id);
      const products = await fixture.cashier.catalog.listProducts();
      expect(products.map((candidate) => candidate.id)).not.toContain(product.id);

      // A register that still shows the product sells it, and the earlier sale is refunded.
      const later = await saleRecord(till, 2, cartOf([[product, 1]]), { method: 'card' });
      await recordCreated(fixture, later);
      await recordCreated(
        fixture,
        await refundRecord(till, 3, await fixture.cashier.sales.getSale(sale.id), [
          { lineNo: 1, qty: 2 },
        ]),
      );
      await expect(fixture.cashier.sales.getSale(later.id)).resolves.toMatchObject({
        lines: [{ productId: product.id, productName: product.name, qty: 1 }],
      });
    });
  });
}
