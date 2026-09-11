import { z } from 'zod';
import { AppError } from '@/lib/errors';
import type { Millimes } from '@/lib/money';
import {
  categorySchema,
  productSchema,
  roleSchema,
  shopSettingsSchema,
  type AuthState,
  type Category,
  type PaymentMethod,
  type Product,
  type SaleLineInput,
  type ShopSettings,
} from '@/ports';
import type { MemoryAccount, MemorySeed } from './seed';

/** An auth state of the memory backend, which has no network and so is never offline. */
export type MemorySession = Exclude<AuthState, { readonly status: 'offline' }>;

/** A recorded sale. No port reads sales yet; tests see them through `inspect`. */
export interface MemorySale {
  readonly id: string;
  readonly lines: SaleLineInput[];
  readonly paymentMethod: PaymentMethod;
  readonly createdAt: string;
  readonly totalMillimes: Millimes;
}

/** The mutable state behind one memory backend. Maps keep insertion order, which lists return. */
export interface MemoryStore {
  readonly accounts: readonly MemoryAccount[];
  /** Who is signed in: what auth.getState reports and what `authorize` checks calls against. */
  session: MemorySession;
  readonly categories: Map<string, Category>;
  readonly products: Map<string, Product>;
  settings: ShopSettings;
  readonly sales: Map<string, MemorySale>;
}

const seedSchema = z.object({
  accounts: z.array(
    z.object({
      id: z.string().min(1),
      label: z.string().min(1),
      email: z.string().min(1),
      password: z.string().min(1),
      name: z.string(),
      role: roleSchema,
    }),
  ),
  categories: z.array(categorySchema),
  products: z.array(productSchema),
  settings: shopSettingsSchema,
});

function byId<T extends { readonly id: string }>(
  items: readonly T[],
  what: string,
): Map<string, T> {
  const map = new Map<string, T>();
  for (const item of items) {
    if (map.has(item.id)) {
      throw new AppError('CONFIG_ERROR', `The memory seed repeats the ${what} id "${item.id}"`);
    }
    map.set(item.id, item);
  }
  return map;
}

/**
 * Builds a store from a seed, with nobody signed in. Parsing checks the seed against the port
 * schemas and copies it, so the store never shares an object with the seed.
 */
export function createStore(seed: MemorySeed): MemoryStore {
  const result = seedSchema.safeParse(seed);
  if (!result.success) {
    throw new AppError('CONFIG_ERROR', 'The memory seed does not match the port schemas', {
      details: { issues: result.error.issues },
    });
  }
  const { accounts, categories, products, settings } = result.data;
  byId(accounts, 'account');
  return {
    accounts,
    session: { status: 'anonymous' },
    categories: byId(categories, 'category'),
    products: byId(products, 'product'),
    settings,
    sales: new Map(),
  };
}
