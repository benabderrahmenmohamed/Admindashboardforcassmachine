import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { createHarness } from '@/test/harness';
import { CategoriesPage } from './CategoriesPage';

describe('CategoriesPage', () => {
  it("lists this shop's categories", async () => {
    const harness = await createHarness({ signedInAs: 'Owner' });
    const categories = await harness.backend.catalog.listCategories();

    harness.renderScreen(<CategoriesPage />, { allow: ['admin'] });

    expect(await screen.findByText(`Categories (${categories.length})`)).toBeDefined();
    for (const category of categories) {
      expect(screen.getByText(category.name)).toBeDefined();
    }
    // Another shop's category is not this shop's business.
    expect(screen.queryByText('General')).toBeNull();
  });
});
