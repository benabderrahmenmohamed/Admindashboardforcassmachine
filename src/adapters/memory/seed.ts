import { mm, type Millimes } from '@/lib/money';
import type { Category, Product, Role, ShopSettings } from '@/ports';

/** A sign-in the memory backend accepts. The label, email and password are offered as a demo. */
export interface MemoryAccount {
  readonly id: string;
  readonly label: string;
  readonly email: string;
  readonly password: string;
  readonly name: string;
  readonly role: Role;
}

/** The whole starting state of a memory backend. */
export interface MemorySeed {
  readonly accounts: readonly MemoryAccount[];
  readonly categories: readonly Category[];
  /** In list order. */
  readonly products: readonly Product[];
  readonly settings: ShopSettings;
}

const SEEDED_AT = '2026-01-05T08:00:00.000Z';

function category(id: string, name: string, color: string): Category {
  return { id, name, color, createdAt: SEEDED_AT };
}

const epicerie = category('cat-epicerie', 'Épicerie', '#f59e0b');
const boissons = category('cat-boissons', 'Boissons', '#3b82f6');
const laitiers = category('cat-laitiers', 'Produits laitiers', '#14b8a6');
const boulangerie = category('cat-boulangerie', 'Boulangerie', '#ef4444');

function product(fields: {
  id: string;
  name: string;
  price: Millimes;
  category: Category;
  barcode?: string;
  description?: string;
  stock: number;
}): Product {
  return {
    id: fields.id,
    name: fields.name,
    priceMillimes: fields.price,
    categoryId: fields.category.id,
    categoryName: fields.category.name,
    barcode: fields.barcode ?? '',
    description: fields.description ?? '',
    imageUrl: '',
    stock: fields.stock,
    // As if the stock had run out through sales, which is when the legacy backend clears it.
    available: fields.stock > 0,
    createdAt: SEEDED_AT,
    updatedAt: SEEDED_AT,
  };
}

/** A small Tunisian grocery: one admin, one cashier, 4 categories and 12 products. */
export const defaultSeed: MemorySeed = {
  accounts: [
    {
      id: 'user-admin',
      label: 'Admin',
      email: 'admin@demo.local',
      password: 'demo-admin-2026',
      name: 'Demo Admin',
      role: 'admin',
    },
    {
      id: 'user-cashier',
      label: 'Cashier',
      email: 'cashier@demo.local',
      password: 'demo-cashier-2026',
      name: 'Demo Cashier',
      role: 'cashier',
    },
  ],
  categories: [epicerie, boissons, laitiers, boulangerie],
  products: [
    product({
      id: 'prod-huile-olive',
      name: "Huile d'olive vierge extra 1 L",
      price: mm(18_500),
      category: epicerie,
      barcode: '6195001000013',
      description: 'Première pression à froid, Sfax',
      stock: 24,
    }),
    product({
      id: 'prod-harissa',
      name: 'Harissa 380 g',
      price: mm(2_400),
      category: epicerie,
      barcode: '6195001000020',
      stock: 40,
    }),
    product({
      id: 'prod-thon',
      name: "Thon à l'huile d'olive 160 g",
      price: mm(4_950),
      category: epicerie,
      barcode: '6195001000037',
      stock: 0,
    }),
    product({
      id: 'prod-eau',
      name: 'Eau minérale 1,5 L',
      price: mm(750),
      category: boissons,
      barcode: '6195002000012',
      stock: 120,
    }),
    product({
      id: 'prod-limonade',
      name: 'Limonade 1 L',
      price: mm(1_850),
      category: boissons,
      barcode: '6195002000029',
      stock: 48,
    }),
    product({
      id: 'prod-jus-orange',
      name: "Jus d'orange 1 L",
      price: mm(3_200),
      category: boissons,
      barcode: '6195002000036',
      description: '100 % pur jus',
      stock: 8,
    }),
    product({
      id: 'prod-lait',
      name: 'Lait demi-écrémé 1 L',
      price: mm(1_350),
      category: laitiers,
      barcode: '6195003000011',
      stock: 60,
    }),
    product({
      id: 'prod-yaourt',
      name: 'Yaourt nature 110 g',
      price: mm(450),
      category: laitiers,
      barcode: '6195003000028',
      stock: 72,
    }),
    product({
      id: 'prod-fromage',
      name: 'Fromage frais 200 g',
      price: mm(3_600),
      category: laitiers,
      barcode: '6195003000035',
      stock: 15,
    }),
    product({
      id: 'prod-baguette',
      name: 'Baguette',
      price: mm(190),
      category: boulangerie,
      description: 'Cuite le matin',
      stock: 150,
    }),
    product({
      id: 'prod-croissant',
      name: 'Croissant au beurre',
      price: mm(800),
      category: boulangerie,
      stock: 5,
    }),
    product({
      id: 'prod-pain-mie',
      name: 'Pain de mie 500 g',
      price: mm(2_100),
      category: boulangerie,
      barcode: '6195004000034',
      stock: 20,
    }),
  ],
  settings: { receiptFooter: 'Merci pour votre visite !' },
};
