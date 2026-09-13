import {
  Archive,
  ArrowLeft,
  CheckCircle2,
  Clock,
  RefreshCw,
  Trash2,
  TriangleAlert,
} from 'lucide-react';
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
import { hasRole } from '@/ports';
import { useOutbox, useOutboxRecords, useOutboxSummary } from '../hooks/useOutbox';
import { conflictRows, deadLetterRows, type ConflictRow } from './conflictView';
import { DeadLetterList } from './DeadLetters';
import { useRecordNames } from './useRecordNames';

/**
 * The queue of this device where it has stopped: the record the server refused, everything held up
 * behind it, and the ways out. Anyone can send a record again once the cause is gone. Anyone can give
 * up on an order record, saying why, because a stale item on a table the caisse already closed must
 * not block a waiter's phone for ever; it then joins the dead-letter list below. Only an admin can
 * void a numbered record, which spends its receipt number on a void row. A sale is never discarded.
 *
 * Mobile first, with 44 px targets, on every face: the same screen opens on a phone in the room.
 */
export function ConflictsPage({ home }: { readonly home: string }) {
  const user = useCurrentUser();
  const { outbox, drain } = useOutbox();
  const records = useOutboxRecords();
  const names = useRecordNames(records);
  const rows = conflictRows(records, names);
  const deadLetters = deadLetterRows(records, user, names);
  const summary = useOutboxSummary();
  const voidReceipt = useVoidReceipt();
  const [voiding, setVoiding] = useState<NumberedRecord | null>(null);
  const [discarding, setDiscarding] = useState<ConflictRow | null>(null);
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

  const confirmDiscard = async (row: ConflictRow, reason: string) => {
    setBusyId(row.id);
    try {
      // The outbox keeps who gave up on it, by name: the admin reads the dead-letter list later, and
      // may read it on a phone that has no list of the shop's people to look an account up in.
      await outbox.discard(row.id, { reason, discardedBy: user.id, discardedByName: user.name });
      drain();
      setDiscarding(null);
      toast.success('Discarded. The records behind it are on their way.');
    } catch (error) {
      toast.error(errorMessage(error, 'That record could not be discarded'));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Conflicts</h1>
          <p className="text-sm text-gray-600">
            Records this device wrote that the server will not take as they are.
          </p>
        </div>
        <Button variant="outline" className="min-h-11 shrink-0" asChild>
          <Link to={home}>
            <ArrowLeft className="h-4 w-4" />
            Back
          </Link>
        </Button>
      </div>

      <section aria-label="Records the queue is stopped at" className="space-y-4">
        {rows.length === 0 ? (
          <NothingStuck pending={summary.pending} />
        ) : (
          rows.map((row) => (
            <ConflictCard
              key={row.id}
              row={row}
              isBusy={busyId !== null}
              canVoid={hasRole(user, ['admin'])}
              onRetry={() => void retry(row)}
              onDiscard={() => setDiscarding(row)}
              onVoid={() => setVoiding(row.voidable)}
            />
          ))
        )}
      </section>

      {deadLetters.length > 0 && (
        <section aria-labelledby="dead-letters-title" className="space-y-3">
          <div>
            <h2
              id="dead-letters-title"
              className="flex items-center gap-2 text-lg font-semibold text-gray-900"
            >
              <Archive className="h-5 w-5 text-gray-500" aria-hidden="true" />
              Discarded on this device
            </h2>
            <p className="text-sm text-gray-600">
              Order records that stopped the queue and were given up on, with the reason. What they
              would have done to a table may never have happened, so they stay on this device for
              the admin to see.
            </p>
          </div>
          <DeadLetterList rows={deadLetters} />
        </section>
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

      {discarding && (
        /* Mounted again on every opening, like the void: one record's reason is never another's. */
        <DiscardDialog
          row={discarding}
          isDiscarding={busyId === discarding.id}
          onCancel={() => setDiscarding(null)}
          onConfirm={(reason) => void confirmDiscard(discarding, reason)}
        />
      )}
    </div>
  );
}

function NothingStuck({ pending }: { readonly pending: number }) {
  return (
    <div className="flex flex-col items-center justify-center py-10 text-center px-4">
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
  readonly onDiscard: () => void;
  readonly onVoid: () => void;
}

function ConflictCard({ row, isBusy, canVoid, onRetry, onDiscard, onVoid }: ConflictCardProps) {
  const blocked = row.status === 'conflict';

  return (
    <Card className={blocked ? 'border-red-200' : undefined}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          {blocked ? (
            <TriangleAlert className="w-5 h-5 shrink-0 text-red-600" />
          ) : (
            <Clock className="w-5 h-5 shrink-0 text-amber-600" />
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
        {row.sessionId !== null && <p className="text-xs text-gray-500">Session {row.sessionId}</p>}

        {blocked && (
          <div className="space-y-2">
            <div className="flex flex-col gap-2 sm:flex-row">
              <Button className="min-h-11 sm:flex-1" disabled={isBusy} onClick={onRetry}>
                <RefreshCw className="h-4 w-4" />
                Send again
              </Button>
              {row.discardable && (
                <Button
                  variant="outline"
                  className="min-h-11"
                  disabled={isBusy}
                  onClick={onDiscard}
                >
                  <Archive className="h-4 w-4 text-red-600" />
                  Discard
                </Button>
              )}
              {canVoid && row.voidable && (
                <Button variant="outline" className="min-h-11" disabled={isBusy} onClick={onVoid}>
                  <Trash2 className="h-4 w-4 text-red-600" />
                  Void receipt
                </Button>
              )}
            </div>
            {row.whyNoDiscard && <p className="text-sm text-gray-600">{row.whyNoDiscard}</p>}
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

interface ReasonFormProps {
  /** The input's id, so its label reads it out. */
  readonly id: string;
  readonly label: string;
  readonly placeholder: string;
  /** Shown when a person tries to go ahead without a reason. */
  readonly missing: string;
  readonly confirm: string;
  readonly confirming: string;
  readonly isConfirming: boolean;
  readonly onCancel: () => void;
  readonly onConfirm: (reason: string) => void;
}

/**
 * A reason, then the action. An empty reason is refused here and said out loud, rather than handed
 * to the outbox to refuse, so the dialog stays open with the problem next to the field.
 */
function ReasonForm({
  id,
  label,
  placeholder,
  missing,
  confirm,
  confirming,
  isConfirming,
  onCancel,
  onConfirm,
}: ReasonFormProps) {
  const [reason, setReason] = useState('');
  const [showProblem, setShowProblem] = useState(false);
  const trimmed = reason.trim();

  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (trimmed === '') {
          setShowProblem(true);
          return;
        }
        if (!isConfirming) {
          onConfirm(trimmed);
        }
      }}
    >
      <div className="space-y-2">
        <Label htmlFor={id}>{label}</Label>
        <Input
          id={id}
          className="min-h-11"
          autoComplete="off"
          placeholder={placeholder}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          aria-invalid={showProblem && trimmed === ''}
        />
        {showProblem && trimmed === '' && <p className="text-sm text-red-600">{missing}</p>}
      </div>
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button
          type="button"
          variant="outline"
          className="min-h-11"
          disabled={isConfirming}
          onClick={onCancel}
        >
          Cancel
        </Button>
        <Button type="submit" className="min-h-11" disabled={isConfirming}>
          {isConfirming ? confirming : confirm}
        </Button>
      </div>
    </form>
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
  return (
    <Dialog open onOpenChange={(open) => !open && onCancel()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Void this receipt</DialogTitle>
          <DialogDescription>{voidQuestion(record)}</DialogDescription>
        </DialogHeader>
        <ReasonForm
          id="void-reason"
          label="Why is it being voided?"
          placeholder="The session had already been closed"
          missing="Say why this receipt is being voided"
          confirm="Void receipt"
          confirming="Voiding..."
          isConfirming={isVoiding}
          onCancel={onCancel}
          onConfirm={onConfirm}
        />
      </DialogContent>
    </Dialog>
  );
}

interface DiscardDialogProps {
  readonly row: ConflictRow;
  readonly isDiscarding: boolean;
  readonly onCancel: () => void;
  readonly onConfirm: (reason: string) => void;
}

/** Gives up on an order record the table has overtaken. The reason goes with it to the admin. */
function DiscardDialog({ row, isDiscarding, onCancel, onConfirm }: DiscardDialogProps) {
  return (
    <Dialog open onOpenChange={(open) => !open && onCancel()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Discard this record</DialogTitle>
          <DialogDescription>
            <span className="block font-medium text-gray-900">{row.summary}</span>
            It is never sent again. It stays on this device in the discarded list with your reason,
            for the admin, and the records waiting behind it go out.
          </DialogDescription>
        </DialogHeader>
        <ReasonForm
          id="discard-reason"
          label="Why is it being discarded?"
          placeholder="The caisse had already closed the table"
          missing="Say why this record is being discarded"
          confirm="Discard"
          confirming="Discarding..."
          isConfirming={isDiscarding}
          onCancel={onCancel}
          onConfirm={onConfirm}
        />
      </DialogContent>
    </Dialog>
  );
}
