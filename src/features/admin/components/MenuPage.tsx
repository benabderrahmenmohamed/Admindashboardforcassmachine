import { Link } from 'react-router';
import { toast } from 'sonner';
import { ErrorState, LoadingState } from '@/components/feedback';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useCategories } from '@/features/categories/hooks/useCategories';
import { menuSections, soldOutCount } from '@/features/menu/menu';
import { useProducts, useSetAvailability } from '@/features/products/hooks/useProducts';
import { errorMessage } from '@/lib/errors';
import { formatTND } from '@/lib/money';
import type { Product } from '@/ports';

/**
 * The menu of the day: by category, with the sold-out toggle next to every item.
 *
 * Marking something sold out is not a change to the product — the price and the name stay, and what
 * is already on a table keeps the price it was ordered at. It is the one thing about the menu that
 * moves during service, which is why it is a tap here rather than a trip through the product form.
 */
export function MenuPage() {
  const productsQuery = useProducts();
  const categoriesQuery = useCategories();
  const setAvailability = useSetAvailability();

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

  const sections = menuSections(productsQuery.data, categoriesQuery.data);
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

      {sections.length === 0 ? (
        <p className="py-12 text-center text-gray-600">
          Nothing on the menu yet. Add the café&apos;s products first.
        </p>
      ) : (
        <div className="space-y-6">
          {sections.map((section) => (
            <Card key={section.categoryId ?? 'other'}>
              <CardHeader>
                <CardTitle>{section.categoryName}</CardTitle>
              </CardHeader>
              <CardContent>
                <ul className="divide-y divide-gray-100">
                  {section.products.map((product) => (
                    <MenuRow
                      key={product.id}
                      product={product}
                      isBusy={setAvailability.isPending}
                      onToggle={() => {
                        setAvailability.mutate(
                          { id: product.id, isAvailable: !product.isAvailable },
                          {
                            onSuccess: (updated) => {
                              toast.success(
                                updated.isAvailable
                                  ? `${updated.name} is back on the menu`
                                  : `${updated.name} is sold out for today`,
                              );
                            },
                            onError: (error) => {
                              toast.error(
                                errorMessage(error, 'The menu could not be changed. Try again.'),
                              );
                            },
                          },
                        );
                      }}
                    />
                  ))}
                </ul>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

function MenuRow({
  product,
  isBusy,
  onToggle,
}: {
  readonly product: Product;
  readonly isBusy: boolean;
  readonly onToggle: () => void;
}) {
  return (
    <li className="py-2 flex items-center gap-3">
      <span
        className={`flex-1 font-medium ${
          product.isAvailable ? 'text-gray-900' : 'text-gray-400 line-through'
        }`}
      >
        {product.name}
      </span>
      <span className="text-gray-700">{formatTND(product.priceMillimes)}</span>
      <Button
        type="button"
        variant={product.isAvailable ? 'outline' : 'secondary'}
        className="min-h-11 min-w-36"
        aria-pressed={!product.isAvailable}
        aria-label={
          product.isAvailable ? `Mark ${product.name} sold out` : `Put ${product.name} back on`
        }
        disabled={isBusy}
        onClick={onToggle}
      >
        {product.isAvailable ? 'On the menu' : 'Sold out'}
      </Button>
    </li>
  );
}
