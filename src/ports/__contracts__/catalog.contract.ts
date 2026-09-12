import { beforeEach, describe, expect, it } from 'vitest';
import { mm } from '@/lib/money';
import type { ContractFixture, MakeFixture } from './fixture';
import {
  cartOf,
  createProduct,
  editOf,
  failure,
  listed,
  newId,
  openTill,
  recordCreated,
  refundRecord,
  saleRecord,
  stockAdjustment,
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
        isAvailable: true,
        trackStock: true,
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
        isAvailable: true,
        trackStock: true,
        stockQty: 12,
      };
      expect(created).toMatchObject(expected);
      const all = await fixture.cashier.catalog.listProducts();
      expect(all.find((product) => product.id === created.id)).toMatchObject(expected);
    });

    it('refuses invalid product input', async () => {
      const valid = {
        name: `Contract invalid ${newId().slice(0, 8)}`,
        priceMillimes: mm(1_000),
        categoryId: null,
        barcode: '',
        description: '',
        imageUrl: '',
        isAvailable: true,
        trackStock: true,
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

      const all = await fixture.admin.catalog.listProducts();
      expect(all.map((product) => product.name)).not.toContain(valid.name);
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
      expect(updated).toMatchObject({ id: product.id, priceMillimes: 19_000, stockQty: 12 });
      expect(await stockOf(fixture, product.id)).toBe(12);

      const renamed = await fixture.admin.catalog.updateProduct(product.id, {
        ...editOf(updated, 0),
        name: `${product.name} 1 L`,
      });
      expect(renamed).toMatchObject({ name: `${product.name} 1 L`, stockQty: 12 });
      await expect(
        fixture.admin.catalog.updateProduct(product.id, editOf(renamed, -12)),
      ).resolves.toMatchObject({ stockQty: 0 });
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

      const all = await fixture.cashier.catalog.listProducts();
      expect(all.map((candidate) => candidate.id)).not.toContain(product.id);
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

      const all = await fixture.admin.catalog.listProducts();
      expect(all.map((candidate) => candidate.name)).not.toContain(name);
      expect(all.find((candidate) => candidate.id === product.id)).toMatchObject({
        priceMillimes: 2_400,
        stockQty: 40,
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
      const all = await fixture.cashier.catalog.listProducts();
      expect(all.find((candidate) => candidate.id === product.id)).toMatchObject({
        categoryId: null,
        categoryName: null,
        stockQty: 6,
      });
    });

    // The café case: the kitchen runs out of a dish at eight in the evening and it is back tomorrow.
    // Nobody should have to edit a price to say so, so the toggle is its own write and the floor may
    // use it — but it must not become a way around the catalog being the admin's.
    it('lets a waiter take a dish off the menu and put it back, touching nothing else', async () => {
      const product = await createProduct(fixture, 'brik', 3_500, 4);

      const soldOut = await fixture.waiter.catalog.setAvailability(product.id, false);

      expect(soldOut).toMatchObject({
        id: product.id,
        isAvailable: false,
        name: product.name,
        priceMillimes: product.priceMillimes,
        stockQty: 4,
      });
      expect(await listed(fixture, product.id)).toMatchObject({ isAvailable: false });
      await expect(fixture.admin.catalog.setAvailability(product.id, true)).resolves.toMatchObject({
        isAvailable: true,
      });
      expect(await listed(fixture, product.id)).toMatchObject({ isAvailable: true });
    });

    it('refuses the menu toggle to the kitchen and for a product that does not exist', async () => {
      const product = await createProduct(fixture, 'chakchouka', 5_000);

      await failure(fixture.kitchen.catalog.setAvailability(product.id, false), 'FORBIDDEN');
      expect(await listed(fixture, product.id)).toMatchObject({ isAvailable: true });

      const missing = newId();
      const unknown = await failure(
        fixture.admin.catalog.setAvailability(missing, false),
        'NOT_FOUND',
      );
      expect(unknown.details).toMatchObject({ productId: missing });
    });

    it('counts an admin stock correction once, however many times it arrives', async () => {
      const product = await createProduct(fixture, 'sugar', 1_200, 20);
      const adjustment = await stockAdjustment(product.id, -3);

      await expect(fixture.admin.catalog.adjustStock(adjustment)).resolves.toEqual({
        status: 'created',
        productId: product.id,
        stockQty: 17,
      });

      // The same correction sent twice — an offline phone retrying — is the same correction, and it
      // answers what it answered then rather than counting again.
      await expect(fixture.admin.catalog.adjustStock(adjustment)).resolves.toEqual({
        status: 'replayed',
        productId: product.id,
        stockQty: 17,
      });
      expect(await stockOf(fixture, product.id)).toBe(17);

      await expect(
        fixture.admin.catalog.adjustStock(await stockAdjustment(product.id, 5)),
      ).resolves.toMatchObject({ status: 'created', stockQty: 22 });
    });

    it('keeps stock corrections to the admin and refuses one that moves nothing', async () => {
      const product = await createProduct(fixture, 'flour', 2_000, 9);
      const adjustment = await stockAdjustment(product.id, -2);

      await failure(fixture.waiter.catalog.adjustStock(adjustment), 'FORBIDDEN');
      await failure(fixture.cashier.catalog.adjustStock(adjustment), 'FORBIDDEN');
      await failure(
        fixture.admin.catalog.adjustStock(await stockAdjustment(product.id, 0)),
        'VALIDATION_ERROR',
      );
      await failure(
        fixture.admin.catalog.adjustStock(await stockAdjustment(product.id, -2, '  ')),
        'VALIDATION_ERROR',
      );
      await failure(
        fixture.admin.catalog.adjustStock(await stockAdjustment(newId(), -2)),
        'NOT_FOUND',
      );

      expect(await stockOf(fixture, product.id)).toBe(9);
    });
  });
}
