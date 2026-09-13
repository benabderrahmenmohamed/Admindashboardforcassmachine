import { useId } from 'react';
import { toast } from 'sonner';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { useSetAvailability } from '@/features/products/hooks/useProducts';
import { errorMessage } from '@/lib/errors';
import { formatTND } from '@/lib/money';
import type { Category, Product } from '@/ports';
import { menuSections } from '../menu';

/**
 * The menu of the day by category, with an "On the menu" switch on every item. The admin's Menu
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
  headingLevel,
}: {
  readonly products: readonly Product[];
  readonly categories: readonly Category[];
  /** What the screen says while the café has no products at all. */
  readonly emptyText: string;
  /** The level of a category's heading, one below the screen's own title. */
  readonly headingLevel: 2 | 3;
}) {
  const setAvailability = useSetAvailability();
  const sections = menuSections(products, categories);
  const Heading = headingLevel === 2 ? 'h2' : 'h3';

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
            <Heading className="text-base font-medium leading-none">{section.categoryName}</Heading>
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
  const on = product.isAvailable;
  const nameId = useId();
  const labelId = useId();
  return (
    <li className="py-2 flex flex-wrap items-center gap-x-3 gap-y-1">
      <span
        id={nameId}
        className={`flex-1 font-medium ${on ? 'text-gray-900' : 'text-gray-600 line-through'}`}
      >
        {product.name}
      </span>
      {!on && (
        <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-700">
          Sold out
        </span>
      )}
      <span className="text-gray-700">{formatTND(product.priceMillimes)}</span>
      {/*
        A switch rather than a button whose words change: its state is what it says. It is named by
        the item and then its visible label, so each switch is told apart and the label is in its name.
      */}
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-labelledby={`${nameId} ${labelId}`}
        disabled={isBusy}
        onClick={onToggle}
        className="min-h-11 inline-flex items-center gap-2 rounded-lg px-2 text-sm font-medium text-gray-900 hover:bg-gray-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 disabled:opacity-50"
      >
        <span
          aria-hidden="true"
          className={`relative inline-flex h-6 w-11 shrink-0 rounded-full transition-colors ${
            on ? 'bg-emerald-600' : 'bg-gray-300'
          }`}
        >
          <span
            className={`absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform ${
              on ? 'translate-x-5' : 'translate-x-0'
            }`}
          />
        </span>
        <span id={labelId}>On the menu</span>
      </button>
    </li>
  );
}
