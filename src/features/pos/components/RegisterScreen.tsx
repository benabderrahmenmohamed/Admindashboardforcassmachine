import { useState } from 'react';
import { SalesSheet } from '@/features/sales/components/SalesSheet';
import { buildRefundRecord, buildSaleRecord, type RecordEnvelope } from '@/features/sales/records';
import type { RefundSelection } from '@/features/sales/types';
import {
  CloseSessionDialog,
  type SessionClose,
} from '@/features/sessions/components/CloseSessionDialog';
import { SessionBar } from '@/features/sessions/components/SessionBar';
import { buildCloseSessionRecord } from '@/features/sessions/records';
import type { StoredTerminal } from '@/features/terminal/terminalStore';
import type { CashSession, PaymentMethod, Sale } from '@/ports';
import type { RecorderHandle } from '../hooks/useRecorder';
import { newRecordId, nextSeq, terminalContext } from '../recording';
import type { Cart, CheckoutPayment } from '../types';
import { SellingScreen } from './SellingScreen';

interface RegisterScreenProps {
  readonly terminal: StoredTerminal;
  readonly session: CashSession;
  /** Who does the work recorded here: the signed-in cashier. */
  readonly actorUserId: string;
  readonly recorder: RecorderHandle;
  readonly cart: Cart;
  readonly onCartChange: (cart: Cart) => void;
}

/** The register while a session is open: the session bar, selling, the sales sheet and closing. */
export function RegisterScreen({
  terminal,
  session,
  actorUserId,
  recorder,
  cart,
  onCartChange,
}: RegisterScreenProps) {
  const [isSalesOpen, setIsSalesOpen] = useState(false);
  const [isCloseOpen, setIsCloseOpen] = useState(false);
  const isRecording = recorder.state.status === 'sending';

  // Sales and refunds share the terminal's receipt numbers. The number is taken when the record is
  // written and stays with it: a record whose send fails is resent, never renumbered.
  const envelope = (): RecordEnvelope => ({
    id: newRecordId(),
    seq: nextSeq(terminal),
    sessionId: session.id,
    createdAt: new Date().toISOString(),
    terminal: terminalContext(terminal),
  });

  const checkout = async (payment: CheckoutPayment): Promise<boolean> => {
    const outcome = await recorder.record(async () => ({
      type: 'sale',
      record: await buildSaleRecord(envelope(), cart, payment),
    }));
    return outcome !== null;
  };

  const refund = async (
    sale: Sale,
    selections: readonly RefundSelection[],
    method: PaymentMethod,
  ): Promise<boolean> => {
    const outcome = await recorder.record(async () => ({
      type: 'sale',
      record: await buildRefundRecord(envelope(), sale, selections, method),
    }));
    return outcome !== null;
  };

  const close = async ({ countedMillimes, clientZReport }: SessionClose) => {
    const outcome = await recorder.record(async () => ({
      type: 'session_close',
      record: await buildCloseSessionRecord({
        id: newRecordId(),
        sessionId: session.id,
        terminal: terminalContext(terminal),
        actorUserId,
        closedAt: new Date().toISOString(),
        closingCountedMillimes: countedMillimes,
        clientZReport,
      }),
    }));
    // The page shows the Z-report; this screen goes away with the session.
    if (outcome) {
      setIsCloseOpen(false);
    }
  };

  return (
    <>
      <SessionBar
        terminalCode={terminal.code}
        session={session}
        isRecording={isRecording}
        onShowSales={() => setIsSalesOpen(true)}
        onCloseSession={() => setIsCloseOpen(true)}
      />

      <SellingScreen
        cart={cart}
        onCartChange={onCartChange}
        onCheckout={checkout}
        isRecording={isRecording}
      />

      <SalesSheet
        open={isSalesOpen}
        onOpenChange={setIsSalesOpen}
        terminalId={terminal.terminalId}
        isRecording={isRecording}
        onRefund={refund}
      />

      <CloseSessionDialog
        open={isCloseOpen}
        onOpenChange={setIsCloseOpen}
        session={session}
        isClosing={isRecording}
        onConfirm={(value) => void close(value)}
      />
    </>
  );
}
