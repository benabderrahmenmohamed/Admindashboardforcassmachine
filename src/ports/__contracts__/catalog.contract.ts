import { beforeEach, describe, expect, it } from 'vitest';
import { mm } from '@/lib/money';
import type { ContractFixture, MakeFixture } from './fixture';
import {
  cartOf,
  createProduct,
  editOf,
  failure,
  newId,
  openTill,
  recordCreated,
  refundRecord,
  saleRecord,
  stockOf,
} from './support';

/** Products, their stock movements, archiving and categories. */
export function describeCatalogPortContract(makeFixture: MakeFixture): void {
  describe('CatalogPort contract', () => {
    let fixture: ContractFixture;

    beforeEach(async () => {
      fixture = await makeFixture();
    });

    it('creates a product with its opening stock and lists it to every member', async () => {
      const name = `Contract dates ${newId().slice(0, 8)}`;
      const created = await fixture.admin.catalog.createProduct({
        name,
        priceMillimes: mm(6_750),
        categoryId: null,
        barcode: '',
        description: 'Tozeur',
        imageUrl: '',
        openingStock: 12,
      });

      const expected = {
        id: created.id,
        name,
        priceMillimes: 6_750,
        categoryId: null,
        categoryName: null,
        description: 'Tozeur',
        imageUrl: '',
        stock: 12,
      };
      expect(created).toMatchObject(expected);
      const listed = await fixture.cashier.catalog.listProducts();
      expect(listed.find((product) => product.id === created.id)).toMatchObject(expected);
    });

    it('refuses invalid product input', async () => {
      const valid = {
        name: `Contract invalid ${newId().slice(0, 8)}`,
        priceMillimes: mm(1_000),
        categoryId: null,
        barcode: '',
        description: '',
        imageUrl: '',
        openingStock: 1,
      };
      await failure(
        fixture.admin.catalog.createProduct({ ...valid, openingStock: -1 }),
        'VALIDATION_ERROR',
      );
      await failure(
        fixture.admin.catalog.createProduct({ ...valid, name: ' ' }),
        'VALIDATION_ERROR',
      );
      await failure(
        fixture.admin.catalog.createProduct({ ...valid, priceMillimes: mm(-1) }),
        'VALIDATION_ERROR',
      );

      const listed = await fixture.admin.catalog.listProducts();
      expect(listed.map((product) => product.name)).not.toContain(valid.name);
    });

    it('changes stock only by the delta, so a sale made while the form was open is kept', async () => {
      const product = await createProduct(fixture, 'olive oil', 18_500, 10);
      const till = await openTill(fixture);
      await recordCreated(
        fixture,
        await saleRecord(till, 1, cartOf([[product, 3]]), { method: 'card' }),
      );
      expect(await stockOf(fixture, product.id)).toBe(7);

      // The form loaded 10 before the sale; the admin counted 15 on the shelf.
      const updated = await fixture.admin.catalog.updateProduct(product.id, {
        ...editOf(product, 5),
        priceMillimes: mm(19_000),
      });
      expect(updated).toMatchObject({ id: product.id, priceMillimes: 19_000, stock: 12 });
      expect(await stockOf(fixture, product.id)).toBe(12);

      const renamed = await fixture.admin.catalog.updateProduct(product.id, {
        ...editOf(updated, 0),
        name: `${product.name} 1 L`,
      });
      expect(renamed).toMatchObject({ name: `${product.name} 1 L`, stock: 12 });
      await expect(
        fixture.admin.catalog.updateProduct(product.id, editOf(renamed, -12)),
      ).resolves.toMatchObject({ stock: 0 });
    });

    it('takes sold units out of stock and puts refunded units back, below zero if need be', async () => {
      const product = await createProduct(fixture, 'croissant', 800, 2);
      const till = await openTill(fixture);

      const sale = await saleRecord(till, 1, cartOf([[product, 3]]));
      await recordCreated(fixture, sale);
      expect(await stockOf(fixture, product.id)).toBe(-1);

      const stored = await fixture.cashier.sales.getSale(sale.id);
      await recordCreated(fixture, await refundRecord(till, 2, stored, [{ lineNo: 1, qty: 2 }]));
      expect(await stockOf(fixture, product.id)).toBe(1);
    });

    it('archives a deleted product: it leaves the list and can be neither edited nor deleted', async () => {
      const product = await createProduct(fixture, 'tuna', 4_950, 5);

      await fixture.admin.catalog.deleteProduct(product.id);

      const listed = await fixture.cashier.catalog.listProducts();
      expect(listed.map((candidate) => candidate.id)).not.toContain(product.id);
      const edit = await failure(
        fixture.admin.catalog.updateProduct(product.id, editOf(product, 1)),
        'NOT_FOUND',
      );
      expect(edit.details).toMatchObject({ productId: product.id });
      const again = await failure(fixture.admin.catalog.deleteProduct(product.id), 'NOT_FOUND');
      expect(again.details).toMatchObject({ productId: product.id });
    });

    it('answers NOT_FOUND for a product id that does not exist', async () => {
      const product = await createProduct(fixture, 'template', 1_000);
      const missing = newId();

      const edit = await failure(
        fixture.admin.catalog.updateProduct(missing, editOf(product, 0)),
        'NOT_FOUND',
      );
      expect(edit.details).toMatchObject({ productId: missing });
      const removal = await failure(fixture.admin.catalog.deleteProduct(missing), 'NOT_FOUND');
      expect(removal.details).toMatchObject({ productId: missing });
    });

    it('refuses catalog changes from a cashier and changes nothing', async () => {
      const product = await createProduct(fixture, 'harissa', 2_400, 40);
      const name = `Contract refused ${newId().slice(0, 8)}`;

      await failure(
        fixture.cashier.catalog.createProduct({ ...editOf(product, 0), name, openingStock: 1 }),
        'FORBIDDEN',
      );
      await failure(
        fixture.cashier.catalog.updateProduct(product.id, {
          ...editOf(product, 100),
          priceMillimes: mm(1),
        }),
        'FORBIDDEN',
      );
      await failure(fixture.cashier.catalog.deleteProduct(product.id), 'FORBIDDEN');

      const listed = await fixture.admin.catalog.listProducts();
      expect(listed.map((candidate) => candidate.name)).not.toContain(name);
      expect(listed.find((candidate) => candidate.id === product.id)).toMatchObject({
        priceMillimes: 2_400,
        stock: 40,
      });
    });

    it('creates and deletes categories, and a deleted category leaves its products without one', async () => {
      const name = `Contract ${newId().slice(0, 8)}`;
      const category = await fixture.admin.catalog.createCategory({ name, color: '#10b981' });
      expect(category).toMatchObject({ name, color: '#10b981' });
      const categories = await fixture.cashier.catalog.listCategories();
      expect(categories.map((candidate) => candidate.id)).toContain(category.id);

      const template = await createProduct(fixture, 'yoghurt', 450);
      const product = await fixture.admin.catalog.createProduct({
        ...editOf(template, 0),
        name: `${template.name} x4`,
        categoryId: category.id,
        openingStock: 6,
      });
      expect(product).toMatchObject({ categoryId: category.id, categoryName: name });

      await fixture.admin.catalog.deleteCategory(category.id);

      const remaining = await fixture.cashier.catalog.listCategories();
      expect(remaining.map((candidate) => candidate.id)).not.toContain(category.id);
      const listed = await fixture.cashier.catalog.listProducts();
      expect(listed.find((candidate) => candidate.id === product.id)).toMatchObject({
        categoryId: null,
        categoryName: null,
        stock: 6,
      });
    });
  });
}
