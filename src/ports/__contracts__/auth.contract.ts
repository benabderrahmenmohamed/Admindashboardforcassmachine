import { beforeEach, describe, expect, it } from 'vitest';
import { hasRole } from '@/ports';
import type { ContractFixture, MakeFixture } from './fixture';

/** Who a signed-in user is: the roles and shop of their shop membership. */
export function describeAuthPortContract(makeFixture: MakeFixture): void {
  describe('AuthPort contract', () => {
    let fixture: ContractFixture;

    beforeEach(async () => {
      fixture = await makeFixture();
    });

    it('signs members in with the roles and the shop of their membership', async () => {
      const members = [
        fixture.adminUser,
        fixture.cashierUser,
        fixture.waiterUser,
        fixture.kitchenUser,
      ];
      expect(hasRole(fixture.adminUser, ['admin'])).toBe(true);
      expect(hasRole(fixture.cashierUser, ['cashier'])).toBe(true);
      expect(hasRole(fixture.waiterUser, ['waiter'])).toBe(true);
      expect(hasRole(fixture.kitchenUser, ['kitchen'])).toBe(true);
      // Each of the four is one person of one shop, so a refusal names one role and not a mix.
      expect(new Set(members.map((member) => member.id)).size).toBe(members.length);
      for (const member of members) {
        expect(member.roles.length).toBeGreaterThan(0);
        expect(member.shopId).toBe(fixture.adminUser.shopId);
      }

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
