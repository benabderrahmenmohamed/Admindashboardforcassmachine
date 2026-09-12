import { Check, CookingPot, Ban } from 'lucide-react';
import { ErrorState, LoadingState } from '@/components/feedback';
import { Button } from '@/components/ui/button';
import { useKitchenTickets, useOrderWrites } from '@/features/orders/hooks/useOrders';
import { useRealtimeRefresh } from '@/features/orders/hooks/useRealtime';
import { useNow } from '@/features/sync/hooks/useNow';
import type { OpenOrderItem } from '@/ports';
import { longestWait, ticketBoard, type TicketView } from '../tickets';

/** Re-read once a minute, so "waiting 12 min" keeps up without the kitchen touching anything. */
const TICK_MS = 30_000;

/**
 * The kitchen board: one card per send, oldest first, marked prepared item by item.
 *
 * It never asks to be refreshed. Every add, send and removal in the room invalidates this query
 * through the realtime port, so a ticket appears the moment a waiter sends it and an item a waiter
 * took off turns into a void card the cook can see at a glance.
 */
export function KitchenPage() {
  const ticketsQuery = useKitchenTickets();
  const writes = useOrderWrites();
  const now = useNow(TICK_MS);
  useRealtimeRefresh();

  if (ticketsQuery.isPending) {
    return <LoadingState />;
  }
  if (ticketsQuery.isLoadingError) {
    return (
      <ErrorState
        title="Failed to load the tickets"
        error={ticketsQuery.error}
        onRetry={() => void ticketsQuery.refetch()}
      />
    );
  }

  const board = ticketBoard(ticketsQuery.data, now);

  if (board.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-64 text-center px-4">
        <CookingPot className="w-12 h-12 text-gray-400 mb-4" />
        <p className="font-semibold text-gray-900 mb-1">Nothing to make</p>
        <p className="text-sm text-gray-600">Tickets appear here the moment a waiter sends one.</p>
      </div>
    );
  }

  return (
    <div className="p-3">
      <p className="mb-3 text-sm text-gray-600" role="status">
        {board.length} {board.length === 1 ? 'ticket' : 'tickets'} · longest wait{' '}
        {longestWait(board)} min
      </p>
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
        {board.map((ticket) => (
          <TicketCard
            key={ticket.key}
            ticket={ticket}
            isWriting={writes.isWriting}
            onPrepare={(itemId) => void writes.prepareItem(itemId)}
          />
        ))}
      </div>
    </div>
  );
}

/** Amber after ten minutes, red after twenty: a cook reads the board from across the kitchen. */
function waitStyle(minutes: number): string {
  if (minutes >= 20) {
    return 'border-red-400 bg-red-50';
  }
  return minutes >= 10 ? 'border-amber-400 bg-amber-50' : 'border-gray-200 bg-white';
}

function TicketCard({
  ticket,
  isWriting,
  onPrepare,
}: {
  readonly ticket: TicketView;
  readonly isWriting: boolean;
  readonly onPrepare: (itemId: string) => void;
}) {
  return (
    <article className={`rounded-xl border-2 p-3 ${waitStyle(ticket.waitedMinutes)}`}>
      <header className="flex items-baseline justify-between mb-2">
        <h3 className="text-lg font-bold text-gray-900">{ticket.tableName}</h3>
        <span className="text-sm font-medium text-gray-700">{ticket.waitedMinutes} min</span>
      </header>

      <ul className="space-y-2">
        {ticket.toPrepare.map((item) => (
          <li key={item.id} className="flex items-center gap-2">
            <ItemText item={item} />
            <Button
              type="button"
              variant="outline"
              className="min-h-11 ml-auto"
              disabled={isWriting}
              aria-label={`Mark ${item.nameSnapshot} prepared`}
              onClick={() => onPrepare(item.id)}
            >
              <Check className="h-5 w-5" />
            </Button>
          </li>
        ))}
        {ticket.prepared.map((item) => (
          <li key={item.id} className="flex items-center gap-2 text-gray-500">
            <Check className="h-4 w-4 text-emerald-600" />
            <span className="line-through">
              {item.qty}× {item.nameSnapshot}
            </span>
          </li>
        ))}
        {ticket.voided.map((item) => (
          <li key={item.id} className="flex items-start gap-2 p-2 rounded-lg bg-red-100">
            <Ban className="h-5 w-5 text-red-700 shrink-0" aria-hidden="true" />
            <span>
              <span className="block font-semibold text-red-800">
                Void: {item.qty}× {item.nameSnapshot}
              </span>
              {item.removedReason !== null && (
                <span className="block text-sm text-red-700">{item.removedReason}</span>
              )}
            </span>
          </li>
        ))}
      </ul>
    </article>
  );
}

function ItemText({ item }: { readonly item: OpenOrderItem }) {
  return (
    <span>
      <span className="block text-base font-semibold text-gray-900">
        {item.qty}× {item.nameSnapshot}
      </span>
      {item.note !== '' && <span className="block text-sm text-gray-700">{item.note}</span>}
    </span>
  );
}
