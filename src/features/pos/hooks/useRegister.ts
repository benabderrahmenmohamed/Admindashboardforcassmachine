import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import { buildRefundRecord, buildSaleRecord } from '@/features/sales/records';
import type { RefundSelection } from '@/features/sales/types';
import { buildCloseSessionRecord, buildOpenSessionRecord } from '@/features/sessions/records';
import { useOutbox } from '@/features/sync/hooks/useOutbox';
import type { OutboxRecord } from '@/features/sync/types';
import { terminalRegistrationKey } from '@/features/terminal/hooks/useTerminal';
import { errorMessage } from '@/lib/errors';
import type { Millimes } from '@/lib/money';
import type { PaymentMethod, Sale, ZReport } from '@/ports';
import { newRecordId, recordedMessage, terminalContext } from '../recording';
import type { Cart, CheckoutPayment } from '../types';

/** What closing a session takes from the cashier and from this device. */
export interface SessionClose {
  readonly sessionId: string;
  readonly countedMillimes: Millimes;
  /** This device's own calculation of the report, or null when it could not make one. */
  readonly clientZReport: ZReport | null;
}

export interface RegisterHandle {
  /** True while a record is being written to this device. Nothing here waits for the network. */
  readonly isWriting: boolean;
  /** `tableId` is the table being paid, or null for a counter sale with no table behind it. */
  readonly sell: (
    sessionId: string,
    tableId: string | null,
    cart: Cart,
    payment: CheckoutPayment,
  ) => Promise<OutboxRecord | null>;
  readonly refund: (
    sessionId: string,
    sale: Sale,
    selections: readonly RefundSelection[],
    method: PaymentMethod,
  ) => Promise<OutboxRecord | null>;
  readonly openSession: (openingFloatMillimes: Millimes) => Promise<OutboxRecord | null>;
  readonly closeSession: (close: SessionClose) => Promise<OutboxRecord | null>;
}

/**
 * Writes this device's records — sales, refunds, session open and close — into the outbox and
 * returns as soon as they are on the device. The receipt number is allocated inside that same
 * transaction, so the record and the number it took are stored together or not at all; the queue
 * then delivers it. Resolves to null when the record could not be written, which is reported with a
 * toast: nothing was numbered and nothing was recorded.
 */
export function useRegister(actorUserId: string): RegisterHandle {
  // Kept whole rather than destructured: `drain` is a method of the runtime, like a port's.
  const runtime = useOutbox();
  const queryClient = useQueryClient();
  const [isWriting, setIsWriting] = useState(false);

  const write = async (append: () => Promise<OutboxRecord>): Promise<OutboxRecord | null> => {
    setIsWriting(true);
    try {
      const record = await append();
      toast.success(recordedMessage(record));
      // The counters moved, and the Settings card reads the last receipt number off them.
      void queryClient.invalidateQueries({ queryKey: terminalRegistrationKey });
      runtime.drain();
      return record;
    } catch (error) {
      toast.error(errorMessage(error, 'This device could not record that. Try again.'));
      return null;
    } finally {
      setIsWriting(false);
    }
  };

  return {
    isWriting,

    sell: (sessionId, tableId, cart, payment) =>
      write(() =>
        runtime.outbox.appendSale('sale', ({ seq, meta }) =>
          buildSaleRecord(
            {
              id: newRecordId(),
              seq,
              sessionId,
              tableId,
              createdAt: new Date().toISOString(),
              terminal: terminalContext(meta),
            },
            cart,
            payment,
          ),
        ),
      ),

    refund: (sessionId, sale, selections, method) =>
      write(() =>
        runtime.outbox.appendSale('refund', ({ seq, meta }) =>
          buildRefundRecord(
            {
              id: newRecordId(),
              seq,
              sessionId,
              // A refund gives money back; it is not a payment of a table.
              tableId: null,
              createdAt: new Date().toISOString(),
              terminal: terminalContext(meta),
            },
            sale,
            selections,
            method,
          ),
        ),
      ),

    openSession: (openingFloatMillimes) =>
      write(() =>
        runtime.outbox.appendSessionOpen(({ meta }) =>
          buildOpenSessionRecord({
            id: newRecordId(),
            terminal: terminalContext(meta),
            actorUserId,
            openedAt: new Date().toISOString(),
            openingFloatMillimes,
          }),
        ),
      ),

    closeSession: ({ sessionId, countedMillimes, clientZReport }) =>
      write(() =>
        runtime.outbox.appendSessionClose(({ meta }) =>
          buildCloseSessionRecord({
            id: newRecordId(),
            sessionId,
            terminal: terminalContext(meta),
            actorUserId,
            closedAt: new Date().toISOString(),
            closingCountedMillimes: countedMillimes,
            clientZReport,
          }),
        ),
      ),
  };
}
