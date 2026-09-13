import { Link } from 'react-router';
import { ErrorState, LoadingState } from '@/components/feedback';
import { useCategories } from '@/features/categories/hooks/useCategories';
import { AvailabilityList } from '@/features/menu/components/AvailabilityList';
import { soldOutCount } from '@/features/menu/menu';
import { useProducts } from '@/features/products/hooks/useProducts';

/**
 * The menu of the day in the back office: by category, with the sold-out toggle next to every item,
 * and the way to the product form for anything that is not a daily change.
 */
export function MenuPage() {
  const productsQuery = useProducts();
  const categoriesQuery = useCategories();

  if (productsQuery.isPending || categoriesQuery.isPending) {
    return <LoadingState />;
  }
  if (productsQuery.isLoadingError || categoriesQuery.isLoadingError) {
    return (
      <ErrorState
        title="Failed to load the menu"
        error={productsQuery.isLoadingError ? productsQuery.error : categoriesQuery.error}
        onRetry={() => {
          if (productsQuery.isError) void productsQuery.refetch();
          if (categoriesQuery.isError) void categoriesQuery.refetch();
        }}
      />
    );
  }

  const soldOut = soldOutCount(productsQuery.data);

  return (
    <div>
      <div className="mb-8">
        <h1 className="text-3xl font-bold text-gray-900 mb-2">Menu</h1>
        <p className="text-gray-600">
          What the waiters can put on a table today. {soldOut} of {productsQuery.data.length} sold
          out. Prices and names are edited in{' '}
          <Link className="underline" to="/admin/products">
            Products
          </Link>
          .
        </p>
      </div>

      <AvailabilityList
        products={productsQuery.data}
        categories={categoriesQuery.data}
        emptyText="Nothing on the menu yet. Add the café’s products first."
        headingLevel={2}
      />
    </div>
  );
}
