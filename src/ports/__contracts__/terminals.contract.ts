import { beforeEach, describe, expect, it } from 'vitest';
import { mm } from '@/lib/money';
import type { ContractFixture, MakeFixture } from './fixture';
import { cartOf, createProduct, failure, openTill, recordCreated, saleRecord } from './support';

/** Registering a device as a terminal: the counter to adopt, the epoch and the open session. */
export function describeTerminalsPortContract(makeFixture: MakeFixture): void {
  describe('TerminalsPort contract', () => {
    let fixture: ContractFixture;

    beforeEach(async () => {
      fixture = await makeFixture();
    });

    it('registers a new terminal with an empty counter, the first epoch and no session', async () => {
      const code = fixture.newTerminalCode();

      const registration = await fixture.admin.terminals.register(` ${code.toLowerCase()} `);

      expect(registration).toMatchObject({ code, lastSeq: 0, epoch: 0, openSession: null });
      expect(registration.terminalId).not.toBe('');
    });

    it('bumps the epoch on every registration and hands over the counter and the open session', async () => {
      const product = await createProduct(fixture, 'water', 750);
      const till = await openTill(fixture, mm(15_000));
      const code = till.terminal.terminalCode;
      await recordCreated(fixture, await saleRecord(till, 1, cartOf([[product, 1]])));
      await recordCreated(
        fixture,
        await saleRecord(till, 2, cartOf([[product, 2]]), { method: 'card' }),
      );

      const again = await fixture.admin.terminals.register(code);

      expect(again).toMatchObject({ terminalId: till.terminalId, code, lastSeq: 2, epoch: 1 });
      expect(again.openSession).toMatchObject({
        id: till.sessionId,
        terminalId: till.terminalId,
        terminalCode: code,
        openedBy: fixture.cashierUser.id,
        openingFloatMillimes: 15_000,
        closedAt: null,
        zReport: null,
      });
      await expect(fixture.cashier.sessions.current(till.terminalId)).resolves.toEqual(
        again.openSession,
      );
      await expect(fixture.admin.terminals.register(code)).resolves.toMatchObject({
        terminalId: till.terminalId,
        lastSeq: 2,
        epoch: 2,
      });
    });

    it('lets only an admin register, and only a code of 1 to 8 letters or digits', async () => {
      const code = fixture.newTerminalCode();

      await failure(fixture.cashier.terminals.register(code), 'FORBIDDEN');
      for (const invalid of ['', 'T 1', 'T-1', 'ABCDEFGHI']) {
        await failure(fixture.admin.terminals.register(invalid), 'VALIDATION_ERROR');
      }

      // The refused call registered nothing: this is still the terminal's first registration.
      await expect(fixture.admin.terminals.register(code)).resolves.toMatchObject({
        code,
        lastSeq: 0,
        epoch: 0,
      });
    });
  });
}
