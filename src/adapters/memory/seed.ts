import { mm, type Millimes } from '@/lib/money';
import type { Category, Role, ShopSettings } from '@/ports';

/** A sign-in the memory backend accepts, as a row of auth.users. */
export interface MemoryAccount {
  readonly id: string;
  readonly email: string;
  readonly password: string;
  /** Offered on the login page as "Continue as <label>"; accounts without one are not offered. */
  readonly demoLabel: string | null;
}

/** Shop membership and role, as public.profiles. An account without one cannot sign in. */
export interface MemoryProfile {
  readonly userId: string;
  readonly shopId: string;
  readonly role: Role;
  readonly displayName: string;
}

export interface MemoryShop {
  readonly id: string;
  readonly name: string;
  readonly settings: ShopSettings;
}

export interface MemorySeedCategory extends Category {
  readonly shopId: string;
}

/** A product as seeded. `stock` is written as its opening stock movement. */
export interface MemorySeedProduct {
  readonly id: string;
  readonly shopId: string;
  readonly categoryId: string | null;
  readonly name: string;
  readonly priceMillimes: Millimes;
  readonly barcode: string;
  readonly description: string;
  readonly imageUrl: string;
  readonly stock: number;
  readonly available: boolean;
  readonly createdAt: string;
}

/**
 * The whole starting state of a memory backend. Every id is a UUID, as in the database. There are
 * no terminals, sessions or sales: an admin registers a terminal first.
 */
export interface MemorySeed {
  readonly shops: readonly MemoryShop[];
  readonly accounts: readonly MemoryAccount[];
  readonly profiles: readonly MemoryProfile[];
  readonly categories: readonly MemorySeedCategory[];
  /** In list order. */
  readonly products: readonly MemorySeedProduct[];
}

const SEEDED_AT = '2026-01-05T08:00:00.000Z';

export const DEMO_SHOP_ID = '11111111-1111-4111-8111-111111111111';
/** A second shop, so tests can show that one shop never sees or changes another's data. */
export const OTHER_SHOP_ID = '22222222-2222-4222-8222-222222222222';

function category(id: string, shopId: string, name: string, color: string): MemorySeedCategory {
  return { id, shopId, name, color, createdAt: SEEDED_AT };
}

const boissons = category(
  '44444444-4444-4444-8444-444444444401',
  DEMO_SHOP_ID,
  'Boissons',
  '#3b82f6',
);
const laitiers = category(
  '44444444-4444-4444-8444-444444444402',
  DEMO_SHOP_ID,
  'Produits laitiers',
  '#10b981',
);
const epicerie = category(
  '44444444-4444-4444-8444-444444444403',
  DEMO_SHOP_ID,
  'Épicerie',
  '#f59e0b',
);
const boulangerie = category(
  '44444444-4444-4444-8444-444444444404',
  DEMO_SHOP_ID,
  'Boulangerie',
  '#ef4444',
);
const general = category(
  '44444444-4444-4444-8444-444444444411',
  OTHER_SHOP_ID,
  'General',
  '#6366f1',
);

function product(
  id: string,
  shelf: MemorySeedCategory,
  name: string,
  price: Millimes,
  barcode: string,
  stock: number,
): MemorySeedProduct {
  return {
    id,
    shopId: shelf.shopId,
    categoryId: shelf.id,
    name,
    priceMillimes: price,
    barcode,
    description: '',
    imageUrl: '',
    stock,
    available: true,
    createdAt: SEEDED_AT,
  };
}

/**
 * The same shops, accounts, categories and products as supabase/seed.sql, so the credential-free
 * demo and the local stack show one shop. Unlike seed.sql it registers no terminal: an admin
 * registers this device in Settings before a cashier opens a session.
 */
export const defaultSeed: MemorySeed = {
  shops: [
    {
      id: DEMO_SHOP_ID,
      name: 'Épicerie du Coin',
      settings: { receiptFooter: 'Merci pour votre visite !' },
    },
    {
      id: OTHER_SHOP_ID,
      name: 'Other Shop',
      settings: { receiptFooter: 'Thank you for your purchase!' },
    },
  ],
  accounts: [
    {
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
      email: 'admin@demo.local',
      password: 'demo-admin-2026',
      demoLabel: 'Admin',
    },
    {
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2',
      email: 'cashier@demo.local',
      password: 'demo-cashier-2026',
      demoLabel: 'Cashier',
    },
    {
      id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1',
      email: 'other-admin@demo.local',
      password: 'other-admin-2026',
      demoLabel: null,
    },
    {
      id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2',
      email: 'other-cashier@demo.local',
      password: 'other-cashier-2026',
      demoLabel: null,
    },
  ],
  profiles: [
    {
      userId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
      shopId: DEMO_SHOP_ID,
      role: 'admin',
      displayName: 'Demo Admin',
    },
    {
      userId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2',
      shopId: DEMO_SHOP_ID,
      role: 'cashier',
      displayName: 'Demo Cashier',
    },
    {
      userId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1',
      shopId: OTHER_SHOP_ID,
      role: 'admin',
      displayName: 'Other Admin',
    },
    {
      userId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2',
      shopId: OTHER_SHOP_ID,
      role: 'cashier',
      displayName: 'Other Cashier',
    },
  ],
  categories: [boissons, laitiers, epicerie, boulangerie, general],
  products: [
    product(
      '55555555-5555-4555-8555-555555555501',
      boissons,
      'Eau minérale 1,5 L',
      mm(850),
      '6194000100015',
      120,
    ),
    product(
      '55555555-5555-4555-8555-555555555502',
      laitiers,
      'Lait demi-écrémé 1 L',
      mm(1_350),
      '6194000200012',
      60,
    ),
    product(
      '55555555-5555-4555-8555-555555555503',
      laitiers,
      'Yaourt nature x4',
      mm(1_900),
      '6194000200029',
      8,
    ),
    product(
      '55555555-5555-4555-8555-555555555504',
      epicerie,
      'Harissa 380 g',
      mm(2_450),
      '6194000300019',
      40,
    ),
    product(
      '55555555-5555-4555-8555-555555555505',
      epicerie,
      'Couscous moyen 1 kg',
      mm(2_100),
      '6194000300026',
      55,
    ),
    product(
      '55555555-5555-4555-8555-555555555506',
      epicerie,
      "Huile d'olive 1 L",
      mm(18_500),
      '6194000300033',
      25,
    ),
    product(
      '55555555-5555-4555-8555-555555555507',
      epicerie,
      'Dattes Deglet Nour 500 g',
      mm(7_800),
      '6194000300040',
      0,
    ),
    product(
      '55555555-5555-4555-8555-555555555508',
      epicerie,
      'Thé vert 250 g',
      mm(4_200),
      '6194000300057',
      30,
    ),
    product('55555555-5555-4555-8555-555555555509', boulangerie, 'Baguette', mm(200), '', 150),
    product('55555555-5555-4555-8555-555555555510', boulangerie, 'Tabouna', mm(450), '', 80),
    product(
      '55555555-5555-4555-8555-555555555511',
      boissons,
      "Jus d'orange 1 L",
      mm(3_950),
      '6194000100022',
      35,
    ),
    product(
      '55555555-5555-4555-8555-555555555512',
      epicerie,
      'Café moulu 250 g',
      mm(6_700),
      '6194000300064',
      20,
    ),
    product(
      '66666666-6666-4666-8666-666666666601',
      general,
      'Other product A',
      mm(1_000),
      '9990000000011',
      10,
    ),
    product(
      '66666666-6666-4666-8666-666666666602',
      general,
      'Other product B',
      mm(2_500),
      '9990000000028',
      10,
    ),
  ],
};
