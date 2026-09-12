import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useSetAvailability } from '@/features/products/hooks/useProducts';
import { errorMessage } from '@/lib/errors';
import { formatTND } from '@/lib/money';
import type { Category, Product } from '@/ports';
import { menuSections } from '../menu';

/**
 * The menu of the day by category, with the sold-out toggle next to every item. The admin's Menu
 * screen and the waiter's both draw it: the spec makes the toggle a daily one for admins and waiters.
 *
 * Marking something sold out is not a change to the product — the price and the name stay, and what
 * is already on a table keeps the price it was ordered at. It is the one thing about the menu that
 * moves during service, which is why it is a tap rather than a trip through the product form. It is
 * not queued: a waiter who cannot reach the server is told so, and the menu stays as it was.
 */
export function AvailabilityList({
  products,
  categories,
  emptyText,
}: {
  readonly products: readonly Product[];
  readonly categories: readonly Category[];
  /** What the screen says while the café has no products at all. */
  readonly emptyText: string;
}) {
  const setAvailability = useSetAvailability();
  const sections = menuSections(products, categories);

  if (sections.length === 0) {
    return <p className="py-12 text-center text-gray-600">{emptyText}</p>;
  }

  const toggle = (product: Product) => {
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
          toast.error(errorMessage(error, 'The menu could not be changed. Try again.'));
        },
      },
    );
  };

  return (
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
                  onToggle={() => toggle(product)}
                />
              ))}
            </ul>
          </CardContent>
        </Card>
      ))}
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
        className="min-h-11 min-w-32"
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
