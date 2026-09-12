import { Minus, Plus } from 'lucide-react';
import { useState } from 'react';
import { ErrorState, LoadingState } from '@/components/feedback';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Sheet, SheetContent } from '@/components/ui/sheet';
import { useCategories } from '@/features/categories/hooks/useCategories';
import { availableProducts, filterProducts } from '@/features/menu/menu';
import { useProducts } from '@/features/products/hooks/useProducts';
import { formatTND } from '@/lib/money';
import type { Product } from '@/ports';

/** What a waiter chose: a product, how many, and anything the kitchen needs to know. */
export interface MenuChoice {
  readonly product: Product;
  readonly qty: number;
  readonly note: string;
}

/**
 * The menu on a phone: a search, the categories as chips, and a list of big rows. Choosing a row
 * opens the note and the quantity, because "sans sucre" is the whole point of a note and typing it
 * has to be one tap away.
 */
export function MenuSheet({
  open,
  onOpenChange,
  onAdd,
  isAdding,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** Resolves true once the item is on the table. */
  readonly onAdd: (choice: MenuChoice) => Promise<boolean>;
  readonly isAdding: boolean;
}) {
  const productsQuery = useProducts();
  const categoriesQuery = useCategories();
  const [search, setSearch] = useState('');
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [chosen, setChosen] = useState<Product | null>(null);
  const [qty, setQty] = useState(1);
  const [note, setNote] = useState('');

  const reset = () => {
    setChosen(null);
    setQty(1);
    setNote('');
  };

  const close = (next: boolean) => {
    if (!next) {
      reset();
      setSearch('');
    }
    onOpenChange(next);
  };

  const add = async () => {
    if (!chosen) {
      return;
    }
    if (await onAdd({ product: chosen, qty, note })) {
      reset();
    }
  };

  const body = () => {
    if (productsQuery.isPending || categoriesQuery.isPending) {
      return <LoadingState />;
    }
    if (productsQuery.isLoadingError || categoriesQuery.isLoadingError) {
      return (
        <ErrorState
          title="Failed to load the menu"
          error={productsQuery.error ?? categoriesQuery.error}
          onRetry={() => {
            if (productsQuery.isError) void productsQuery.refetch();
            if (categoriesQuery.isError) void categoriesQuery.refetch();
          }}
        />
      );
    }

    const menu = filterProducts(availableProducts(productsQuery.data), search, categoryId);
    if (chosen) {
      return (
        <ChosenItem
          product={chosen}
          qty={qty}
          note={note}
          onQty={setQty}
          onNote={setNote}
          onBack={reset}
          onAdd={() => void add()}
          isAdding={isAdding}
        />
      );
    }
    return (
      <>
        <Input
          className="min-h-11"
          placeholder="Search the menu"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          aria-label="Search the menu"
        />
        <div className="flex gap-2 overflow-x-auto py-2">
          <CategoryChip
            label="All"
            isActive={categoryId === null}
            onClick={() => setCategoryId(null)}
          />
          {categoriesQuery.data.map((category) => (
            <CategoryChip
              key={category.id}
              label={category.name}
              isActive={categoryId === category.id}
              onClick={() => setCategoryId(category.id)}
            />
          ))}
        </div>
        {menu.length === 0 ? (
          <p className="py-8 text-center text-sm text-gray-600">
            Nothing on the menu matches. Sold-out items are not shown.
          </p>
        ) : (
          <ul className="space-y-2 overflow-y-auto">
            {menu.map((product) => (
              <li key={product.id}>
                <button
                  type="button"
                  onClick={() => setChosen(product)}
                  className="w-full min-h-14 px-3 py-2 flex items-center justify-between rounded-lg border border-gray-200 bg-white text-left hover:border-blue-400"
                >
                  <span className="font-medium text-gray-900">{product.name}</span>
                  <span className="text-gray-700">{formatTND(product.priceMillimes)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </>
    );
  };

  return (
    <Sheet open={open} onOpenChange={close}>
      <SheetContent side="bottom" className="h-[85vh] flex flex-col gap-2 p-3">
        <h2 className="text-lg font-bold text-gray-900">Add to the table</h2>
        {body()}
      </SheetContent>
    </Sheet>
  );
}

function CategoryChip({
  label,
  isActive,
  onClick,
}: {
  readonly label: string;
  readonly isActive: boolean;
  readonly onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={isActive}
      onClick={onClick}
      className={`min-h-11 px-4 rounded-full border whitespace-nowrap text-sm font-medium ${
        isActive
          ? 'bg-blue-600 text-white border-blue-600'
          : 'bg-white text-gray-700 border-gray-200'
      }`}
    >
      {label}
    </button>
  );
}

function ChosenItem({
  product,
  qty,
  note,
  onQty,
  onNote,
  onBack,
  onAdd,
  isAdding,
}: {
  readonly product: Product;
  readonly qty: number;
  readonly note: string;
  readonly onQty: (qty: number) => void;
  readonly onNote: (note: string) => void;
  readonly onBack: () => void;
  readonly onAdd: () => void;
  readonly isAdding: boolean;
}) {
  return (
    <div className="flex flex-col gap-4">
      <div>
        <p className="text-xl font-bold text-gray-900">{product.name}</p>
        <p className="text-gray-700">{formatTND(product.priceMillimes)}</p>
      </div>

      <div className="flex items-center gap-4">
        <Button
          type="button"
          variant="outline"
          className="min-h-12 min-w-12"
          aria-label="One fewer"
          disabled={qty <= 1}
          onClick={() => onQty(qty - 1)}
        >
          <Minus className="h-5 w-5" />
        </Button>
        <span className="text-2xl font-bold w-10 text-center" aria-live="polite">
          {qty}
        </span>
        <Button
          type="button"
          variant="outline"
          className="min-h-12 min-w-12"
          aria-label="One more"
          onClick={() => onQty(qty + 1)}
        >
          <Plus className="h-5 w-5" />
        </Button>
      </div>

      <div>
        <Label htmlFor="item-note">Note for the kitchen</Label>
        <Input
          id="item-note"
          className="mt-2 min-h-11"
          value={note}
          onChange={(event) => onNote(event.target.value)}
          placeholder="Sans sucre"
          autoComplete="off"
        />
      </div>

      <div className="flex gap-2">
        <Button type="button" variant="outline" className="min-h-12 flex-1" onClick={onBack}>
          Back
        </Button>
        <Button type="button" className="min-h-12 flex-1" disabled={isAdding} onClick={onAdd}>
          {isAdding ? 'Adding…' : 'Add to the table'}
        </Button>
      </div>
    </div>
  );
}
