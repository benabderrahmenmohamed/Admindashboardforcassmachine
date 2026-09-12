import { z } from 'zod';
import { authUserSchema } from '@/ports';

/** The part of `Storage` this adapter uses, so tests can pass a store of their own. */
export type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/** Where the bearer token and the member it belongs to live between reloads. */
export const REST_SESSION_STORAGE_KEY = 'pos.rest.session';

const storedSessionSchema = z.object({
  accessToken: z.string().min(1),
  /** The member as `GET /api/v1/me` last answered: what the register shows while it is offline. */
  user: authUserSchema,
});

export type RestSession = z.infer<typeof storedSessionSchema>;

export interface RestSessionStore {
  /** The stored session, or null when there is none or it cannot be read. */
  read(): RestSession | null;
  write(session: RestSession): void;
  clear(): void;
}

/**
 * The session of one device. A session that cannot be read (no storage, not JSON, an older shape)
 * is reported and treated as absent: nothing could be done with it either way, and a register that
 * refuses to start is worse than one that asks for a sign-in.
 */
export function createSessionStore(
  storage: () => StorageLike,
  key = REST_SESSION_STORAGE_KEY,
): RestSessionStore {
  return {
    read() {
      let raw: string | null;
      try {
        raw = storage().getItem(key);
      } catch (error) {
        console.warn('Could not read the stored session', error);
        return null;
      }
      if (!raw) {
        return null;
      }
      let value: unknown;
      try {
        value = JSON.parse(raw) as unknown;
      } catch (error) {
        console.warn('Ignoring the stored session: it is not JSON', error);
        return null;
      }
      const parsed = storedSessionSchema.safeParse(value);
      if (!parsed.success) {
        console.warn('Ignoring the stored session: it has an unexpected shape', parsed.error);
        return null;
      }
      return parsed.data;
    },

    write(session) {
      try {
        storage().setItem(key, JSON.stringify(session));
      } catch (error) {
        // The session still works in this tab; only a reload will ask for a sign-in again.
        console.warn('Could not store the session on this device', error);
      }
    },

    clear() {
      try {
        storage().removeItem(key);
      } catch (error) {
        console.warn('Could not remove the stored session', error);
      }
    },
  };
}
