import { ChevronLeft } from 'lucide-react';
import { Link } from 'react-router';
import { ErrorState, LoadingState } from '@/components/feedback';
import { Button } from '@/components/ui/button';
import { useCategories } from '@/features/categories/hooks/useCategories';
import { AvailabilityList } from '@/features/menu/components/AvailabilityList';
import { soldOutCount } from '@/features/menu/menu';
import { useProducts } from '@/features/products/hooks/useProducts';

/**
 * The menu of the day on a waiter's phone: what has sold out and what is back, one tap each. The
 * waiter is the first to hear that the kitchen has run out of something, so the daily toggle is here
 * as well as in the back office; prices and names stay the admin's.
 */
export function MenuOfTheDayPage() {
  const productsQuery = useProducts();
  const categoriesQuery = useCategories();

  const header = (
    <div className="py-2 flex items-center gap-2">
      <Button asChild variant="ghost" className="min-h-11 -ml-2">
        <Link to="/serveur">
          <ChevronLeft className="h-5 w-5" />
          Room
        </Link>
      </Button>
      <h2 className="text-xl font-bold text-gray-900">Menu of the day</h2>
    </div>
  );

  if (productsQuery.isPending || categoriesQuery.isPending) {
    return (
      <div className="p-3">
        {header}
        <LoadingState />
      </div>
    );
  }
  if (productsQuery.isLoadingError || categoriesQuery.isLoadingError) {
    return (
      <div className="p-3">
        {header}
        <ErrorState
          title="Failed to load the menu"
          error={productsQuery.isLoadingError ? productsQuery.error : categoriesQuery.error}
          onRetry={() => {
            if (productsQuery.isError) void productsQuery.refetch();
            if (categoriesQuery.isError) void categoriesQuery.refetch();
          }}
        />
      </div>
    );
  }

  const soldOut = soldOutCount(productsQuery.data);

  return (
    <div className="p-3 pb-8">
      {header}
      <p className="mb-3 text-sm text-gray-600">
        {soldOut === 1 ? '1 item is' : `${soldOut} items are`} sold out. Tap an item when the
        kitchen runs out of it, and again when it is back.
      </p>
      <AvailabilityList
        products={productsQuery.data}
        categories={categoriesQuery.data}
        emptyText="Nothing on the menu yet: the admin adds the café’s products."
        headingLevel={3}
      />
    </div>
  );
}
