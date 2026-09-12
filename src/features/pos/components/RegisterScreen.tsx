import { useState } from 'react';
import { SalesSheet } from '@/features/sales/components/SalesSheet';
import type { RefundSelection } from '@/features/sales/types';
import {
  CloseSessionDialog,
  type SessionClose,
} from '@/features/sessions/components/CloseSessionDialog';
import { SessionBar } from '@/features/sessions/components/SessionBar';
import type { OutboxMeta, OutboxRecord } from '@/features/sync/types';
import type { CashSession, PaymentMethod, Sale } from '@/ports';
import { emptyCart } from '../cart';
import type { RegisterHandle } from '../hooks/useRegister';
import { findRecord, isNumbered } from '../queue';
import type { Cart, CheckoutPayment } from '../types';
import { ReceiptDialog } from './ReceiptDialog';
import { SellingScreen } from './SellingScreen';

interface RegisterScreenProps {
  readonly terminal: OutboxMeta;
  readonly session: CashSession;
  /** This device's queue, in ordinal order. */
  readonly records: readonly OutboxRecord[];
  readonly register: RegisterHandle;
  readonly cart: Cart;
  readonly onCartChange: (cart: Cart) => void;
  /** The close this screen wrote; the page shows its Z-report as this screen goes away. */
  readonly onClosed: (record: OutboxRecord) => void;
}

/**
 * The register while a session is open: the session bar, selling, the sales sheet and closing.
 * Every write goes into the queue and comes back at once, so nothing here waits on the network.
 */
export function RegisterScreen({
  terminal,
  session,
  records,
  register,
  cart,
  onCartChange,
  onClosed,
}: RegisterScreenProps) {
  const [isSalesOpen, setIsSalesOpen] = useState(false);
  const [isCloseOpen, setIsCloseOpen] = useState(false);
  const [receiptId, setReceiptId] = useState<string | null>(null);
  const [isReceiptOpen, setIsReceiptOpen] = useState(false);
  // Read back from the queue on every render, so the receipt on screen follows its record.
  const written = findRecord(records, receiptId);
  const receipt = written && isNumbered(written) ? written : null;

  const checkout = async (payment: CheckoutPayment): Promise<boolean> => {
    const record = await register.sell(session.id, cart, payment);
    if (!record) {
      return false;
    }
    onCartChange(emptyCart);
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

      <SellingScreen
        cart={cart}
        onCartChange={onCartChange}
        onCheckout={checkout}
        isRecording={register.isWriting}
      />

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
