import { LayoutGrid } from 'lucide-react';
import { ErrorState, LoadingState } from '@/components/feedback';
import { formatTND } from '@/lib/money';
import { boardSummary, tableTiles, type TableState, type TableTile } from '../board';
import { useRoomBoard } from '../hooks/useOrders';
import { useRealtimeRefresh } from '../hooks/useRealtime';
import { NEEDS_ATTENTION } from '../localFlags';
import { LocalBadge } from './LocalBadge';

/**
 * The room, as both the waiter's phone and the counter see it.
 *
 * Tiles are 96 px tall and full-width in two columns on a phone, because the person tapping one is
 * standing up holding a tray. The colour says what the tile needs: amber when the kitchen has not
 * been told, blue when money is owed, plain when the table is free.
 */
const TILE_STYLE: Record<TableState, string> = {
  free: 'bg-white border-gray-200 hover:border-gray-400',
  unsent: 'bg-amber-50 border-amber-400 hover:border-amber-500',
  owing: 'bg-blue-50 border-blue-300 hover:border-blue-500',
  settled: 'bg-emerald-50 border-emerald-300 hover:border-emerald-500',
};

export function TableTileButton({
  tile,
  isSelected,
  onSelect,
}: {
  readonly tile: TableTile;
  readonly isSelected: boolean;
  readonly onSelect: (tableId: string) => void;
}) {
  const { changes, cancelling } = tile.local;
  const hasChanges = changes.pending > 0 || changes.conflicts > 0;
  return (
    <button
      type="button"
      aria-pressed={isSelected}
      onClick={() => onSelect(tile.tableId)}
      className={`min-h-24 p-3 rounded-xl border-2 text-left transition-colors ${TILE_STYLE[tile.state]} ${
        isSelected ? 'ring-2 ring-blue-600 ring-offset-1' : ''
      }`}
    >
      <span className="block text-lg font-bold text-gray-900">{tile.name}</span>
      <span className="block mt-1 text-sm text-gray-700">{tile.statusText}</span>
      {(tile.unsentCount > 0 || cancelling !== null || hasChanges) && (
        <span className="mt-2 flex flex-wrap gap-1">
          {tile.unsentCount > 0 && (
            <span className="inline-block px-2 py-0.5 rounded-full bg-amber-500 text-white text-xs font-semibold">
              To send
            </span>
          )}
          {cancelling !== null && <LocalBadge sync={cancelling}>Cancelling</LocalBadge>}
          {/* One flag for the table: what it is waiting on is on the table's own screen. */}
          {changes.conflicts > 0 ? (
            <LocalBadge sync="conflict">{NEEDS_ATTENTION}</LocalBadge>
          ) : (
            changes.pending > 0 && <LocalBadge sync="pending">Not synced</LocalBadge>
          )}
        </span>
      )}
    </button>
  );
}

/**
 * The grid with its own loading, error and empty states, and a live subscription: every other
 * device's add, send or payment marks this query stale, so two waiters see one room. What this
 * device changed and the server does not show yet is on the tiles at once, flagged.
 */
export function TableBoard({
  selectedTableId = null,
  onSelect,
}: {
  readonly selectedTableId?: string | null;
  readonly onSelect: (tableId: string) => void;
}) {
  const room = useRoomBoard();
  useRealtimeRefresh();

  if (room.query.isPending) {
    return <LoadingState />;
  }
  if (room.query.isLoadingError) {
    return (
      <ErrorState
        title="Failed to load the room"
        error={room.query.error}
        onRetry={() => void room.query.refetch()}
      />
    );
  }

  const tiles = tableTiles(room.entries);
  if (tiles.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-64 text-center px-4">
        <LayoutGrid className="w-12 h-12 text-gray-400 mb-4" />
        <p className="font-semibold text-gray-900 mb-1">No tables yet</p>
        <p className="text-sm text-gray-600 max-w-sm">
          An admin sets the café&apos;s tables up before anything can be ordered.
        </p>
      </div>
    );
  }

  const summary = boardSummary(tiles);
  return (
    <div>
      <p className="mb-3 text-sm text-gray-600" role="status">
        {summary.freeCount} of {summary.tableCount} free · {formatTND(summary.dueMillimes)} owed
        {summary.waitingToSend > 0 && ` · ${summary.waitingToSend} waiting on the kitchen`}
      </p>
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3">
        {tiles.map((tile) => (
          <TableTileButton
            key={tile.tableId}
            tile={tile}
            isSelected={tile.tableId === selectedTableId}
            onSelect={onSelect}
          />
        ))}
      </div>
    </div>
  );
}
