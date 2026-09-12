/**
 * The menu, as a waiter and the admin both read it.
 *
 * `available` is the daily "on the menu right now / sold out" toggle, and it is the only thing that
 * keeps an item off a waiter's picker: stock never blocks an order at a café, because most items
 * are not tracked at all and a sale is allowed to take stock negative.
 */
import type { Category, Product } from '@/ports';

/** What a waiter may put on a table right now. */
export function availableProducts(products: readonly Product[]): Product[] {
  return products.filter((product) => product.isAvailable);
}

/**
 * Products whose name contains `searchTerm`, ignoring case, in the category `categoryId`, or in any
 * category when it is null. Keeps the catalog order.
 */
export function filterProducts(
  products: readonly Product[],
  searchTerm: string,
  categoryId: string | null,
): Product[] {
  const needle = searchTerm.trim().toLowerCase();
  return products.filter(
    (product) =>
      product.name.toLowerCase().includes(needle) &&
      (categoryId === null || product.categoryId === categoryId),
  );
}

export interface MenuSection {
  readonly categoryId: string | null;
  readonly categoryName: string;
  readonly products: readonly Product[];
}

/**
 * The menu in the admin's category order, with anything uncategorised last. Empty categories are
 * left out, so a café that has not filled one in does not show a heading with nothing under it.
 */
export function menuSections(
  products: readonly Product[],
  categories: readonly Category[],
): MenuSection[] {
  const sections = categories.map((category): MenuSection => ({
    categoryId: category.id,
    categoryName: category.name,
    products: products.filter((product) => product.categoryId === category.id),
  }));
  const known = new Set(categories.map((category) => category.id));
  const loose = products.filter(
    (product) => product.categoryId === null || !known.has(product.categoryId),
  );
  if (loose.length > 0) {
    sections.push({ categoryId: null, categoryName: 'Other', products: loose });
  }
  return sections.filter((section) => section.products.length > 0);
}

/** How many of the menu are sold out right now, for the admin's heading. */
export function soldOutCount(products: readonly Product[]): number {
  return products.filter((product) => !product.isAvailable).length;
}
