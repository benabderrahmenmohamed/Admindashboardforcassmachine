import { ErrorState, LoadingState } from '@/components/feedback';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { tableTile, type TableTile } from '@/features/orders/board';
import { useBoard, useTables } from '@/features/orders/hooks/useOrders';
import { useRealtimeRefresh } from '@/features/orders/hooks/useRealtime';
import type { DiningTable, TableBoardEntry } from '@/ports';

/**
 * The café's tables: what the room is made of and what each one is doing right now.
 *
 * The grid the waiters and the counter read comes from this list, so an admin looking at a table
 * that is not where they expect it looks here first. It is live, like the grid itself.
 */
export function TablesPage() {
  const tablesQuery = useTables();
  const boardQuery = useBoard();
  useRealtimeRefresh();

  if (tablesQuery.isPending) {
    return <LoadingState />;
  }
  if (tablesQuery.isLoadingError) {
    return (
      <ErrorState
        title="Failed to load the tables"
        error={tablesQuery.error}
        onRetry={() => void tablesQuery.refetch()}
      />
    );
  }

  const byId = new Map<string, TableBoardEntry>(
    (boardQuery.data ?? []).map((entry) => [entry.table.id, entry]),
  );

  return (
    <div>
      <div className="mb-8">
        <h1 className="text-3xl font-bold text-gray-900 mb-2">Tables</h1>
        <p className="text-gray-600">
          The room the waiters and the counter see. Creating, renaming and reordering tables is not
          on this screen yet: `OrdersPort` reads the tables but has no write for them.
        </p>
      </div>

      {tablesQuery.data.length === 0 ? (
        <p className="py-12 text-center text-gray-600">
          This café has no tables yet, so nothing can be ordered.
        </p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Table</TableHead>
              <TableHead>Position</TableHead>
              <TableHead>In service</TableHead>
              <TableHead>Right now</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {tablesQuery.data.map((diningTable) => (
              <TableRow key={diningTable.id}>
                <TableCell className="font-medium">{diningTable.name}</TableCell>
                <TableCell>{diningTable.sortOrder}</TableCell>
                <TableCell>{diningTable.isActive ? 'Yes' : 'Out of service'}</TableCell>
                <TableCell>{rightNow(diningTable, byId.get(diningTable.id))}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}

/** A table out of service is never on the board, so it says so rather than showing nothing. */
function rightNow(diningTable: DiningTable, entry: TableBoardEntry | undefined): string {
  if (!diningTable.isActive) {
    return 'Not in the room';
  }
  if (entry === undefined) {
    return '—';
  }
  const tile: TableTile = tableTile(entry);
  return tile.statusText;
}
