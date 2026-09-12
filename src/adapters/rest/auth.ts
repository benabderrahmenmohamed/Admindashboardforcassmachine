import { z } from 'zod';
import { errorClass, toAppError } from '@/lib/errors';
import { parseOrInvalid } from '@/lib/validation';
import {
  credentialsSchema,
  roleSchema,
  type AuthPort,
  type AuthState,
  type AuthUser,
} from '@/ports';
import type { RestClient } from './http';
import type { RestSessionStore } from './session';
import { fromWire, toWire, type WireCredentials } from './wire';

/**
 * A Member (`GET /api/v1/me`) read as the AuthUser the ports use: the shop and the role come from
 * the membership the API answers with, never from anything in the token.
 */
const memberSchema = z
  .object({
    userId: z.string().min(1),
    shopId: z.string().min(1),
    roles: z.array(roleSchema).min(1),
    displayName: z.string(),
    email: z.string(),
  })
  .transform((member): AuthUser => ({
    id: member.userId,
    email: member.email,
    name: member.displayName,
    roles: member.roles,
    shopId: member.shopId,
  }));

/** The answer of `POST /api/v1/auth/token`. Everything it promises is checked, used or not. */
const tokenSchema = z.object({
  accessToken: z.string().min(1),
  tokenType: z
    .string()
    .refine((value) => value.toLowerCase() === 'bearer', 'The app can only send a bearer token'),
  expiresIn: z.number().int(),
  member: memberSchema,
});

export interface RestAuthDeps {
  readonly client: RestClient;
  /** Where this device keeps the token and the member it belongs to. */
  readonly session: RestSessionStore;
}

/**
 * AuthPort over `POST /auth/token` and `GET /me`. The token is this device's session: it is stored
 * here, sent by every other request, and dropped on sign-out. While the API cannot be reached the
 * state is `offline` rather than anonymous, so the register keeps selling on a session it already
 * has and sends nothing until the API answers again (contracts/errors.md, class `retriable`).
 */
export function createRestAuth(deps: RestAuthDeps): AuthPort {
  const { client, session } = deps;
  // One entry per subscription, so subscribing the same function twice needs two unsubscribes.
  const subscriptions = new Set<{ readonly listener: (state: AuthState) => void }>();

  function notify(state: AuthState): void {
    for (const subscription of [...subscriptions]) {
      try {
        subscription.listener(state);
      } catch (error) {
        // One broken listener must not stop the others or fail the call that triggered it.
        console.error('An auth state listener threw', error);
      }
    }
  }

  return {
    async getState() {
      const stored = session.read();
      if (!stored) {
        return { status: 'anonymous' };
      }
      try {
        const response = await client.request('GET', '/me');
        const user = fromWire(memberSchema, response.body, 'the signed-in member');
        session.write({ accessToken: stored.accessToken, user });
        return { status: 'authenticated', user };
      } catch (error) {
        const failure = toAppError(error);
        if (errorClass(failure.code) === 'retriable') {
          console.warn(
            'The API cannot be reached; continuing offline as the last signed-in member',
            failure,
          );
          return { status: 'offline', user: stored.user };
        }
        // The token is gone, the membership is gone, or the answer cannot be read: either way this
        // device has no session it could use, and keeping the token would only repeat the failure.
        console.warn('The stored session was refused; signing out on this device', failure);
        session.clear();
        notify({ status: 'anonymous' });
        return { status: 'anonymous' };
      }
    },

    async signIn(credentials) {
      const input = parseOrInvalid(credentialsSchema, credentials, 'the credentials');
      // The one request that goes out without a token; a refusal arrives as UNAUTHENTICATED (401).
      const response = await client.request('POST', '/auth/token', {
        auth: false,
        body: toWire<WireCredentials>(input),
      });
      const token = fromWire(tokenSchema, response.body, 'the sign-in answer');
      session.write({ accessToken: token.accessToken, user: token.member });
      notify({ status: 'authenticated', user: token.member });
      return token.member;
    },

    signOut(): Promise<void> {
      // The contract has no revoke: a bearer token ends by being dropped here, which ends the
      // session on this device only and leaves other devices signed in, as the port asks.
      session.clear();
      notify({ status: 'anonymous' });
      return Promise.resolve();
    },

    onStateChange(listener) {
      const subscription = { listener };
      subscriptions.add(subscription);
      return () => {
        subscriptions.delete(subscription);
      };
    },
  };
}
