import { Check } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { formatTND, type Millimes } from '@/lib/money';
import { paymentMethodSchema } from '@/ports';
import type { PaymentMethod } from '../types';

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
  readonly onConfirm: () => void;
  /** True while the sale is being recorded: Confirm is disabled so it cannot be sent twice. */
  readonly isConfirming: boolean;
}

export function CheckoutDialog({
  open,
  onOpenChange,
  totalMillimes,
  paymentMethod,
  onPaymentMethodChange,
  onConfirm,
  isConfirming,
}: CheckoutDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Complete Payment</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
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
                  variant={paymentMethod === method ? 'default' : 'outline'}
                  onClick={() => onPaymentMethodChange(method)}
                >
                  {PAYMENT_METHOD_LABELS[method]}
                </Button>
              ))}
            </div>
          </div>
          <Button className="w-full" size="lg" disabled={isConfirming} onClick={() => onConfirm()}>
            <Check className="mr-2" />
            Confirm
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
