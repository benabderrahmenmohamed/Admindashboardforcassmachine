import { describe, expect, it } from 'vitest';
import { failureOf, fakeSupabase, json, profileJson, raised, routes } from './fakeSupabase';
import { readMyProfile, requireAdmin } from './profile';

describe('readMyProfile', () => {
  it('reads the membership from my_profile() into the signed-in user', async () => {
    const { client, calls } = fakeSupabase(
      routes({ 'POST /rest/v1/rpc/my_profile': () => json(profileJson('cashier')) }),
    );

    await expect(readMyProfile(client)).resolves.toEqual({
      id: 'user-cashier',
      email: 'cashier@demo.local',
      name: 'Karim',
      roles: ['cashier'],
      shopId: 'shop-1',
    });
    expect(calls).toHaveLength(1);
  });

  it('keeps every role of a member who holds several', async () => {
    const { client } = fakeSupabase(() => json(profileJson('admin', 'cashier')));

    await expect(readMyProfile(client)).resolves.toMatchObject({ roles: ['admin', 'cashier'] });
  });

  it('passes FORBIDDEN on for a user without a profile', async () => {
    const { client } = fakeSupabase(() =>
      raised('FORBIDDEN', 403, {}, 'This account is not a member of any shop.'),
    );

    const error = await failureOf(readMyProfile(client));

    expect(error).toMatchObject({
      code: 'FORBIDDEN',
      message: 'This account is not a member of any shop.',
    });
  });

  it('refuses a profile with a role the app does not know as unreadable', async () => {
    const { client } = fakeSupabase(() => json({ ...profileJson('admin'), roles: ['owner'] }));

    const error = await failureOf(readMyProfile(client));

    expect(error.code).toBe('VALIDATION_ERROR');
  });

  it('refuses a profile whose roles are not an array as unreadable', async () => {
    const { client } = fakeSupabase(() => json({ ...profileJson('admin'), roles: 'admin' }));

    const error = await failureOf(readMyProfile(client));

    expect(error.code).toBe('VALIDATION_ERROR');
  });
});

describe('requireAdmin', () => {
  it('resolves with an admin', async () => {
    const { client } = fakeSupabase(() => json(profileJson('admin')));

    await expect(requireAdmin(client)).resolves.toMatchObject({
      roles: ['admin'],
      shopId: 'shop-1',
    });
  });

  it('resolves with a cashier who is also an admin', async () => {
    const { client } = fakeSupabase(() => json(profileJson('cashier', 'admin')));

    await expect(requireAdmin(client)).resolves.toMatchObject({ roles: ['cashier', 'admin'] });
  });

  it.each(['cashier', 'waiter', 'kitchen'] as const)(
    'refuses a %s with FORBIDDEN',
    async (role) => {
      const { client } = fakeSupabase(() => json(profileJson(role)));

      const error = await failureOf(requireAdmin(client));

      expect(error).toMatchObject({ code: 'FORBIDDEN', details: { roles: [role] } });
    },
  );
});
