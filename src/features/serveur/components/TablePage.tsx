import { ChevronLeft, Plus, Send, Trash2 } from 'lucide-react';
import { useId, useState } from 'react';
import { Link, useParams } from 'react-router';
import { toast } from 'sonner';
import { ErrorState, LoadingState } from '@/components/feedback';
import { Button } from '@/components/ui/button';
import { LocalBadge } from '@/features/orders/components/LocalBadge';
import { useOrderWrites, useRoomOrder, useTables } from '@/features/orders/hooks/useOrders';
import { useRealtimeRefresh } from '@/features/orders/hooks/useRealtime';
import { changesText, itemFlags } from '@/features/orders/localFlags';
import type { RoomItem } from '@/features/orders/overlay';
import { canRemove, itemStage, itemTotal, tableOrderView } from '@/features/orders/tableOrder';
import { formatTND } from '@/lib/money';
import { MenuSheet, type MenuChoice } from './MenuSheet';
import { RemoveItemDialog } from './RemoveItemDialog';

/**
 * One table on a waiter's phone: what has been ordered, what the kitchen has, and the two things a
 * waiter does — add something, and tell the kitchen. Everything is at least 44 px tall because the
 * person using it is standing.
 *
 * A tap goes into this phone's queue and shows on the table at once, flagged until the server has
 * it, so the phone works the same with no network at all.
 */
export function TablePage() {
  const params = useParams();
  const tableId = params.tableId ?? '';
  const tablesQuery = useTables();
  const room = useRoomOrder(tableId === '' ? null : tableId);
  const writes = useOrderWrites();
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [removing, setRemoving] = useState<RoomItem | null>(null);
  useRealtimeRefresh();

  const table = tablesQuery.data?.find((candidate) => candidate.id === tableId);

  if (room.query.isPending || tablesQuery.isPending) {
    return <LoadingState />;
  }
  if (room.query.isLoadingError || tablesQuery.isLoadingError) {
    return (
      <ErrorState
        title="Failed to load the table"
        error={room.query.error ?? tablesQuery.error}
        onRetry={() => {
          if (room.query.isError) void room.query.refetch();
          if (tablesQuery.isError) void tablesQuery.refetch();
        }}
      />
    );
  }
  if (!table) {
    return (
      <ErrorState
        title="No such table"
        error={new Error('This table is not in the café any more. Go back to the room.')}
      />
    );
  }

  const view = tableOrderView(room.order);
  const changes = changesText(view.changes);

  const add = async ({ product, qty, note }: MenuChoice): Promise<boolean> => {
    const added = await writes.addItem({ tableId, productId: product.id, qty, note });
    if (added) {
      toast.success(`${product.name} added to ${table.name}`);
    }
    return added;
  };

  const remove = async (reason: string) => {
    const item = removing;
    if (!item) {
      return;
    }
    if (await writes.removeItem({ itemId: item.id, reason })) {
      setRemoving(null);
      toast.success(`${item.nameSnapshot} taken off ${table.name}`);
    }
  };

  const send = async () => {
    if (await writes.send(tableId)) {
      // Not "the kitchen has it": the phone may be offline, and the table says when it is synced.
      toast.success(`${table.name}: sent to the kitchen`);
    }
  };

  return (
    <div className="pb-28">
      <div className="px-3 py-2 flex items-center gap-2">
        <Button asChild variant="ghost" className="min-h-11 -ml-2">
          <Link to="/serveur">
            <ChevronLeft className="h-5 w-5" />
            Room
          </Link>
        </Button>
        <h2 className="text-xl font-bold text-gray-900">{table.name}</h2>
        <span className="ml-auto text-lg font-semibold text-gray-900">
          {formatTND(view.dueMillimes)}
          {view.unpricedCount > 0 && (
            <span className="block text-xs font-normal text-gray-600 text-right">
              + {view.unpricedCount} unpriced
            </span>
          )}
        </span>
      </div>

      {(changes !== null || view.cancelling !== null) && (
        <div className="px-3 pb-2 space-y-1" role="status">
          {view.cancelling !== null && (
            <p className="text-sm font-medium text-red-800">
              Cancelling this table: {view.cancelling.reason}
            </p>
          )}
          {changes !== null && <p className="text-sm text-amber-800">{changes}</p>}
        </div>
      )}

      {view.isEmpty ? (
        <p className="px-3 py-12 text-center text-gray-600">
          Nothing on this table yet. Add the first order below.
        </p>
      ) : (
        <div className="px-3 space-y-4">
          <ItemGroup
            title="To send"
            items={view.unsent}
            emptyText="Everything has gone to the kitchen."
            onRemove={setRemoving}
          />
          <ItemGroup
            title="With the kitchen"
            items={view.sent}
            emptyText="The kitchen has nothing from this table."
            onRemove={setRemoving}
          />
          {view.paid.length > 0 && (
            <ItemGroup title="Paid" items={view.paid} emptyText="" onRemove={null} />
          )}
          {view.removed.length > 0 && (
            <ItemGroup title="Taken off" items={view.removed} emptyText="" onRemove={null} />
          )}
        </div>
      )}

      <div className="fixed bottom-0 inset-x-0 bg-white border-t border-gray-200 p-3 flex gap-2">
        <Button
          type="button"
          variant="outline"
          className="min-h-14 flex-1 text-base"
          onClick={() => setIsMenuOpen(true)}
        >
          <Plus className="h-5 w-5" />
          Add
        </Button>
        <Button
          type="button"
          className="min-h-14 flex-1 text-base"
          disabled={!view.canSend || writes.isWriting}
          onClick={() => void send()}
        >
          <Send className="h-5 w-5" />
          {view.canSend ? `Send ${view.toSendCount}` : 'Nothing to send'}
        </Button>
      </div>

      <MenuSheet
        open={isMenuOpen}
        onOpenChange={setIsMenuOpen}
        onAdd={add}
        isAdding={writes.isWriting}
      />
      <RemoveItemDialog
        item={removing}
        onOpenChange={(open) => {
          if (!open) {
            setRemoving(null);
          }
        }}
        onConfirm={(reason) => void remove(reason)}
        isRemoving={writes.isWriting}
      />
    </div>
  );
}

function ItemGroup({
  title,
  items,
  emptyText,
  onRemove,
}: {
  readonly title: string;
  readonly items: readonly RoomItem[];
  readonly emptyText: string;
  /** Null when nothing in the group can be taken off any more. */
  readonly onRemove: ((item: RoomItem) => void) | null;
}) {
  const titleId = useId();
  if (items.length === 0 && emptyText === '') {
    return null;
  }
  return (
    <section aria-labelledby={titleId}>
      <h3 id={titleId} className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-2">
        {title}
      </h3>
      {items.length === 0 ? (
        <p className="text-sm text-gray-500">{emptyText}</p>
      ) : (
        <ul className="space-y-2">
          {items.map((item) => (
            <ItemRow key={item.id} item={item} onRemove={onRemove} />
          ))}
        </ul>
      )}
    </section>
  );
}

function ItemRow({
  item,
  onRemove,
}: {
  readonly item: RoomItem;
  readonly onRemove: ((item: RoomItem) => void) | null;
}) {
  const flags = itemFlags(item);
  const offReason = item.removedReason ?? item.local.removing?.reason ?? null;
  return (
    <li className="flex items-center gap-3 p-3 rounded-lg border border-gray-200 bg-white">
      <span className="font-semibold text-gray-900 w-8">{item.qty}×</span>
      <span className="flex-1 min-w-0">
        <span
          className={`block font-medium ${
            itemStage(item) === 'removed' ? 'text-gray-500 line-through' : 'text-gray-900'
          }`}
        >
          {item.nameSnapshot}
        </span>
        {item.note !== '' && <span className="block text-sm text-gray-600">{item.note}</span>}
        {offReason !== null && (
          <span className="block text-sm text-gray-500">Off: {offReason}</span>
        )}
        {flags.length > 0 && (
          <span className="mt-1 flex flex-wrap gap-1">
            {flags.map((flag) => (
              <LocalBadge key={flag.text} sync={flag.sync}>
                {flag.text}
              </LocalBadge>
            ))}
          </span>
        )}
      </span>
      <span className="text-gray-700 text-right">
        {/* A price this phone does not know is not guessed: the server's snapshot fills it in. */}
        {item.priceKnown ? formatTND(itemTotal(item)) : 'Price to come'}
      </span>
      {onRemove && canRemove(item) && (
        <Button
          type="button"
          variant="ghost"
          className="min-h-11 min-w-11"
          aria-label={`Take ${item.nameSnapshot} off the table`}
          onClick={() => onRemove(item)}
        >
          <Trash2 className="h-5 w-5 text-red-600" />
        </Button>
      )}
    </li>
  );
}
