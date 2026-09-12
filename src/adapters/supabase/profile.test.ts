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
      role: 'cashier',
      shopId: 'shop-1',
    });
    expect(calls).toHaveLength(1);
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
    const { client } = fakeSupabase(() => json({ ...profileJson('admin'), role: 'owner' }));

    const error = await failureOf(readMyProfile(client));

    expect(error.code).toBe('VALIDATION_ERROR');
  });
});

describe('requireAdmin', () => {
  it('resolves with an admin', async () => {
    const { client } = fakeSupabase(() => json(profileJson('admin')));

    await expect(requireAdmin(client)).resolves.toMatchObject({ role: 'admin', shopId: 'shop-1' });
  });

  it('refuses a cashier with FORBIDDEN', async () => {
    const { client } = fakeSupabase(() => json(profileJson('cashier')));

    const error = await failureOf(requireAdmin(client));

    expect(error).toMatchObject({ code: 'FORBIDDEN', details: { role: 'cashier' } });
  });
});
