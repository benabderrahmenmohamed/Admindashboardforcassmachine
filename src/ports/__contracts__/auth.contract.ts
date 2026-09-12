import { beforeEach, describe, expect, it } from 'vitest';
import type { ContractFixture, MakeFixture } from './fixture';

/** Who a signed-in user is: the role and shop of their shop membership. */
export function describeAuthPortContract(makeFixture: MakeFixture): void {
  describe('AuthPort contract', () => {
    let fixture: ContractFixture;

    beforeEach(async () => {
      fixture = await makeFixture();
    });

    it('signs members in with the role and the shop of their membership', async () => {
      expect(fixture.adminUser.role).toBe('admin');
      expect(fixture.cashierUser.role).toBe('cashier');
      expect(fixture.adminUser.shopId).not.toBe('');
      expect(fixture.cashierUser.shopId).toBe(fixture.adminUser.shopId);
      expect(fixture.cashierUser.id).not.toBe(fixture.adminUser.id);

      await expect(fixture.admin.auth.getState()).resolves.toEqual({
        status: 'authenticated',
        user: fixture.adminUser,
      });
      await expect(fixture.cashier.auth.getState()).resolves.toEqual({
        status: 'authenticated',
        user: fixture.cashierUser,
      });
    });
  });
}
