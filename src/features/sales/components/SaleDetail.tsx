import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { formatTND } from '@/lib/money';
import type { PaymentMethod, RecordKind, Sale } from '../types';

export const PAYMENT_METHOD_LABELS: Record<PaymentMethod, string> = {
  cash: 'Cash',
  card: 'Card',
};

export function KindBadge({ kind }: { readonly kind: RecordKind }) {
  return kind === 'refund' ? (
    <Badge variant="destructive">Refund</Badge>
  ) : (
    <Badge variant="secondary">Sale</Badge>
  );
}

interface SaleDetailProps {
  readonly sale: Sale;
  /** Opens another document: the sale a refund pays back. */
  readonly onOpenSale: (saleId: string) => void;
}

/** A sale or refund as the ledger holds it, with how much of each sale line was refunded since. */
export function SaleDetail({ sale, onOpenSale }: SaleDetailProps) {
  const isRefund = sale.kind === 'refund';
  const refundsSaleId = sale.refundsSaleId;

  return (
    <div className="space-y-4">
      <div>
        <p className="flex items-center gap-2 text-xl font-bold text-gray-900">
          {sale.receiptNumber}
          <KindBadge kind={sale.kind} />
        </p>
        <p className="text-sm text-gray-500">{new Date(sale.createdAt).toLocaleString()}</p>
        {refundsSaleId !== null && (
          <Button variant="link" className="h-auto p-0" onClick={() => onOpenSale(refundsSaleId)}>
            View the refunded sale
          </Button>
        )}
      </div>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Product</TableHead>
            <TableHead className="text-right">Qty</TableHead>
            <TableHead className="text-right">Price</TableHead>
            <TableHead className="text-right">Total</TableHead>
            {!isRefund && <TableHead className="text-right">Refunded</TableHead>}
          </TableRow>
        </TableHeader>
        <TableBody>
          {sale.lines.map((line) => (
            <TableRow key={line.lineNo}>
              <TableCell className="whitespace-normal">{line.productName}</TableCell>
              <TableCell className="text-right">{line.qty}</TableCell>
              <TableCell className="text-right">{formatTND(line.unitPriceMillimes)}</TableCell>
              <TableCell className="text-right">{formatTND(line.lineTotalMillimes)}</TableCell>
              {!isRefund && (
                <TableCell className="text-right">
                  {line.refundedQty === 0
                    ? '0'
                    : `${line.refundedQty} (${formatTND(line.refundedMillimes)})`}
                </TableCell>
              )}
            </TableRow>
          ))}
        </TableBody>
      </Table>

      <dl className="space-y-1 text-sm">
        {sale.discountMillimes !== 0 && (
          <>
            <DetailRow label="Subtotal" value={formatTND(sale.subtotalMillimes)} />
            <DetailRow label="Discount" value={formatTND(sale.discountMillimes)} />
          </>
        )}
        <DetailRow
          label={isRefund ? 'Refund total' : 'Total'}
          value={formatTND(sale.totalMillimes)}
          strong
        />
        <DetailRow label="Payment" value={PAYMENT_METHOD_LABELS[sale.paymentMethod]} />
        {!isRefund && sale.paymentMethod === 'cash' && (
          <>
            <DetailRow label="Tendered" value={formatTND(sale.tenderedMillimes)} />
            <DetailRow label="Change" value={formatTND(sale.changeMillimes)} />
          </>
        )}
      </dl>
    </div>
  );
}

function DetailRow({
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
