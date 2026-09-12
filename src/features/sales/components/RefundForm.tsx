import { Minus, Plus, Undo2 } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { formatTND } from '@/lib/money';
import { paymentMethodSchema } from '@/ports';
import type { PaymentMethod, RefundSelection, Sale } from '../types';
import {
  allRemaining,
  refundableLines,
  refundPreview,
  setRefundQty,
  type RefundQuantities,
} from './refundSelection';
import { PAYMENT_METHOD_LABELS } from './SaleDetail';

interface RefundFormProps {
  readonly sale: Sale;
  /** True while a record is being sent. */
  readonly isRecording: boolean;
  readonly onConfirm: (selections: readonly RefundSelection[], method: PaymentMethod) => void;
  readonly onCancel: () => void;
}

/** Units to refund per line, up to what is left of each, and how the money goes back. */
export function RefundForm({ sale, isRecording, onConfirm, onCancel }: RefundFormProps) {
  const [quantities, setQuantities] = useState<RefundQuantities>(() => new Map());
  // Money usually goes back the way it came.
  const [method, setMethod] = useState<PaymentMethod>(sale.paymentMethod);
  const preview = refundPreview(sale, quantities);

  const change = (lineNo: number, by: number) => {
    setQuantities((current) =>
      setRefundQty(sale, current, lineNo, (current.get(lineNo) ?? 0) + by),
    );
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <p className="font-semibold text-gray-900">Refund from {sale.receiptNumber}</p>
        <Button variant="outline" size="sm" onClick={() => setQuantities(allRemaining(sale))}>
          Everything left
        </Button>
      </div>

      <div className="space-y-2">
        {refundableLines(sale).map(({ line, remainingQty, remainingMillimes }) => {
          const qty = Math.min(quantities.get(line.lineNo) ?? 0, remainingQty);
          return (
            <div key={line.lineNo} className="flex items-center gap-2 p-2 bg-gray-50 rounded-lg">
              <div className="flex-1">
                <p className="font-medium text-sm">{line.productName}</p>
                <p className="text-xs text-gray-600">
                  {remainingQty} of {line.qty} left &middot; {formatTND(remainingMillimes)}
                </p>
              </div>
              <div className="flex items-center gap-1">
                <Button
                  size="sm"
                  variant="outline"
                  aria-label={`Refund one less ${line.productName}`}
                  disabled={qty === 0}
                  onClick={() => change(line.lineNo, -1)}
                >
                  <Minus className="w-3 h-3" />
                </Button>
                <span className="w-8 text-center font-bold">{qty}</span>
                <Button
                  size="sm"
                  variant="outline"
                  aria-label={`Refund one more ${line.productName}`}
                  disabled={qty >= remainingQty}
                  onClick={() => change(line.lineNo, 1)}
                >
                  <Plus className="w-3 h-3" />
                </Button>
              </div>
            </div>
          );
        })}
      </div>

      <div className="space-y-2">
        <p className="font-semibold">Paid back by:</p>
        <div className="grid grid-cols-2 gap-2">
          {paymentMethodSchema.options.map((option) => (
            <Button
              key={option}
              variant={method === option ? 'default' : 'outline'}
              onClick={() => setMethod(option)}
            >
              {PAYMENT_METHOD_LABELS[option]}
            </Button>
          ))}
        </div>
      </div>

      <div className="border-t pt-4 space-y-3">
        <div className="flex justify-between text-xl font-bold">
          <span>Refund total:</span>
          <span>{formatTND(preview.totalMillimes)}</span>
        </div>
        <Button
          className="w-full"
          size="lg"
          disabled={isRecording || preview.selections.length === 0}
          onClick={() => onConfirm(preview.selections, method)}
        >
          <Undo2 className="mr-2 h-4 w-4" />
          {isRecording ? 'Recording...' : 'Confirm refund'}
        </Button>
        <Button variant="outline" className="w-full" disabled={isRecording} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
