import { z } from 'zod';
import { AppError } from '@/lib/errors';
import type { Millimes } from '@/lib/money';
import {
  priceMillimesSchema,
  roleSchema,
  shopSettingsSchema,
  type PaymentMethod,
  type RecordKind,
  type SaleLine,
  type SaleRecord,
  type ShopSettings,
  type ZReport,
} from '@/ports';
import type { MemoryAccount, MemoryProfile, MemorySeed } from './seed';
import { UUID_PATTERN } from './support';

/*
 * One row type per database table the ports reach. Rows are replaced, never mutated, and the maps
 * keep insertion order, which is the order lists return.
 */

export interface CategoryRow {
  readonly id: string;
  readonly shopId: string;
  readonly name: string;
  readonly color: string;
  readonly createdAt: string;
}

export interface ProductRow {
  readonly id: string;
  readonly shopId: string;
  readonly categoryId: string | null;
  readonly name: string;
  readonly priceMillimes: Millimes;
  /** '' when the product has none. */
  readonly barcode: string;
  readonly description: string;
  readonly imageUrl: string;
  /** Always the sum of the product's stock movements; may be negative. */
  readonly stock: number;
  readonly available: boolean;
  /** Archived products leave the catalog but stay recordable and refundable. */
  readonly archivedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type StockMovementReason = 'opening' | 'adjustment' | 'sale' | 'refund';

export interface MemoryStockMovement {
  readonly id: number;
  readonly shopId: string;
  readonly productId: string;
  readonly delta: number;
  readonly reason: StockMovementReason;
  readonly saleId: string | null;
  readonly note: string;
  readonly createdBy: string | null;
  readonly createdAt: string;
}

export interface MemoryTerminal {
  readonly id: string;
  readonly shopId: string;
  readonly code: string;
  /** The last receipt number used, across sales, refunds and voided receipts. */
  readonly lastSeq: number;
  /** Bumped by every registration: records written under an older one are refused. */
  readonly epoch: number;
  readonly createdAt: string;
}

export interface SessionRow {
  readonly id: string;
  readonly shopId: string;
  readonly terminalId: string;
  /** Who opened it on the terminal; `openSubmittedBy` is who sent the record. */
  readonly openedBy: string;
  readonly openSubmittedBy: string;
  readonly openedAt: string;
  readonly openReceivedAt: string;
  readonly openingFloatMillimes: Millimes;
  readonly openPayloadHash: string;
  readonly closeRequestId: string | null;
  readonly closedAt: string | null;
  readonly closedBy: string | null;
  readonly closeSubmittedBy: string | null;
  readonly closeReceivedAt: string | null;
  readonly closingCountedMillimes: Millimes | null;
  readonly closePayloadHash: string | null;
  /** The report computed when the session closed; a replayed close returns it. */
  readonly serverZReport: ZReport | null;
  readonly clientZReport: ZReport | null;
}

export interface SaleRow {
  readonly id: string;
  readonly shopId: string;
  readonly terminalId: string;
  readonly sessionId: string;
  readonly kind: RecordKind;
  readonly seq: number;
  readonly receiptNumber: string;
  readonly refundsSaleId: string | null;
  readonly paymentMethod: PaymentMethod;
  readonly subtotalMillimes: Millimes;
  readonly discountMillimes: Millimes;
  readonly totalMillimes: Millimes;
  readonly tenderedMillimes: Millimes;
  readonly changeMillimes: Millimes;
  readonly epoch: number;
  readonly payloadHash: string;
  readonly submittedBy: string;
  /** Written by the device and trusted for nothing; `receivedAt` is the backend's clock. */
  readonly createdAt: string;
  readonly receivedAt: string;
  readonly lines: readonly SaleLine[];
}

export interface MemoryReceiptVoid {
  readonly id: string;
  readonly shopId: string;
  readonly terminalId: string;
  readonly sessionId: string | null;
  readonly seq: number;
  readonly receiptNumber: string;
  readonly payload: SaleRecord;
  readonly payloadHash: string;
  readonly errorCode: string;
  readonly reason: string;
  readonly voidedBy: string;
  readonly voidedAt: string;
}

/** The data behind one memory backend, shared by all of its clients. */
export interface MemoryStore {
  /** In seed order, the order the login page offers demo accounts in. */
  readonly accounts: readonly MemoryAccount[];
  /** By user id. */
  readonly profiles: ReadonlyMap<string, MemoryProfile>;
  /** By shop id. */
  readonly settings: Map<string, ShopSettings>;
  readonly categories: Map<string, CategoryRow>;
  readonly products: Map<string, ProductRow>;
  /** Append-only. */
  readonly stockMovements: MemoryStockMovement[];
  readonly terminals: Map<string, MemoryTerminal>;
  readonly sessions: Map<string, SessionRow>;
  readonly sales: Map<string, SaleRow>;
  readonly receiptVoids: Map<string, MemoryReceiptVoid>;
}

/**
 * The only writer of a product's stock, as private.move_stock: appends a movement, applies its
 * delta and returns the product as it is afterwards. A zero delta writes nothing.
 */
export function moveStock(
  store: MemoryStore,
  movement: Omit<MemoryStockMovement, 'id'>,
): ProductRow {
  const product = store.products.get(movement.productId);
  if (!product) {
    throw new AppError(
      'UNKNOWN',
      `Stock moved for a product that does not exist: ${movement.productId}`,
    );
  }
  if (movement.delta === 0) {
    return product;
  }
  const moved = { ...product, stock: product.stock + movement.delta };
  store.stockMovements.push({ ...movement, id: store.stockMovements.length + 1 });
  store.products.set(product.id, moved);
  return moved;
}

const uuidSchema = z.string().regex(UUID_PATTERN, 'Expected a lowercase UUID');

const seedSchema = z.object({
  shops: z.array(
    z.object({ id: uuidSchema, name: z.string().trim().min(1), settings: shopSettingsSchema }),
  ),
  accounts: z.array(
    z.object({
      id: uuidSchema,
      email: z.string().trim().min(1),
      password: z.string().min(1),
      demoLabel: z.string().min(1).nullable(),
    }),
  ),
  profiles: z.array(
    z.object({ userId: uuidSchema, shopId: uuidSchema, role: roleSchema, displayName: z.string() }),
  ),
  categories: z.array(
    z.object({
      id: uuidSchema,
      shopId: uuidSchema,
      name: z.string().trim().min(1),
      color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
      createdAt: z.string().min(1),
    }),
  ),
  products: z.array(
    z.object({
      id: uuidSchema,
      shopId: uuidSchema,
      categoryId: uuidSchema.nullable(),
      name: z.string().trim().min(1),
      priceMillimes: priceMillimesSchema,
      barcode: z.string().trim(),
      description: z.string(),
      imageUrl: z.string(),
      stock: z.number().int(),
      available: z.boolean(),
      createdAt: z.string().min(1),
    }),
  ),
});

function seedError(message: string): AppError {
  return new AppError('CONFIG_ERROR', `The memory seed ${message}`);
}

function assertUnique<T>(items: readonly T[], key: (item: T) => string, what: string): void {
  const seen = new Set<string>();
  for (const item of items) {
    const value = key(item);
    if (seen.has(value)) {
      throw seedError(`repeats the ${what} "${value}"`);
    }
    seen.add(value);
  }
}

/**
 * Builds a store from a seed. Parsing checks the seed against the port schemas and copies it, so
 * the store never shares an object with the seed; references between rows are checked like the
 * database's foreign keys. Seeded stock is written as 'opening' movements.
 */
export function createStore(seed: MemorySeed): MemoryStore {
  const result = seedSchema.safeParse(seed);
  if (!result.success) {
    throw new AppError('CONFIG_ERROR', 'The memory seed does not match the port schemas', {
      details: { issues: result.error.issues },
    });
  }
  const { shops, accounts, profiles, categories, products } = result.data;

  assertUnique(shops, (shop) => shop.id, 'shop id');
  assertUnique(accounts, (account) => account.id, 'account id');
  assertUnique(accounts, (account) => account.email.toLowerCase(), 'account email');
  assertUnique(profiles, (profile) => profile.userId, 'profile of user');
  assertUnique(categories, (category) => category.id, 'category id');
  assertUnique(products, (product) => product.id, 'product id');
  assertUnique(
    products.filter((product) => product.barcode !== ''),
    (product) => `${product.barcode} in shop ${product.shopId}`,
    'barcode',
  );

  const shopIds = new Set(shops.map((shop) => shop.id));
  const accountIds = new Set(accounts.map((account) => account.id));
  for (const profile of profiles) {
    if (!accountIds.has(profile.userId) || !shopIds.has(profile.shopId)) {
      throw seedError(`has a profile for a missing account or shop: user ${profile.userId}`);
    }
  }
  for (const category of categories) {
    if (!shopIds.has(category.shopId)) {
      throw seedError(`has category ${category.id} in a missing shop`);
    }
  }
  for (const product of products) {
    const shelf = categories.find((category) => category.id === product.categoryId);
    if (
      !shopIds.has(product.shopId) ||
      (product.categoryId !== null && shelf?.shopId !== product.shopId)
    ) {
      throw seedError(`has product ${product.id} in a missing shop or another shop's category`);
    }
  }

  const store: MemoryStore = {
    accounts,
    profiles: new Map(profiles.map((profile) => [profile.userId, profile])),
    settings: new Map(shops.map((shop) => [shop.id, shop.settings])),
    categories: new Map(categories.map((category) => [category.id, category])),
    products: new Map(),
    stockMovements: [],
    terminals: new Map(),
    sessions: new Map(),
    sales: new Map(),
    receiptVoids: new Map(),
  };
  for (const { stock, ...product } of products) {
    store.products.set(product.id, {
      ...product,
      stock: 0,
      archivedAt: null,
      updatedAt: product.createdAt,
    });
    moveStock(store, {
      shopId: product.shopId,
      productId: product.id,
      delta: stock,
      reason: 'opening',
      saleId: null,
      note: 'Seed data',
      createdBy: null,
      createdAt: product.createdAt,
    });
  }
  return store;
}
