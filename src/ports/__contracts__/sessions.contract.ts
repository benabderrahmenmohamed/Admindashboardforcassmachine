import { beforeEach, describe, expect, it } from 'vitest';
import { computeZReport, sameZReport } from '@/features/sessions/zReport';
import { mm } from '@/lib/money';
import type { ContractFixture, MakeFixture } from './fixture';
import {
  cartOf,
  closeRecord,
  contextOf,
  createProduct,
  failure,
  newId,
  openRecord,
  openTill,
  recordCreated,
  refundRecord,
  registerTerminal,
  saleRecord,
} from './support';

const NOTHING = { salesMillimes: 0, refundsMillimes: 0, netMillimes: 0 };

/** Opening and closing cash sessions, and their Z-reports. */
export function describeSessionsPortContract(makeFixture: MakeFixture): void {
  describe('SessionsPort contract', () => {
    let fixture: ContractFixture;

    beforeEach(async () => {
      fixture = await makeFixture();
    });

    it('opens a session once: created, then replayed with the same session', async () => {
      const { terminalId, terminal } = await registerTerminal(fixture);
      await expect(fixture.cashier.sessions.current(terminalId)).resolves.toBeNull();
      const record = await openRecord(terminal, fixture.cashierUser.id, mm(20_000));

      const opened = await fixture.cashier.sessions.open(record);

      expect(opened).toMatchObject({
        sessionId: record.id,
        status: 'created',
        session: {
          id: record.id,
          terminalId,
          terminalCode: terminal.terminalCode,
          openedBy: fixture.cashierUser.id,
          openingFloatMillimes: 20_000,
          closedAt: null,
          closedBy: null,
          closingCountedMillimes: null,
          forceCloseReason: null,
          zReport: null,
        },
      });
      // Replayed later under another login, the record answers the same.
      await expect(fixture.admin.sessions.open(record)).resolves.toEqual({
        ...opened,
        status: 'replayed',
      });
      await expect(fixture.cashier.sessions.current(terminalId)).resolves.toEqual(opened.session);
    });

    it('refuses the same session id with another payload: IDEMPOTENCY_CONFLICT', async () => {
      const { terminalId, terminal } = await registerTerminal(fixture);
      const record = await openRecord(terminal, fixture.cashierUser.id, mm(20_000));
      await fixture.cashier.sessions.open(record);

      const other = await openRecord(terminal, fixture.cashierUser.id, mm(30_000), record.id);
      const conflict = await failure(fixture.cashier.sessions.open(other), 'IDEMPOTENCY_CONFLICT');

      expect(conflict.details).toMatchObject({ id: record.id });
      await expect(fixture.cashier.sessions.current(terminalId)).resolves.toMatchObject({
        id: record.id,
        openingFloatMillimes: 20_000,
      });
    });

    it('refuses a second open session on a terminal with SESSION_ALREADY_OPEN, before checking the actor', async () => {
      const { terminalId, terminal } = await registerTerminal(fixture);
      const first = await openRecord(terminal, fixture.cashierUser.id, mm(20_000));
      await fixture.cashier.sessions.open(first);

      const second = await failure(
        fixture.cashier.sessions.open(await openRecord(terminal, fixture.cashierUser.id, mm(0))),
        'SESSION_ALREADY_OPEN',
      );
      expect(second.details).toMatchObject({ openSessionId: first.id });
      await failure(
        fixture.cashier.sessions.open(await openRecord(terminal, newId(), mm(0))),
        'SESSION_ALREADY_OPEN',
      );

      await expect(fixture.cashier.sessions.current(terminalId)).resolves.toMatchObject({
        id: first.id,
      });
    });

    it('opens only on a terminal of the shop, for an actor of the shop, who need not be the caller', async () => {
      const { terminal } = await registerTerminal(fixture);

      const stranger = newId();
      const outsider = await failure(
        fixture.cashier.sessions.open(await openRecord(terminal, stranger, mm(0))),
        'FORBIDDEN',
      );
      expect(outsider.details).toMatchObject({ actorUserId: stranger });

      const unregistered = { terminalCode: fixture.newTerminalCode(), epoch: 0 };
      const unknownTerminal = await failure(
        fixture.cashier.sessions.open(
          await openRecord(unregistered, fixture.cashierUser.id, mm(0)),
        ),
        'FORBIDDEN',
      );
      expect(unknownTerminal.details).toMatchObject({ terminalCode: unregistered.terminalCode });

      // The admin syncs the session a cashier opened: the session names the cashier.
      const record = await openRecord(terminal, fixture.cashierUser.id, mm(5_000));
      await expect(fixture.admin.sessions.open(record)).resolves.toMatchObject({
        status: 'created',
        session: { openedBy: fixture.cashierUser.id, openingFloatMillimes: 5_000 },
      });
    });

    it('reports a running Z-report while the session is open, and NOT_FOUND for an unknown session', async () => {
      const till = await openTill(fixture, mm(7_500));

      await expect(fixture.cashier.sessions.zReport(till.sessionId)).resolves.toEqual({
        sessionId: till.sessionId,
        openingFloatMillimes: 7_500,
        salesCount: 0,
        refundsCount: 0,
        grossMillimes: 0,
        refundsMillimes: 0,
        netMillimes: 0,
        byMethod: { cash: NOTHING, card: NOTHING },
        expectedCashMillimes: 7_500,
        countedCashMillimes: null,
        varianceMillimes: null,
        voidsCount: 0,
      });

      const unknown = newId();
      const missing = await failure(fixture.cashier.sessions.zReport(unknown), 'NOT_FOUND');
      expect(missing.details).toMatchObject({ sessionId: unknown });
    });

    it('computes the Z-report of a known session: counts, refunds, totals by method, expected cash and variance', async () => {
      const a = await createProduct(fixture, 'A', 1_500);
      const b = await createProduct(fixture, 'B', 2_450);
      const c = await createProduct(fixture, 'C', 1_000);
      const till = await openTill(fixture, mm(20_000));

      // Cash 3 000, tendered 5 000.
      const first = await saleRecord(till, 1, cartOf([[a, 2]]), {
        method: 'cash',
        tenderedMillimes: mm(5_000),
      });
      // Card 2 450 + 3 000 = 5 450.
      const second = await saleRecord(
        till,
        2,
        cartOf([
          [b, 1],
          [c, 3],
        ]),
        { method: 'card' },
      );
      // Cash 3 000 less 0.05 %, rounded to 2: 2 998, tendered 3 000.
      const third = await saleRecord(till, 3, cartOf([[c, 3]], 5), {
        method: 'cash',
        tenderedMillimes: mm(3_000),
      });
      for (const record of [first, second, third]) {
        await recordCreated(fixture, record);
      }
      // Card refund of one of the three units of 1 000: 1 000.
      const cardRefund = await refundRecord(
        till,
        4,
        await fixture.cashier.sales.getSale(second.id),
        [{ lineNo: 2, qty: 1 }],
        'card',
      );
      await recordCreated(fixture, cardRefund);
      // Cash refund of one of the two units of 1 500: 1 500.
      const cashRefund = await refundRecord(
        till,
        5,
        await fixture.cashier.sales.getSale(first.id),
        [{ lineNo: 1, qty: 1 }],
        'cash',
      );
      await recordCreated(fixture, cashRefund);

      const running = {
        sessionId: till.sessionId,
        openingFloatMillimes: 20_000,
        salesCount: 3,
        refundsCount: 2,
        grossMillimes: 11_448,
        refundsMillimes: 2_500,
        netMillimes: 8_948,
        byMethod: {
          cash: { salesMillimes: 5_998, refundsMillimes: 1_500, netMillimes: 4_498 },
          card: { salesMillimes: 5_450, refundsMillimes: 1_000, netMillimes: 4_450 },
        },
        expectedCashMillimes: 24_498,
        countedCashMillimes: null,
        varianceMillimes: null,
        voidsCount: 0,
      };
      await expect(fixture.cashier.sessions.zReport(till.sessionId)).resolves.toEqual(running);

      // The register's own calculation from the listed documents agrees with the backend's.
      const documents = await fixture.cashier.sales.listSales({ sessionId: till.sessionId });
      const local = computeZReport({
        sessionId: till.sessionId,
        openingFloatMillimes: till.openingFloatMillimes,
        documents,
        voidsCount: 0,
        countedCashMillimes: mm(24_000),
      });
      const closed = await fixture.cashier.sessions.close(
        await closeRecord(till.terminal, till.sessionId, fixture.cashierUser.id, mm(24_000), {
          clientZReport: local,
        }),
      );

      expect(closed.zReport).toEqual({
        ...running,
        countedCashMillimes: 24_000,
        varianceMillimes: -498,
      });
      expect(sameZReport(closed.zReport, local)).toBe(true);
    });

    it('closes a session with its Z-report, and a replayed close returns the report stored at close time', async () => {
      const product = await createProduct(fixture, 'dates', 3_000);
      const till = await openTill(fixture, mm(20_000));
      await recordCreated(
        fixture,
        await saleRecord(till, 1, cartOf([[product, 1]]), {
          method: 'cash',
          tenderedMillimes: mm(5_000),
        }),
      );
      const close = await closeRecord(
        till.terminal,
        till.sessionId,
        fixture.cashierUser.id,
        mm(22_500),
      );

      const closed = await fixture.cashier.sessions.close(close);

      expect(closed).toEqual({
        sessionId: till.sessionId,
        status: 'created',
        zReport: {
          sessionId: till.sessionId,
          openingFloatMillimes: 20_000,
          salesCount: 1,
          refundsCount: 0,
          grossMillimes: 3_000,
          refundsMillimes: 0,
          netMillimes: 3_000,
          byMethod: {
            cash: { salesMillimes: 3_000, refundsMillimes: 0, netMillimes: 3_000 },
            card: NOTHING,
          },
          expectedCashMillimes: 23_000,
          countedCashMillimes: 22_500,
          varianceMillimes: -500,
          voidsCount: 0,
        },
      });
      await expect(fixture.cashier.sessions.current(till.terminalId)).resolves.toBeNull();
      await expect(fixture.admin.sessions.zReport(till.sessionId)).resolves.toEqual(closed.zReport);

      // A sale that reaches the closed session is refused, and an admin voids its number. The void
      // names the session, yet the report stored at close time stays as it was.
      const late = await saleRecord(till, 2, cartOf([[product, 1]]), { method: 'card' });
      await failure(fixture.cashier.sales.recordSale(late), 'SESSION_CLOSED');
      await expect(
        fixture.admin.sales.voidReceipt({
          record: late,
          errorCode: 'SESSION_CLOSED',
          reason: 'Sold after the session was closed',
        }),
      ).resolves.toMatchObject({ status: 'voided' });

      await expect(fixture.cashier.sessions.close(close)).resolves.toEqual({
        ...closed,
        status: 'replayed',
      });
      await expect(fixture.cashier.sessions.zReport(till.sessionId)).resolves.toEqual(
        closed.zReport,
      );
    });

    it('refuses a second close with SESSION_CLOSED and another payload under a close id with IDEMPOTENCY_CONFLICT', async () => {
      const till = await openTill(fixture);
      const close = await closeRecord(
        till.terminal,
        till.sessionId,
        fixture.cashierUser.id,
        mm(20_000),
      );
      await fixture.cashier.sessions.close(close);

      const again = await failure(
        fixture.cashier.sessions.close(
          await closeRecord(till.terminal, till.sessionId, fixture.cashierUser.id, mm(20_000)),
        ),
        'SESSION_CLOSED',
      );
      expect(again.details).toMatchObject({ sessionId: till.sessionId });

      const conflicting = await closeRecord(
        till.terminal,
        till.sessionId,
        fixture.cashierUser.id,
        mm(19_000),
        { id: close.id },
      );
      const conflict = await failure(
        fixture.cashier.sessions.close(conflicting),
        'IDEMPOTENCY_CONFLICT',
      );
      expect(conflict.details).toMatchObject({ id: close.id });

      // The terminal goes on to its next session.
      await expect(
        fixture.cashier.sessions.open(
          await openRecord(till.terminal, fixture.cashierUser.id, mm(20_000)),
        ),
      ).resolves.toMatchObject({ status: 'created' });
    });

    it('closes only a known session of the closing terminal, for an actor of the shop', async () => {
      const till = await openTill(fixture);
      const other = await registerTerminal(fixture);

      const foreign = await failure(
        fixture.cashier.sessions.close(
          await closeRecord(other.terminal, till.sessionId, fixture.cashierUser.id, mm(0)),
        ),
        'FORBIDDEN',
      );
      expect(foreign.details).toMatchObject({ sessionId: till.sessionId });

      const unknown = newId();
      const missing = await failure(
        fixture.cashier.sessions.close(
          await closeRecord(till.terminal, unknown, fixture.cashierUser.id, mm(0)),
        ),
        'NOT_FOUND',
      );
      expect(missing.details).toMatchObject({ sessionId: unknown });

      const stranger = newId();
      const outsider = await failure(
        fixture.cashier.sessions.close(
          await closeRecord(till.terminal, till.sessionId, stranger, mm(0)),
        ),
        'FORBIDDEN',
      );
      expect(outsider.details).toMatchObject({ actorUserId: stranger });

      await expect(fixture.cashier.sessions.current(till.terminalId)).resolves.toMatchObject({
        id: till.sessionId,
        closedAt: null,
      });
    });

    it('refuses opens and closes of a superseded registration, checking the epoch before the session, while replays still answer', async () => {
      const { terminal } = await registerTerminal(fixture);
      const open = await openRecord(terminal, fixture.cashierUser.id, mm(10_000));
      await fixture.cashier.sessions.open(open);

      const registration = await fixture.admin.terminals.register(terminal.terminalCode);
      expect(registration.epoch).toBe(terminal.epoch + 1);

      await expect(fixture.cashier.sessions.open(open)).resolves.toMatchObject({
        status: 'replayed',
      });
      const superseded = await failure(
        fixture.cashier.sessions.open(await openRecord(terminal, fixture.cashierUser.id, mm(0))),
        'TERMINAL_SUPERSEDED',
      );
      expect(superseded.details).toMatchObject({
        terminalCode: terminal.terminalCode,
        currentEpoch: registration.epoch,
      });
      await failure(
        fixture.cashier.sessions.close(
          await closeRecord(terminal, open.id, fixture.cashierUser.id, mm(10_000)),
        ),
        'TERMINAL_SUPERSEDED',
      );
      await failure(
        fixture.cashier.sessions.close(
          await closeRecord(terminal, newId(), fixture.cashierUser.id, mm(10_000)),
        ),
        'TERMINAL_SUPERSEDED',
      );

      // The device registered now closes the session it took over.
      const close = await closeRecord(
        contextOf(registration),
        open.id,
        fixture.cashierUser.id,
        mm(10_000),
      );
      await expect(fixture.cashier.sessions.close(close)).resolves.toMatchObject({
        status: 'created',
      });
      await fixture.admin.terminals.register(terminal.terminalCode);
      await expect(fixture.cashier.sessions.close(close)).resolves.toMatchObject({
        status: 'replayed',
      });
    });
  });
}
