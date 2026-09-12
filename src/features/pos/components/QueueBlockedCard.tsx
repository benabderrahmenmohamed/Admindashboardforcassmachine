import { TriangleAlert } from 'lucide-react';
import { Link } from 'react-router';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import type { OutboxRecord } from '@/features/sync/types';
import { describeRecord, recordErrorMessage } from '../recording';

interface QueueBlockedCardProps {
  /** The record the server refused, which the queue stops at. */
  readonly record: OutboxRecord;
  /** How many records were written after it and are waiting behind it. */
  readonly waiting: number;
}

/**
 * Selling goes on while records are merely waiting to be sent; it stops here. The queue keeps the
 * terminal's receipt numbers in order, so nothing written after this record can reach the server
 * until a person retries it or an admin voids its number.
 */
export function QueueBlockedCard({ record, waiting }: QueueBlockedCardProps) {
  return (
    <div className="max-w-lg mx-auto">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <TriangleAlert className="w-5 h-5 text-red-600" />
            The queue is stopped
          </CardTitle>
          <CardDescription>
            The server refused a record. Nothing more can be recorded on this terminal until it is
            sorted out, because the records behind it keep its place in the receipt numbering.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="font-semibold text-gray-900">{describeRecord(record)}</p>
          {record.lastError && (
            <div
              role="alert"
              className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700"
            >
              {recordErrorMessage(record.lastError, record)}
            </div>
          )}
          {waiting > 0 && (
            <p className="text-sm text-gray-600">
              {waiting === 1
                ? '1 record written after it is waiting behind it.'
                : `${waiting} records written after it are waiting behind it.`}
            </p>
          )}
          <Button asChild className="w-full" size="lg">
            <Link to="/caisse/conflicts">Review the queue</Link>
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
