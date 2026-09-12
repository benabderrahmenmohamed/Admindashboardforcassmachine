import { Pencil, Plus } from 'lucide-react';
import { useState } from 'react';
import { ErrorState, LoadingState } from '@/components/feedback';
import { Button } from '@/components/ui/button';
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
import { TableFormDialog } from './TableFormDialog';

/**
 * The café's tables: what the room is made of, what each one is doing right now, and the one place
 * the room changes. A table is added, renamed, moved or taken out of service here, never deleted,
 * because a sale paid at it keeps its name.
 *
 * The grid the waiters and the counter read comes from this list, so an admin looking at a table
 * that is not where they expect it looks here first. It is live, like the grid itself.
 */
export function TablesPage() {
  const tablesQuery = useTables();
  const boardQuery = useBoard();
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [editing, setEditing] = useState<DiningTable | null>(null);
  // Counts the openings of the dialog; each one starts a fresh form (see TableFormDialog).
  const [formSession, setFormSession] = useState(0);
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

  const open = (table: DiningTable | null) => {
    setEditing(table);
    setFormSession((session) => session + 1);
    setIsDialogOpen(true);
  };

  return (
    <div>
      <div className="mb-8 flex flex-col md:flex-row md:items-center md:justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold text-gray-900 mb-2">Tables</h1>
          <p className="text-gray-600">
            The room the waiters and the counter see, in this order. A table is never deleted: take
            it out of service and the sales paid at it keep its name.
          </p>
        </div>
        <Button onClick={() => open(null)}>
          <Plus className="mr-2 h-4 w-4" />
          Add table
        </Button>
      </div>

      {tablesQuery.data.length === 0 ? (
        <p className="py-12 text-center text-gray-600">
          This café has no tables yet, so nothing can be ordered. Add the first one.
        </p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Table</TableHead>
              <TableHead>Position</TableHead>
              <TableHead>In service</TableHead>
              <TableHead>Right now</TableHead>
              <TableHead>
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {tablesQuery.data.map((diningTable) => (
              <TableRow key={diningTable.id}>
                <TableCell className="font-medium">{diningTable.name}</TableCell>
                <TableCell>{diningTable.sortOrder}</TableCell>
                <TableCell>{diningTable.isActive ? 'Yes' : 'Out of service'}</TableCell>
                <TableCell>{rightNow(diningTable, byId.get(diningTable.id))}</TableCell>
                <TableCell className="text-right">
                  <Button
                    variant="outline"
                    size="sm"
                    className="min-h-11 min-w-11"
                    aria-label={`Edit ${diningTable.name}`}
                    onClick={() => open(diningTable)}
                  >
                    <Pencil className="w-4 h-4" />
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      <TableFormDialog
        open={isDialogOpen}
        onOpenChange={setIsDialogOpen}
        table={editing}
        tables={tablesQuery.data}
        hasOpenOrder={editing !== null && (byId.get(editing.id)?.orderId ?? null) !== null}
        formSession={formSession}
      />
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
