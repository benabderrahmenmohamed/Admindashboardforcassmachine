import { Lock } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { queueState, sessionDocuments } from '@/features/pos/queue';
import { readCashAmount } from '@/features/pos/selling';
import type { OutboxRecord } from '@/features/sync/types';
import type { Millimes } from '@/lib/money';
import type { CashSession, ZReport } from '@/ports';
import { localZReport } from './zReportView';

/** What closing a session takes from the cashier and from this device. */
export interface SessionClose {
  readonly countedMillimes: Millimes;
  /** This device's own calculation of the report, or null when it could not make one. */
  readonly clientZReport: ZReport | null;
}

interface CloseSessionDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly session: CashSession;
  /** This device's queue, which holds every document it wrote in the session. */
  readonly records: readonly OutboxRecord[];
  /** True while the close is being written to this device. */
  readonly isClosing: boolean;
  readonly onConfirm: (close: SessionClose) => void;
}

export function CloseSessionDialog({ open, onOpenChange, ...form }: CloseSessionDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Close session</DialogTitle>
          <DialogDescription>
            Count the cash in the drawer and enter the total. Nothing can be recorded in the session
            once it is closed; its Z-report is shown next.
          </DialogDescription>
        </DialogHeader>
        {/* Mounted again on every opening: the count starts empty. */}
        <CloseSessionForm {...form} />
      </DialogContent>
    </Dialog>
  );
}

function CloseSessionForm({
  session,
  records,
  isClosing,
  onConfirm,
}: Omit<CloseSessionDialogProps, 'open' | 'onOpenChange'>) {
  const [countedText, setCountedText] = useState('');
  const [showProblem, setShowProblem] = useState(false);
  const counted = readCashAmount(countedText);
  const documents = sessionDocuments(records, session.id).length;
  const { pending } = queueState(records);

  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (!counted.ok) {
          setShowProblem(true);
        } else if (!isClosing) {
          // Counted from this device's own records, so the report is ready with or without network.
          onConfirm({
            countedMillimes: counted.millimes,
            clientZReport: localZReport(session, records, counted.millimes),
          });
        }
      }}
    >
      <div className="space-y-2">
        <Label htmlFor="counted-cash">Counted cash (DT)</Label>
        <Input
          id="counted-cash"
          inputMode="decimal"
          autoComplete="off"
          placeholder="0.000"
          value={countedText}
          onChange={(e) => setCountedText(e.target.value)}
          aria-invalid={showProblem && !counted.ok}
          className="text-lg"
        />
        {showProblem && !counted.ok && <p className="text-sm text-red-600">{counted.problem}</p>}
      </div>
      <p className="text-sm text-gray-600">
        {documents === 1 ? '1 document' : `${documents} documents`} recorded on this device in this
        session
        {pending > 0 && `, ${pending} still waiting to be sent`}.
      </p>
      <Button type="submit" className="w-full" size="lg" disabled={isClosing}>
        <Lock className="mr-2 h-4 w-4" />
        {isClosing ? 'Closing...' : 'Close session'}
      </Button>
    </form>
  );
}
