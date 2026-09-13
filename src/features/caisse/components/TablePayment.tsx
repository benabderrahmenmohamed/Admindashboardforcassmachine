import { Percent, Tag } from 'lucide-react';
import { useId, useMemo, useState } from 'react';
import { ErrorState, LoadingState } from '@/components/feedback';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { LocalBadge } from '@/features/orders/components/LocalBadge';
import { useRoomOrder } from '@/features/orders/hooks/useOrders';
import { NEEDS_ATTENTION, itemSync } from '@/features/orders/localFlags';
import type { RoomItem } from '@/features/orders/overlay';
import { itemTotal } from '@/features/orders/tableOrder';
import type { CheckoutPayment } from '@/features/pos/types';
import { formatTND } from '@/lib/money';
import type { DiningTable, PaymentMethod } from '@/ports';
import { totals, type Cart } from '../cart';
import {
  buildPaymentCart,
  heldItems,
  holdReason,
  noSelection,
  payableItems,
  paymentPlan,
  pruneSelection,
  readDiscountPercent,
  selectAll,
  toggleItem,
  type HoldReason,
  type ItemSelection,
  type LineDiscount,
} from '../payment';
import { CancelOrderButton } from './CancelOrderButton';
import { CheckoutDialog } from './CheckoutDialog';
import { LineDiscountDialog } from './LineDiscountDialog';

/**
 * Paying a table at the counter: tick what is being paid for, discount a line with a reason, take a
 * percentage off the whole lot, then cash or card.
 *
 * Items are paid whole, so the choice is rows and nothing finer, and the table stays open for
 * whatever was not ticked. The cart is derived from what is on the table on every render rather than
 * kept in state, so a waiter adding or removing something while the cashier is looking corrects the
 * screen instead of stranding it on a row that is no longer there.
 *
 * A row this device changed and the server does not have yet is shown but cannot be ticked: a
 * payment naming it would be refused (see `holdReason`).
 */
export function TablePayment({
  table,
  onPay,
  isRecording,
}: {
  readonly table: DiningTable;
  /** Takes the payment; resolves true once the sale is recorded on this device. */
  readonly onPay: (input: {
    readonly cart: Cart;
    readonly payment: CheckoutPayment;
    /** The rows this payment takes, for the sale record and for what the table keeps. */
    readonly itemIds: readonly string[];
  }) => Promise<boolean>;
  readonly isRecording: boolean;
}) {
  const room = useRoomOrder(table.id);
  const [rawSelection, setSelection] = useState<ItemSelection>(noSelection);
  const [discounts, setDiscounts] = useState<ReadonlyMap<string, LineDiscount>>(new Map());
  const [percentText, setPercentText] = useState('');
  const [discounting, setDiscounting] = useState<RoomItem | null>(null);
  const [isCheckoutOpen, setIsCheckoutOpen] = useState(false);
  const [method, setMethod] = useState<PaymentMethod>('cash');

  const items = useMemo(() => payableItems(room.order), [room.order]);
  const held = useMemo(() => heldItems(room.order), [room.order]);
  // Rows somebody else paid or removed, and rows this device is now taking off, drop out of the
  // ticks on their own.
  const selection = useMemo(() => pruneSelection(items, rawSelection), [items, rawSelection]);
  const percent = readDiscountPercent(percentText);
  const cart = buildPaymentCart(items, selection, discounts, percent.ok ? percent.basisPoints : 0);
  const plan = paymentPlan(items, cart, held);
  const cartTotals = totals(cart);

  if (room.query.isPending) {
    return <LoadingState />;
  }
  if (room.query.isLoadingError) {
    return (
      <ErrorState
        title={`Failed to load ${table.name}`}
        error={room.query.error}
        onRetry={() => void room.query.refetch()}
      />
    );
  }

  if (items.length === 0 && held.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>{table.name}</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-gray-600">
            Nothing is owed on this table. Pick another one from the room.
          </p>
        </CardContent>
      </Card>
    );
  }

  const setDiscount = (itemId: string, discount: LineDiscount) => {
    const next = new Map(discounts);
    if (discount.millimes <= 0) {
      next.delete(itemId);
    } else {
      next.set(itemId, discount);
    }
    setDiscounts(next);
    setDiscounting(null);
  };

  const pay = async (payment: CheckoutPayment) => {
    if (await onPay({ cart, payment, itemIds: plan.itemIds })) {
      setIsCheckoutOpen(false);
      setSelection(noSelection);
      setDiscounts(new Map());
      setPercentText('');
    }
  };

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
        <CardTitle>{table.name}</CardTitle>
        <div className="flex flex-wrap gap-2">
          <CancelOrderButton table={table} order={room.order} />
          {items.length > 0 && (
            <Button
              type="button"
              variant="outline"
              className="min-h-11"
              onClick={() =>
                setSelection(selection.size === items.length ? noSelection : selectAll(items))
              }
            >
              {selection.size === items.length ? 'Clear' : 'Everything'}
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {items.length > 0 && (
          <ul className="space-y-2">
            {items.map((item) => {
              const chosen = selection.has(item.id);
              const discount = discounts.get(item.id);
              return (
                <li key={item.id} className="flex items-center gap-2">
                  <label className="flex-1 flex items-center gap-3 p-2 rounded-lg border border-gray-200 cursor-pointer min-h-11">
                    <input
                      type="checkbox"
                      className="w-5 h-5"
                      checked={chosen}
                      onChange={() => setSelection(toggleItem(selection, item.id))}
                    />
                    <span className="flex-1">
                      <span className="block font-medium text-gray-900">
                        {item.qty}× {item.nameSnapshot}
                      </span>
                      {discount && (
                        <span className="block text-sm text-emerald-700">
                          −{formatTND(discount.millimes)} · {discount.reason}
                        </span>
                      )}
                    </span>
                    <span className="text-gray-700">{formatTND(itemTotal(item))}</span>
                  </label>
                  <Button
                    type="button"
                    variant="ghost"
                    className="min-h-11 min-w-11"
                    aria-label={`Discount ${item.nameSnapshot}`}
                    disabled={!chosen}
                    onClick={() => setDiscounting(item)}
                  >
                    <Tag className="h-5 w-5" />
                  </Button>
                </li>
              );
            })}
          </ul>
        )}

        {held.length > 0 && <HeldItems items={held} />}

        {items.length > 0 && (
          <>
            <div>
              <Label htmlFor="cart-discount">Discount on this payment (%)</Label>
              <div className="mt-2 flex items-center gap-2">
                <Percent className="h-4 w-4 text-gray-500" />
                <Input
                  id="cart-discount"
                  className="min-h-11"
                  inputMode="decimal"
                  autoComplete="off"
                  placeholder="0"
                  value={percentText}
                  onChange={(event) => setPercentText(event.target.value)}
                  aria-invalid={!percent.ok}
                />
              </div>
              {!percent.ok && <p className="mt-1 text-sm text-red-600">{percent.problem}</p>}
            </div>

            <dl className="space-y-1 text-sm border-t border-gray-200 pt-3">
              <Row label="Subtotal" value={formatTND(cartTotals.subtotalMillimes)} />
              {cartTotals.discountMillimes > 0 && (
                <Row label="Discount" value={`−${formatTND(cartTotals.discountMillimes)}`} />
              )}
              <Row label="To pay" value={formatTND(plan.totalMillimes)} strong />
              {plan.remainingMillimes > 0 && (
                <Row label="Left on the table" value={formatTND(plan.remainingMillimes)} />
              )}
            </dl>

            {plan.problem !== null && <p className="text-sm text-gray-600">{plan.problem}</p>}

            <Button
              type="button"
              size="lg"
              className="w-full min-h-12"
              disabled={plan.problem !== null || !percent.ok || isRecording}
              onClick={() => setIsCheckoutOpen(true)}
            >
              {plan.closesTable ? 'Pay the whole table' : `Pay ${formatTND(plan.totalMillimes)}`}
            </Button>
          </>
        )}
      </CardContent>

      <LineDiscountDialog
        item={discounting}
        current={discounting === null ? undefined : discounts.get(discounting.id)}
        onOpenChange={(open) => {
          if (!open) {
            setDiscounting(null);
          }
        }}
        onConfirm={(discount) => {
          if (discounting !== null) {
            setDiscount(discounting.id, discount);
          }
        }}
      />

      <CheckoutDialog
        open={isCheckoutOpen}
        onOpenChange={setIsCheckoutOpen}
        title={`${table.name} — ${formatTND(plan.totalMillimes)}`}
        totalMillimes={plan.totalMillimes}
        paymentMethod={method}
        onPaymentMethodChange={setMethod}
        onConfirm={(payment) => void pay(payment)}
        isConfirming={isRecording}
      />
    </Card>
  );
}

const HOLD_TEXT: Record<HoldReason, string> = {
  'not-on-server': 'Not synced',
  paying: 'Being paid',
  'coming-off': 'Coming off',
  cancelling: 'Cancelling',
};

/**
 * Rows on the table this counter cannot take money for yet. No checkbox: the only way to pay one
 * is to wait until the server has it, which the flag says it has not.
 */
function HeldItems({ items }: { readonly items: readonly RoomItem[] }) {
  const titleId = useId();
  return (
    <section aria-labelledby={titleId} className="space-y-2">
      <div>
        <h3 id={titleId} className="text-sm font-semibold text-gray-900">
          Not payable yet
        </h3>
        <p className="text-sm text-gray-600">Changed on this device, not on the server yet.</p>
      </div>
      <ul className="space-y-2">
        {items.map((item) => {
          const reason = holdReason(item);
          const sync = itemSync(item);
          return (
            <li
              key={item.id}
              className="flex items-center gap-3 p-2 rounded-lg border border-dashed border-gray-300 min-h-11 text-gray-600"
            >
              <span className="flex-1">
                <span className="block font-medium">
                  {item.qty}× {item.nameSnapshot}
                </span>
                {reason !== null && (
                  <LocalBadge sync={sync ?? 'pending'}>
                    {sync === 'conflict' ? NEEDS_ATTENTION : HOLD_TEXT[reason]}
                  </LocalBadge>
                )}
              </span>
              <span>{item.priceKnown ? formatTND(itemTotal(item)) : 'Price to come'}</span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function Row({
  label,
  value,
  strong = false,
}: {
  readonly label: string;
  readonly value: string;
  readonly strong?: boolean;
}) {
  return (
    <div className={`flex justify-between ${strong ? 'text-lg font-bold text-gray-900' : ''}`}>
      <dt className={strong ? '' : 'text-gray-600'}>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}
