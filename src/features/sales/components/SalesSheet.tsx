import { ArrowLeft, Receipt, Undo2 } from 'lucide-react';
import { useState } from 'react';
import { ErrorState, LoadingState } from '@/components/feedback';
import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { useSale, useSales } from '@/features/sales/hooks/useSales';
import { errorMessage } from '@/lib/errors';
import { formatTND } from '@/lib/money';
import type { PaymentMethod, RefundSelection, Sale } from '../types';
import { RefundForm } from './RefundForm';
import { canRefund } from './refundSelection';
import { KindBadge, PAYMENT_METHOD_LABELS, SaleDetail } from './SaleDetail';

/** How many of the terminal's latest documents the sheet lists. */
const RECENT_SALES_LIMIT = 50;

type View =
  | { readonly name: 'list' }
  | { readonly name: 'detail'; readonly saleId: string }
  | { readonly name: 'refund'; readonly saleId: string };

interface SalesSheetProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly terminalId: string;
  /** True while a record is being sent. */
  readonly isRecording: boolean;
  /** Records a refund of `sale`; resolves true once the server has answered it. */
  readonly onRefund: (
    sale: Sale,
    selections: readonly RefundSelection[],
    method: PaymentMethod,
  ) => Promise<boolean>;
}

export function SalesSheet({ open, onOpenChange, ...body }: SalesSheetProps) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full sm:max-w-lg overflow-y-auto">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            <Receipt className="w-5 h-5" />
            Sales
          </SheetTitle>
          <SheetDescription>
            Recent sales and refunds of this terminal, newest first.
          </SheetDescription>
        </SheetHeader>
        {/* Mounted again on every opening, so the sheet starts at the list. */}
        <SalesSheetBody {...body} />
      </SheetContent>
    </Sheet>
  );
}

function SalesSheetBody({
  terminalId,
  isRecording,
  onRefund,
}: Omit<SalesSheetProps, 'open' | 'onOpenChange'>) {
  const [view, setView] = useState<View>({ name: 'list' });

  switch (view.name) {
    case 'list':
      return (
        <SalesList
          terminalId={terminalId}
          onSelect={(saleId) => setView({ name: 'detail', saleId })}
        />
      );
    case 'detail':
      return (
        <SaleView
          saleId={view.saleId}
          isRecording={isRecording}
          onBack={() => setView({ name: 'list' })}
          onOpenSale={(saleId) => setView({ name: 'detail', saleId })}
          onRefund={() => setView({ name: 'refund', saleId: view.saleId })}
        />
      );
    case 'refund':
      return (
        <RefundView
          saleId={view.saleId}
          isRecording={isRecording}
          onRefund={onRefund}
          onDone={() => setView({ name: 'detail', saleId: view.saleId })}
        />
      );
  }
}

function SalesList({
  terminalId,
  onSelect,
}: {
  readonly terminalId: string;
  readonly onSelect: (saleId: string) => void;
}) {
  const salesQuery = useSales({ terminalId, limit: RECENT_SALES_LIMIT });

  if (salesQuery.isPending) {
    return <LoadingState />;
  }
  if (salesQuery.isLoadingError) {
    return (
      <ErrorState
        title="Failed to load sales"
        error={salesQuery.error}
        onRetry={() => void salesQuery.refetch()}
      />
    );
  }

  return (
    <div className="px-4 pb-4">
      {salesQuery.isRefetchError && (
        <p role="alert" className="mb-2 text-sm text-red-600">
          {errorMessage(salesQuery.error, 'Failed to refresh sales')}
        </p>
      )}
      {salesQuery.data.length === 0 ? (
        <p className="text-center text-gray-500 py-8">No sales on this terminal yet</p>
      ) : (
        <ul className="divide-y rounded-lg border">
          {salesQuery.data.map((sale) => (
            <li key={sale.id}>
              <button
                type="button"
                className="w-full flex items-center justify-between gap-3 px-3 py-3 text-left hover:bg-gray-50"
                onClick={() => onSelect(sale.id)}
              >
                <div>
                  <p className="flex items-center gap-2 font-semibold text-gray-900">
                    {sale.receiptNumber}
                    <KindBadge kind={sale.kind} />
                  </p>
                  <p className="text-xs text-gray-500">
                    {new Date(sale.createdAt).toLocaleString()} &middot;{' '}
                    {PAYMENT_METHOD_LABELS[sale.paymentMethod]}
                  </p>
                </div>
                <span className="font-bold">{formatTND(sale.totalMillimes)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function SaleView({
  saleId,
  isRecording,
  onBack,
  onOpenSale,
  onRefund,
}: {
  readonly saleId: string;
  readonly isRecording: boolean;
  readonly onBack: () => void;
  readonly onOpenSale: (saleId: string) => void;
  readonly onRefund: () => void;
}) {
  const saleQuery = useSale(saleId);

  return (
    <div className="px-4 pb-4 space-y-4">
      <Button variant="ghost" size="sm" onClick={onBack}>
        <ArrowLeft className="mr-2 h-4 w-4" />
        All sales
      </Button>
      {saleQuery.isPending ? (
        <LoadingState />
      ) : saleQuery.isLoadingError ? (
        <ErrorState
          title="Failed to load the sale"
          error={saleQuery.error}
          onRetry={() => void saleQuery.refetch()}
        />
      ) : (
        <>
          {saleQuery.isRefetchError && (
            <p role="alert" className="text-sm text-red-600">
              {errorMessage(saleQuery.error, 'Failed to refresh the sale')}
            </p>
          )}
          <SaleDetail sale={saleQuery.data} onOpenSale={onOpenSale} />
          {saleQuery.data.kind === 'sale' && (
            <Button
              className="w-full"
              size="lg"
              disabled={isRecording || !canRefund(saleQuery.data)}
              onClick={onRefund}
            >
              <Undo2 className="mr-2 h-4 w-4" />
              {canRefund(saleQuery.data) ? 'Refund' : 'Fully refunded'}
            </Button>
          )}
        </>
      )}
    </div>
  );
}

function RefundView({
  saleId,
  isRecording,
  onRefund,
  onDone,
}: {
  readonly saleId: string;
  readonly isRecording: boolean;
  readonly onRefund: SalesSheetProps['onRefund'];
  readonly onDone: () => void;
}) {
  const saleQuery = useSale(saleId);

  if (saleQuery.isPending) {
    return <LoadingState />;
  }
  if (saleQuery.isLoadingError) {
    return (
      <ErrorState
        title="Failed to load the sale"
        error={saleQuery.error}
        onRetry={() => void saleQuery.refetch()}
      />
    );
  }

  const sale = saleQuery.data;
  const confirm = async (selections: readonly RefundSelection[], method: PaymentMethod) => {
    // Back to the sale, which reloads with the refunded units.
    if (await onRefund(sale, selections, method)) {
      onDone();
    }
  };

  return (
    <div className="px-4 pb-4 space-y-4">
      {/* The form offers what the cached sale says is left, so say when that reading is stale. */}
      {saleQuery.isRefetchError && (
        <p role="alert" className="text-sm text-red-600">
          {errorMessage(saleQuery.error, 'Failed to refresh the sale')}
        </p>
      )}
      <RefundForm
        sale={sale}
        isRecording={isRecording}
        onConfirm={(selections, method) => void confirm(selections, method)}
        onCancel={onDone}
      />
    </div>
  );
}
