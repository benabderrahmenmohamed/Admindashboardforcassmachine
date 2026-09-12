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
import type { TerminalMeta, OutboxRecord } from '@/features/sync/types';
import { AppError, errorMessage } from '@/lib/errors';
import { formatTND } from '@/lib/money';
import type { PaymentMethod, RefundSelection, Sale } from '../types';
import { RefundForm } from './RefundForm';
import { canRefund } from './refundSelection';
import { KindBadge, PAYMENT_METHOD_LABELS, SaleDetail } from './SaleDetail';
import { findRow, mergeSales, type SaleRow } from './salesList';
import { SyncBadge } from './SyncBadge';

/** How many of the terminal's latest documents the sheet asks the server for. */
const RECENT_SALES_LIMIT = 50;

type View =
  | { readonly name: 'list' }
  | { readonly name: 'detail'; readonly saleId: string }
  | { readonly name: 'refund'; readonly saleId: string };

interface SalesSheetProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly terminal: TerminalMeta;
  /** This device's queue: what it wrote, sent or not. */
  readonly records: readonly OutboxRecord[];
  /** True while a record is being written to this device. */
  readonly isRecording: boolean;
  /** Records a refund of `sale`; resolves true once it is on this device. */
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
            Recent sales and refunds of this terminal, newest first, including the ones still on
            their way to the server.
          </SheetDescription>
        </SheetHeader>
        {/* Mounted again on every opening, so the sheet starts at the list. */}
        <SalesSheetBody {...body} />
      </SheetContent>
    </Sheet>
  );
}

function SalesSheetBody({
  terminal,
  records,
  isRecording,
  onRefund,
}: Omit<SalesSheetProps, 'open' | 'onOpenChange'>) {
  const [view, setView] = useState<View>({ name: 'list' });
  const salesQuery = useSales({ terminalId: terminal.terminalId, limit: RECENT_SALES_LIMIT });
  // Whatever the server answered, plus everything this device wrote that it has not taken yet: the
  // list is complete offline, because a document is on this device from the moment it is written.
  const rows = mergeSales(terminal, salesQuery.data ?? [], records);
  const offline = salesQuery.data === undefined;
  // Offline, TanStack pauses this query instead of failing it: it stays pending with no error, so
  // without this the list would spin for ever rather than say what is missing.
  const paused = salesQuery.fetchStatus === 'paused';
  const pausedError = paused
    ? new AppError(
        'NETWORK_ERROR',
        'The server cannot be reached, so sales recorded elsewhere are not shown. Everything this device wrote is here.',
      )
    : null;

  switch (view.name) {
    case 'list':
      return (
        <SalesList
          rows={rows}
          isPending={salesQuery.isPending && !paused}
          error={offline ? (salesQuery.error ?? pausedError) : null}
          onRetry={() => void salesQuery.refetch()}
          onSelect={(saleId) => setView({ name: 'detail', saleId })}
        />
      );
    case 'detail':
      return (
        <SaleView
          rows={rows}
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
          rows={rows}
          saleId={view.saleId}
          isRecording={isRecording}
          onRefund={onRefund}
          onDone={() => setView({ name: 'detail', saleId: view.saleId })}
        />
      );
  }
}

function SalesList({
  rows,
  isPending,
  error,
  onRetry,
  onSelect,
}: {
  readonly rows: readonly SaleRow[];
  readonly isPending: boolean;
  /** Why the server's list is missing, or null when it was read. */
  readonly error: unknown;
  readonly onRetry: () => void;
  readonly onSelect: (saleId: string) => void;
}) {
  if (isPending && rows.length === 0) {
    return <LoadingState />;
  }
  if (error !== null && rows.length === 0) {
    return <ErrorState title="Failed to load sales" error={error} onRetry={onRetry} />;
  }

  return (
    <div className="px-4 pb-4">
      {error !== null && (
        <p role="alert" className="mb-2 text-sm text-amber-700">
          Only the documents written on this device are listed:{' '}
          {errorMessage(error, 'the server could not be reached')}
        </p>
      )}
      {rows.length === 0 ? (
        <p className="text-center text-gray-500 py-8">No sales on this terminal yet</p>
      ) : (
        <ul className="divide-y rounded-lg border">
          {rows.map((row) => (
            <li key={row.sale.id}>
              <button
                type="button"
                className="w-full flex items-center justify-between gap-3 px-3 py-3 text-left hover:bg-gray-50"
                onClick={() => onSelect(row.sale.id)}
              >
                <div>
                  <p className="flex flex-wrap items-center gap-2 font-semibold text-gray-900">
                    {row.sale.receiptNumber}
                    <KindBadge kind={row.sale.kind} />
                    {row.syncStatus !== 'synced' && <SyncBadge status={row.syncStatus} />}
                  </p>
                  <p className="text-xs text-gray-500">
                    {new Date(row.sale.createdAt).toLocaleString()} &middot;{' '}
                    {PAYMENT_METHOD_LABELS[row.sale.paymentMethod]}
                  </p>
                </div>
                <span className="font-bold">{formatTND(row.sale.totalMillimes)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * One document. It comes from the list when the list has it, which covers everything this device
 * wrote; a sale named by a refund but older than the list is read from the server.
 */
function useSaleRow(
  rows: readonly SaleRow[],
  saleId: string,
): {
  readonly row: SaleRow | null;
  readonly isPending: boolean;
  readonly error: unknown;
  readonly refetch: () => void;
} {
  const known = findRow(rows, saleId);
  const saleQuery = useSale(known === null ? saleId : null);
  const fetched: SaleRow | null = saleQuery.data
    ? { sale: saleQuery.data, syncStatus: 'synced', record: null }
    : null;
  return {
    row: known ?? fetched,
    isPending: known === null && saleQuery.isPending,
    error: known === null ? saleQuery.error : null,
    refetch: () => void saleQuery.refetch(),
  };
}

function SaleView({
  rows,
  saleId,
  isRecording,
  onBack,
  onOpenSale,
  onRefund,
}: {
  readonly rows: readonly SaleRow[];
  readonly saleId: string;
  readonly isRecording: boolean;
  readonly onBack: () => void;
  readonly onOpenSale: (saleId: string) => void;
  readonly onRefund: () => void;
}) {
  const { row, isPending, error, refetch } = useSaleRow(rows, saleId);

  return (
    <div className="px-4 pb-4 space-y-4">
      <Button variant="ghost" size="sm" onClick={onBack}>
        <ArrowLeft className="mr-2 h-4 w-4" />
        All sales
      </Button>
      {isPending ? (
        <LoadingState />
      ) : row === null ? (
        <ErrorState title="Failed to load the sale" error={error} onRetry={refetch} />
      ) : (
        <>
          <SaleDetail sale={row.sale} syncStatus={row.syncStatus} onOpenSale={onOpenSale} />
          {row.sale.kind === 'sale' && (
            <Button
              className="w-full"
              size="lg"
              disabled={isRecording || !canRefund(row.sale)}
              onClick={onRefund}
            >
              <Undo2 className="mr-2 h-4 w-4" />
              {canRefund(row.sale) ? 'Refund' : 'Fully refunded'}
            </Button>
          )}
        </>
      )}
    </div>
  );
}

function RefundView({
  rows,
  saleId,
  isRecording,
  onRefund,
  onDone,
}: {
  readonly rows: readonly SaleRow[];
  readonly saleId: string;
  readonly isRecording: boolean;
  readonly onRefund: SalesSheetProps['onRefund'];
  readonly onDone: () => void;
}) {
  const { row, isPending, error, refetch } = useSaleRow(rows, saleId);

  if (isPending) {
    return <LoadingState />;
  }
  if (row === null) {
    return <ErrorState title="Failed to load the sale" error={error} onRetry={refetch} />;
  }

  const { sale } = row;
  const confirm = async (selections: readonly RefundSelection[], method: PaymentMethod) => {
    // Back to the sale, which now shows the units this refund took back.
    if (await onRefund(sale, selections, method)) {
      onDone();
    }
  };

  return (
    <div className="px-4 pb-4 space-y-4">
      {/* The sale may not have reached the server, so say what the refund is being built against. */}
      {row.syncStatus !== 'synced' && (
        <p className="text-sm text-amber-700">
          This sale is still on its way to the server. The refund is written behind it and reaches
          the server after it.
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
