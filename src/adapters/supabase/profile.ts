import { z } from 'zod';
import { AppError } from '@/lib/errors';
import { authUserSchema, roleSchema, type AuthUser } from '@/ports';
import type { SupabaseDatabaseClient } from './client';
import { defaultErrorMessage, unwrap } from './errors';
import { fromWire } from './wire';
import { parseOutput } from './validate';

const myProfileSchema = z.object({
  userId: z.string().min(1),
  shopId: z.string().min(1),
  role: roleSchema,
  displayName: z.string(),
  email: z.string(),
});

/**
 * The signed-in user as a member of their shop, from `my_profile()`: nobody signed in is
 * UNAUTHENTICATED, a user without a profile FORBIDDEN. Token metadata is never read.
 */
export async function readMyProfile(client: SupabaseDatabaseClient): Promise<AuthUser> {
  const profile = fromWire(myProfileSchema, await unwrap(client.rpc('my_profile')), 'a profile');
  return parseOutput(
    authUserSchema,
    {
      id: profile.userId,
      email: profile.email,
      name: profile.displayName,
      role: profile.role,
      shopId: profile.shopId,
    },
    'a profile',
  );
}

/**
 * The signed-in admin, or FORBIDDEN for anyone else. Row-level security refuses a cashier's update or
 * delete by changing no rows, without an error, so writes that rely on it ask first.
 */
export async function requireAdmin(client: SupabaseDatabaseClient): Promise<AuthUser> {
  const member = await readMyProfile(client);
  if (member.role !== 'admin') {
    throw new AppError('FORBIDDEN', defaultErrorMessage('FORBIDDEN'), {
      details: { role: member.role },
    });
  }
  return member;
}
