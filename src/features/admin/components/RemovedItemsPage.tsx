import { useState } from 'react';
import { ErrorState, LoadingState } from '@/components/feedback';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useRemovedAfterSent } from '@/features/orders/hooks/useOrders';
import { formatTND } from '@/lib/money';
import {
  dayBounds,
  isoDay,
  minutesBeforeRemoval,
  removalTotals,
  removalValue,
  removalsByWaiter,
} from '../removedReport';

/**
 * What was taken off tables after the kitchen had already been told, per waiter.
 *
 * The spec asks for this report by name and says why: removing an item the kitchen has made is the
 * classic waiter fraud, and a removal keeps its row precisely so it can be read here. A removal is
 * not proof of anything on its own, so the reason and the table are shown next to every one.
 */
export function RemovedItemsPage() {
  const today = isoDay(new Date());
  const [fromDay, setFromDay] = useState(today);
  const [toDay, setToDay] = useState(today);
  const report = useRemovedAfterSent(dayBounds(fromDay, toDay));

  return (
    <div>
      <div className="mb-8">
        <h1 className="text-3xl font-bold text-gray-900 mb-2">Removed after sending</h1>
        <p className="text-gray-600">
          Items taken off a table after the kitchen had been told about them.
        </p>
      </div>

      <div className="mb-6 flex flex-wrap gap-4">
        <div>
          <Label htmlFor="report-from">From</Label>
          <Input
            id="report-from"
            type="date"
            className="mt-2 min-h-11"
            value={fromDay}
            max={toDay}
            onChange={(event) => setFromDay(event.target.value)}
          />
        </div>
        <div>
          <Label htmlFor="report-to">To</Label>
          <Input
            id="report-to"
            type="date"
            className="mt-2 min-h-11"
            value={toDay}
            min={fromDay}
            onChange={(event) => setToDay(event.target.value)}
          />
        </div>
      </div>

      <ReportBody
        isPending={report.isPending}
        isLoadingError={report.isLoadingError}
        error={report.error}
        onRetry={() => void report.refetch()}
        rows={report.data}
      />
    </div>
  );
}

function ReportBody({
  isPending,
  isLoadingError,
  error,
  onRetry,
  rows,
}: {
  readonly isPending: boolean;
  readonly isLoadingError: boolean;
  readonly error: unknown;
  readonly onRetry: () => void;
  readonly rows: ReturnType<typeof useRemovedAfterSent>['data'];
}) {
  if (isPending) {
    return <LoadingState />;
  }
  if (isLoadingError || rows === undefined) {
    return <ErrorState title="Failed to load the report" error={error} onRetry={onRetry} />;
  }
  if (rows.length === 0) {
    return (
      <p className="py-12 text-center text-gray-600">
        Nothing was taken off a table after the kitchen had been told, over this period.
      </p>
    );
  }

  const overall = removalTotals(rows);
  return (
    <div className="space-y-6">
      <p className="text-gray-700" role="status">
        {overall.count} {overall.count === 1 ? 'item' : 'items'} · {overall.units} units ·{' '}
        {formatTND(overall.valueMillimes)}
      </p>

      {removalsByWaiter(rows).map((waiter) => (
        <Card key={waiter.userId}>
          <CardHeader>
            <CardTitle>
              {waiter.name} — {waiter.count} {waiter.count === 1 ? 'item' : 'items'},{' '}
              {formatTND(waiter.valueMillimes)}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Table</TableHead>
                  <TableHead>Item</TableHead>
                  <TableHead>Qty</TableHead>
                  <TableHead>Value</TableHead>
                  <TableHead>With the kitchen</TableHead>
                  <TableHead>Reason</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {waiter.rows.map((row) => (
                  <TableRow key={row.itemId}>
                    <TableCell>{row.tableName}</TableCell>
                    <TableCell>{row.productName}</TableCell>
                    <TableCell>{row.qty}</TableCell>
                    <TableCell>{formatTND(removalValue(row))}</TableCell>
                    <TableCell>{minutesBeforeRemoval(row)} min</TableCell>
                    <TableCell>{row.removedReason}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
