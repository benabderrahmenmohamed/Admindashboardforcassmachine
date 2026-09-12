import { Check } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { formatTND, toDinarsString, type Millimes } from '@/lib/money';
import { paymentMethodSchema } from '@/ports';
import { readCashTender } from '../selling';
import type { CheckoutPayment, PaymentMethod } from '../types';

const PAYMENT_METHOD_LABELS: Record<PaymentMethod, string> = {
  cash: 'Cash',
  card: 'Card',
};

interface CheckoutDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly totalMillimes: Millimes;
  readonly paymentMethod: PaymentMethod;
  readonly onPaymentMethodChange: (paymentMethod: PaymentMethod) => void;
  /** Cash carries the amount tendered; card is always exactly the total. */
  readonly onConfirm: (payment: CheckoutPayment) => void;
  /** True while the sale is being written: Confirm is disabled so it cannot be recorded twice. */
  readonly isConfirming: boolean;
}

export function CheckoutDialog({ open, onOpenChange, ...form }: CheckoutDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Complete Payment</DialogTitle>
        </DialogHeader>
        {/* Mounted again on every opening, so the amount tendered starts at the current total. */}
        <CheckoutForm {...form} />
      </DialogContent>
    </Dialog>
  );
}

function CheckoutForm({
  totalMillimes,
  paymentMethod,
  onPaymentMethodChange,
  onConfirm,
  isConfirming,
}: Omit<CheckoutDialogProps, 'open' | 'onOpenChange'>) {
  const [tenderedText, setTenderedText] = useState(() => toDinarsString(totalMillimes));
  // Card needs nothing: the terminal charges exactly the total.
  const tender = paymentMethod === 'cash' ? readCashTender(totalMillimes, tenderedText) : null;

  const confirm = () => {
    if (tender === null) {
      onConfirm({ method: paymentMethod, tenderedMillimes: totalMillimes });
    } else if (tender.ok) {
      onConfirm({ method: paymentMethod, tenderedMillimes: tender.tenderedMillimes });
    }
  };

  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (!isConfirming) {
          confirm();
        }
      }}
    >
      <div className="bg-gray-50 p-4 rounded-lg">
        <p className="text-sm text-gray-600">Total Amount:</p>
        <p className="text-3xl font-bold">{formatTND(totalMillimes)}</p>
      </div>
      <div className="space-y-2">
        <p className="font-semibold">Payment Method:</p>
        <div className="grid grid-cols-2 gap-2">
          {paymentMethodSchema.options.map((method) => (
            <Button
              key={method}
              type="button"
              variant={paymentMethod === method ? 'default' : 'outline'}
              onClick={() => onPaymentMethodChange(method)}
            >
              {PAYMENT_METHOD_LABELS[method]}
            </Button>
          ))}
        </div>
      </div>
      {tender && (
        <div className="space-y-2">
          <Label htmlFor="amount-tendered">Amount tendered (DT)</Label>
          <Input
            id="amount-tendered"
            inputMode="decimal"
            autoComplete="off"
            value={tenderedText}
            onChange={(e) => setTenderedText(e.target.value)}
            onFocus={(e) => e.target.select()}
            aria-invalid={!tender.ok}
            className="text-lg"
          />
          {tender.ok ? (
            <div className="flex justify-between text-lg">
              <span className="text-gray-600">Change:</span>
              <span className="font-bold">{formatTND(tender.changeMillimes)}</span>
            </div>
          ) : (
            <p className="text-sm text-red-600">{tender.problem}</p>
          )}
        </div>
      )}
      <Button
        type="submit"
        className="w-full"
        size="lg"
        disabled={isConfirming || (tender !== null && !tender.ok)}
      >
        <Check className="mr-2" />
        {isConfirming ? 'Recording...' : 'Confirm'}
      </Button>
    </form>
  );
}
