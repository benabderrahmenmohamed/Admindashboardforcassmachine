import { useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { RoomItem } from '@/features/orders/overlay';
import { itemTotal } from '@/features/orders/tableOrder';
import { readCashAmount } from '@/features/pos/selling';
import { formatTND, toDinarsString, ZERO } from '@/lib/money';
import type { LineDiscount } from '../payment';

/**
 * An "offert": money taken off one row at payment, which the spec allows a cashier or an admin and
 * always with a reason. Offering the whole row is one tap, because that is what an apology for a
 * cold coffee actually is.
 */
export function LineDiscountDialog({
  item,
  current,
  onOpenChange,
  onConfirm,
}: {
  /** The row being discounted, or null when the dialog is closed. */
  readonly item: RoomItem | null;
  readonly current: LineDiscount | undefined;
  readonly onOpenChange: (open: boolean) => void;
  /** A discount of zero takes the offer back off the row. */
  readonly onConfirm: (discount: LineDiscount) => void;
}) {
  return (
    <Dialog open={item !== null} onOpenChange={onOpenChange}>
      <DialogContent>
        {/* Mounted afresh per row, so each one starts from what it already carries. */}
        {item !== null && (
          <DiscountForm
            key={item.id}
            item={item}
            current={current}
            onCancel={() => onOpenChange(false)}
            onConfirm={onConfirm}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function DiscountForm({
  item,
  current,
  onCancel,
  onConfirm,
}: {
  readonly item: RoomItem;
  readonly current: LineDiscount | undefined;
  readonly onCancel: () => void;
  readonly onConfirm: (discount: LineDiscount) => void;
}) {
  const [amountText, setAmountText] = useState(() => toDinarsString(current?.millimes ?? ZERO));
  const [reason, setReason] = useState(current?.reason ?? '');

  const gross = itemTotal(item);
  const amount = readCashAmount(amountText);
  const trimmed = reason.trim();
  const problem = !amount.ok
    ? amount.problem
    : amount.millimes > gross
      ? `That is more than the line, which is ${formatTND(gross)}`
      : amount.millimes > 0 && trimmed === ''
        ? 'Say why this line is discounted'
        : null;

  return (
    <>
      <DialogHeader>
        <DialogTitle>Discount {item.nameSnapshot}</DialogTitle>
        <DialogDescription>
          The line is {formatTND(gross)}. A discount always says why, and the reason is kept on the
          receipt.
        </DialogDescription>
      </DialogHeader>
      <form
        id="line-discount-form"
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (problem === null && amount.ok) {
            onConfirm({ millimes: amount.millimes, reason: trimmed });
          }
        }}
      >
        <div>
          <Label htmlFor="line-discount-amount">Amount off (DT)</Label>
          <Input
            id="line-discount-amount"
            className="mt-2 min-h-11 text-lg"
            inputMode="decimal"
            autoComplete="off"
            value={amountText}
            onChange={(event) => setAmountText(event.target.value)}
            onFocus={(event) => event.target.select()}
            aria-invalid={problem !== null}
          />
          <Button
            type="button"
            variant="outline"
            className="mt-2 min-h-11"
            onClick={() => setAmountText(toDinarsString(gross))}
          >
            Offer the whole line
          </Button>
        </div>
        <div>
          <Label htmlFor="line-discount-reason">Reason</Label>
          <Input
            id="line-discount-reason"
            className="mt-2 min-h-11"
            autoComplete="off"
            placeholder="Offert : erreur cuisine"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
        </div>
        {problem !== null && <p className="text-sm text-red-600">{problem}</p>}
      </form>
      <DialogFooter>
        <Button type="button" variant="outline" className="min-h-11" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          type="submit"
          form="line-discount-form"
          className="min-h-11"
          disabled={problem !== null}
        >
          Apply
        </Button>
      </DialogFooter>
    </>
  );
}
