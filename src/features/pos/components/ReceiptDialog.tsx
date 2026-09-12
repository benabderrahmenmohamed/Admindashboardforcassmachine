import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { SyncBadge } from '@/features/sales/components/SyncBadge';
import { formatTND, neg, type Millimes } from '@/lib/money';
import { syncStatus, type NumberedRecord } from '../queue';
import { receiptOf, syncStatusMessage } from '../recording';

interface ReceiptDialogProps {
  /** The sale or refund as the queue holds it now; null until one has been written. */
  readonly record: NumberedRecord | null;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}

/**
 * The receipt, the moment it is written: its number, its lines and what was paid all come from the
 * record on this device, so it is on screen with no network at all. The line below it says where
 * the record stands and follows it as the queue moves.
 */
export function ReceiptDialog({ record, open, onOpenChange }: ReceiptDialogProps) {
  return (
    <Dialog open={open && record !== null} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {record ? receiptOf(record) : 'Receipt'}
            {record && <SyncBadge status={syncStatus(record)} />}
          </DialogTitle>
          <DialogDescription>
            {record ? syncStatusMessage(record) : 'No receipt yet.'}
          </DialogDescription>
        </DialogHeader>
        {record && <ReceiptBody record={record} />}
        <Button className="w-full" size="lg" onClick={() => onOpenChange(false)}>
          Done
        </Button>
      </DialogContent>
    </Dialog>
  );
}

function ReceiptBody({ record }: { readonly record: NumberedRecord }) {
  const { payload } = record;
  const isRefund = payload.kind === 'refund';
  // A refund is stored with negative amounts; a receipt shows what was handed back.
  const amount = (millimes: Millimes) => formatTND(isRefund ? neg(millimes) : millimes);

  return (
    <div className="space-y-4">
      <p className="text-sm text-gray-500">{new Date(payload.createdAt).toLocaleString()}</p>

      <ul className="divide-y rounded-lg border text-sm">
        {payload.lines.map((line) => (
          <li key={line.lineNo} className="flex items-start justify-between gap-4 px-3 py-2">
            <span>
              {line.productName}
              <span className="block text-xs text-gray-500">
                {Math.abs(line.qty)} × {formatTND(line.unitPriceMillimes)}
              </span>
            </span>
            <span className="text-right font-medium">{amount(line.lineTotalMillimes)}</span>
          </li>
        ))}
      </ul>

      <dl className="space-y-1 text-sm">
        {payload.discountMillimes !== 0 && (
          <>
            <ReceiptRow label="Subtotal" value={amount(payload.subtotalMillimes)} />
            <ReceiptRow label="Discount" value={amount(payload.discountMillimes)} />
          </>
        )}
        <ReceiptRow
          label={isRefund ? 'Refunded' : 'Total'}
          value={amount(payload.totalMillimes)}
          strong
        />
        <ReceiptRow label="Paid by" value={payload.payment.method === 'cash' ? 'Cash' : 'Card'} />
        {!isRefund && payload.payment.method === 'cash' && (
          <>
            <ReceiptRow label="Tendered" value={formatTND(payload.payment.tenderedMillimes)} />
            <ReceiptRow label="Change" value={formatTND(payload.payment.changeMillimes)} />
          </>
        )}
      </dl>
    </div>
  );
}

function ReceiptRow({
  label,
  value,
  strong = false,
}: {
  readonly label: string;
  readonly value: string;
  readonly strong?: boolean;
}) {
  return (
    <div className={`flex justify-between ${strong ? 'text-lg font-bold' : ''}`}>
      <dt className={strong ? '' : 'text-gray-600'}>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}
