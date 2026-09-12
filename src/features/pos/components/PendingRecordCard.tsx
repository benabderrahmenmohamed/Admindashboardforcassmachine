import { CloudOff, RefreshCw, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import type { PendingRecord } from '@/features/terminal/terminalStore';
import { canDiscard, describePending, recordErrorMessage, type RecorderState } from '../recording';

interface PendingRecordCardProps {
  readonly pending: PendingRecord;
  readonly state: RecorderState;
  readonly onRetry: () => void;
  /** Offered only once the server has refused the record (see canDiscard). */
  readonly onDiscard: () => void;
}

export function PendingRecordCard({ pending, state, onRetry, onDiscard }: PendingRecordCardProps) {
  const isSending = state.status === 'sending';
  // Only the answer to an attempt made on this visit is known: a record found at startup has none.
  const error = state.status === 'failed' && state.id === pending.record.id ? state.error : null;

  return (
    <div className="max-w-lg mx-auto">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <CloudOff className="w-5 h-5 text-amber-600" />
            Unsent record
          </CardTitle>
          <CardDescription>
            The server has not confirmed this record yet. Send it before recording anything else: it
            goes again exactly as it was written, so nothing is recorded twice and no receipt number
            is skipped.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="font-semibold text-gray-900">{describePending(pending)}</p>
          {error && (
            <div
              role="alert"
              className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700"
            >
              {recordErrorMessage(error, pending)}
            </div>
          )}
          <div className="flex flex-col sm:flex-row gap-2">
            <Button className="flex-1" size="lg" disabled={isSending} onClick={() => onRetry()}>
              <RefreshCw className={`mr-2 h-4 w-4 ${isSending ? 'animate-spin' : ''}`} />
              {isSending ? 'Sending...' : 'Retry'}
            </Button>
            {error && canDiscard(error) && (
              <Button variant="outline" size="lg" disabled={isSending} onClick={() => onDiscard()}>
                <Trash2 className="mr-2 h-4 w-4 text-red-600" />
                Discard
              </Button>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
