import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { LoadingState } from '@/components/feedback';
import { TableBoard } from '@/features/orders/components/TableBoard';
import { useTables } from '@/features/orders/hooks/useOrders';
import { ReceiptDialog } from '@/features/pos/components/ReceiptDialog';
import type { RegisterHandle } from '@/features/pos/hooks/useRegister';
import { findRecord, isNumbered } from '@/features/pos/queue';
import type { CheckoutPayment } from '@/features/pos/types';
import { SalesSheet } from '@/features/sales/components/SalesSheet';
import type { RefundSelection } from '@/features/sales/types';
import {
  CloseSessionDialog,
  type SessionClose,
} from '@/features/sessions/components/CloseSessionDialog';
import { SessionBar } from '@/features/sessions/components/SessionBar';
import type { TerminalMeta, OutboxRecord } from '@/features/sync/types';
import { queryKeys } from '@/lib/query';
import type { CashSession, PaymentMethod, Sale } from '@/ports';
import type { Cart } from '../cart';
import { TablePayment } from './TablePayment';

interface CaisseScreenProps {
  readonly terminal: TerminalMeta;
  readonly session: CashSession;
  /** This device's queue, in ordinal order. */
  readonly records: readonly OutboxRecord[];
  readonly register: RegisterHandle;
  /** The close this screen wrote; the page shows its Z-report as this screen goes away. */
  readonly onClosed: (record: OutboxRecord) => void;
}

/**
 * The counter while a session is open: the room on the left, the table being paid on the right, and
 * the session bar, sales sheet and closing that the register has always had.
 *
 * A payment goes into this device's queue and comes back at once, so nothing here waits on the
 * network — and the receipt shows with the number this terminal allocated for it.
 */
export function CaisseScreen({
  terminal,
  session,
  records,
  register,
  onClosed,
}: CaisseScreenProps) {
  const tablesQuery = useTables();
  const queryClient = useQueryClient();
  const [tableId, setTableId] = useState<string | null>(null);
  const [isSalesOpen, setIsSalesOpen] = useState(false);
  const [isCloseOpen, setIsCloseOpen] = useState(false);
  const [receiptId, setReceiptId] = useState<string | null>(null);
  const [isReceiptOpen, setIsReceiptOpen] = useState(false);
  // Read back from the queue on every render, so the receipt on screen follows its record.
  const written = findRecord(records, receiptId);
  const receipt = written && isNumbered(written) ? written : null;
  const table = tablesQuery.data?.find((candidate) => candidate.id === tableId) ?? null;

  const pay = async ({
    cart,
    payment,
  }: {
    readonly cart: Cart;
    readonly payment: CheckoutPayment;
    readonly itemIds: readonly string[];
  }): Promise<boolean> => {
    if (table === null) {
      return false;
    }
    // Every line names the row of this table it pays, so the server can check the table has not
    // moved and mark exactly those rows paid; `itemIds` is the same set, for the caller.
    const record = await register.sell(session.id, table.id, cart, payment);
    if (!record) {
      return false;
    }
    // The rows this paid are no longer owed, and the order closes when none is left: the grid and
    // the table on screen both have to be read again.
    void queryClient.invalidateQueries({ queryKey: queryKeys.tables });
    setReceiptId(record.id);
    setIsReceiptOpen(true);
    return true;
  };

  const refund = async (
    sale: Sale,
    selections: readonly RefundSelection[],
    method: PaymentMethod,
  ): Promise<boolean> => {
    // The sheet goes back to the sale, which shows the units this refund took back straight away.
    return (await register.refund(session.id, sale, selections, method)) !== null;
  };

  const close = async (value: SessionClose) => {
    const record = await register.closeSession({ sessionId: session.id, ...value });
    if (record) {
      setIsCloseOpen(false);
      onClosed(record);
    }
  };

  return (
    <>
      <SessionBar
        terminalCode={terminal.code}
        session={session}
        isRecording={register.isWriting}
        onShowSales={() => setIsSalesOpen(true)}
        onCloseSession={() => setIsCloseOpen(true)}
      />

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2">
          <TableBoard selectedTableId={tableId} onSelect={setTableId} />
        </div>
        <div>
          {tablesQuery.isPending ? (
            <LoadingState />
          ) : table === null ? (
            <p className="p-4 text-sm text-gray-600 border border-dashed border-gray-300 rounded-lg">
              Choose a table to take payment for it. A table can be paid in parts: tick only the
              items being paid for and the rest stays on the table.
            </p>
          ) : (
            <TablePayment table={table} onPay={pay} isRecording={register.isWriting} />
          )}
        </div>
      </div>

      <ReceiptDialog record={receipt} open={isReceiptOpen} onOpenChange={setIsReceiptOpen} />

      <SalesSheet
        open={isSalesOpen}
        onOpenChange={setIsSalesOpen}
        terminal={terminal}
        records={records}
        isRecording={register.isWriting}
        onRefund={refund}
      />

      <CloseSessionDialog
        open={isCloseOpen}
        onOpenChange={setIsCloseOpen}
        session={session}
        records={records}
        isClosing={register.isWriting}
        onConfirm={(value) => void close(value)}
      />
    </>
  );
}
