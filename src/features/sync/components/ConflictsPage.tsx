import { ArrowLeft, CheckCircle2, Clock, RefreshCw, Trash2, TriangleAlert } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useCurrentUser } from '@/features/auth/hooks/useAuth';
import type { NumberedRecord } from '@/features/pos/queue';
import { voidQuestion } from '@/features/pos/recording';
import { useVoidReceipt } from '@/features/sales/hooks/useSales';
import { errorMessage } from '@/lib/errors';
import { useOutbox, useOutboxRecords, useOutboxSummary } from '../hooks/useOutbox';
import { conflictRows, type ConflictRow } from './conflictView';

/**
 * The queue of this device where it has stopped: the record the server refused, everything held up
 * behind it, and the two ways out. A cashier can send a record again once the cause is gone; an
 * admin can also give up on a numbered one, which spends its receipt number on a void row and lets
 * the rest through. Both roles see this device's queue only.
 */
export function ConflictsPage({ home }: { readonly home: string }) {
  const user = useCurrentUser();
  const { outbox, drain } = useOutbox();
  const rows = conflictRows(useOutboxRecords());
  const summary = useOutboxSummary();
  const voidReceipt = useVoidReceipt();
  const [voiding, setVoiding] = useState<NumberedRecord | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const retry = async (row: ConflictRow) => {
    setBusyId(row.id);
    try {
      await outbox.retry(row.id);
      drain();
      toast.success('Sending it again');
    } catch (error) {
      toast.error(errorMessage(error, 'That record could not be sent again'));
    } finally {
      setBusyId(null);
    }
  };

  const confirmVoid = async (record: NumberedRecord, reason: string) => {
    setBusyId(record.id);
    try {
      const result = await voidReceipt.mutateAsync({
        record: record.payload,
        errorCode: record.lastError?.code ?? 'UNKNOWN',
        reason,
      });
      // What the server said is what the record becomes: a void it accepted, or the record itself
      // if it turns out the ledger had it all along.
      await outbox.resolveVoid(record.id, {
        status: result.status,
        receiptNumber: result.receiptNumber,
      });
      drain();
      setVoiding(null);
      toast.success(
        result.status === 'recorded'
          ? `Receipt ${result.receiptNumber} had reached the ledger after all, so it stands.`
          : `Receipt ${result.receiptNumber} was voided.`,
      );
    } catch (error) {
      toast.error(errorMessage(error, 'The receipt could not be voided'));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="max-w-3xl mx-auto space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Conflicts</h1>
          <p className="text-sm text-gray-600">
            Records this device wrote that the server will not take as they are.
          </p>
        </div>
        <Button variant="outline" asChild>
          <Link to={home}>
            <ArrowLeft className="mr-2 h-4 w-4" />
            Back
          </Link>
        </Button>
      </div>

      {rows.length === 0 ? (
        <NothingStuck pending={summary.pending} />
      ) : (
        rows.map((row) => (
          <ConflictCard
            key={row.id}
            row={row}
            isBusy={busyId !== null}
            canVoid={user.role === 'admin'}
            onRetry={() => void retry(row)}
            onVoid={() => setVoiding(row.voidable)}
          />
        ))
      )}

      {voiding && (
        /* Mounted again on every opening: the reason starts empty. */
        <VoidDialog
          record={voiding}
          isVoiding={busyId === voiding.id}
          onCancel={() => setVoiding(null)}
          onConfirm={(reason) => void confirmVoid(voiding, reason)}
        />
      )}
    </div>
  );
}

function NothingStuck({ pending }: { readonly pending: number }) {
  return (
    <div className="flex flex-col items-center justify-center h-64 text-center px-4">
      <CheckCircle2 className="w-12 h-12 text-green-500 mb-4" />
      <p className="font-semibold text-gray-900 mb-1">Nothing needs a decision</p>
      <p className="text-sm text-gray-600 max-w-md">
        {pending === 0
          ? 'Every record written on this device has reached the server.'
          : `${pending} ${pending === 1 ? 'record is' : 'records are'} still on the way; they go out on their own.`}
      </p>
    </div>
  );
}

interface ConflictCardProps {
  readonly row: ConflictRow;
  /** True while any record on this screen is being acted on. */
  readonly isBusy: boolean;
  readonly canVoid: boolean;
  readonly onRetry: () => void;
  readonly onVoid: () => void;
}

function ConflictCard({ row, isBusy, canVoid, onRetry, onVoid }: ConflictCardProps) {
  const blocked = row.status === 'conflict';

  return (
    <Card className={blocked ? 'border-red-200' : undefined}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          {blocked ? (
            <TriangleAlert className="w-5 h-5 text-red-600" />
          ) : (
            <Clock className="w-5 h-5 text-amber-600" />
          )}
          {row.receipt ? `${row.kindLabel} ${row.receipt}` : row.kindLabel}
        </CardTitle>
        <CardDescription>{row.summary}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <p
          className={`rounded-lg border p-3 text-sm ${
            blocked
              ? 'border-red-200 bg-red-50 text-red-700'
              : 'border-amber-200 bg-amber-50 text-amber-900'
          }`}
        >
          {row.message}
        </p>

        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-4">
          <Fact label="State" value={row.statusLabel} />
          <Fact label="Error" value={row.errorCode ?? 'None yet'} />
          <Fact label="Attempts" value={String(row.attempts)} />
          <Fact label="Written" value={new Date(row.writtenAt).toLocaleString()} />
        </dl>
        <p className="text-xs text-gray-500">Session {row.sessionId}</p>

        {blocked && (
          <div className="flex flex-col gap-2 sm:flex-row">
            <Button className="flex-1" disabled={isBusy} onClick={onRetry}>
              <RefreshCw className="mr-2 h-4 w-4" />
              Send again
            </Button>
            {canVoid && row.voidable && (
              <Button variant="outline" disabled={isBusy} onClick={onVoid}>
                <Trash2 className="mr-2 h-4 w-4 text-red-600" />
                Void receipt
              </Button>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function Fact({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div>
      <dt className="text-gray-500">{label}</dt>
      <dd className="font-semibold text-gray-900">{value}</dd>
    </div>
  );
}

interface VoidDialogProps {
  readonly record: NumberedRecord;
  readonly isVoiding: boolean;
  readonly onCancel: () => void;
  readonly onConfirm: (reason: string) => void;
}

/** Admin only: gives up on a numbered record, on the record, with a reason that is kept. */
function VoidDialog({ record, isVoiding, onCancel, onConfirm }: VoidDialogProps) {
  const [reason, setReason] = useState('');
  const [showProblem, setShowProblem] = useState(false);
  const trimmed = reason.trim();

  return (
    <Dialog open onOpenChange={(open) => !open && onCancel()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Void this receipt</DialogTitle>
          <DialogDescription>{voidQuestion(record)}</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (trimmed === '') {
              setShowProblem(true);
              return;
            }
            if (!isVoiding) {
              onConfirm(trimmed);
            }
          }}
        >
          <div className="space-y-2">
            <Label htmlFor="void-reason">Why is it being voided?</Label>
            <Input
              id="void-reason"
              autoComplete="off"
              placeholder="The session had already been closed"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              aria-invalid={showProblem && trimmed === ''}
            />
            {showProblem && trimmed === '' && (
              <p className="text-sm text-red-600">Say why this receipt is being voided</p>
            )}
          </div>
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button type="button" variant="outline" disabled={isVoiding} onClick={onCancel}>
              Cancel
            </Button>
            <Button type="submit" disabled={isVoiding}>
              {isVoiding ? 'Voiding...' : 'Void receipt'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
