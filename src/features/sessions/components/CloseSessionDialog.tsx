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
import { readCashAmount } from '@/features/pos/selling';
import { useSales } from '@/features/sales/hooks/useSales';
import type { Millimes } from '@/lib/money';
import type { CashSession, ZReport } from '@/ports';
import { LOCAL_REPORT_LIMIT, localZReport } from './zReportView';

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
  /** True while a record is being sent. */
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
  isClosing,
  onConfirm,
}: Omit<CloseSessionDialogProps, 'open' | 'onOpenChange'>) {
  const [countedText, setCountedText] = useState('');
  const [showProblem, setShowProblem] = useState(false);
  const [isPreparing, setIsPreparing] = useState(false);
  const salesQuery = useSales({ sessionId: session.id, limit: LOCAL_REPORT_LIMIT });
  const counted = readCashAmount(countedText);
  const isBusy = isClosing || isPreparing;

  const submit = async () => {
    if (!counted.ok) {
      setShowProblem(true);
      return;
    }
    setIsPreparing(true);
    // The session's documents as they are now, for this device's own calculation of the report.
    const listed = await salesQuery.refetch();
    setIsPreparing(false);
    if (listed.isError) {
      console.error('Could not list the session to check its Z-report:', listed.error);
    }
    onConfirm({
      countedMillimes: counted.millimes,
      clientZReport: localZReport(
        session,
        listed.isSuccess ? listed.data : undefined,
        counted.millimes,
      ),
    });
  };

  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (!isBusy) {
          void submit();
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
      <Button type="submit" className="w-full" size="lg" disabled={isBusy}>
        <Lock className="mr-2 h-4 w-4" />
        {isBusy ? 'Closing...' : 'Close session'}
      </Button>
    </form>
  );
}
