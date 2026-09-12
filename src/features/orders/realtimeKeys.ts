/**
 * What to re-read when the room changes: another device's write, announced by the realtime port,
 * or one of this device's own order records reaching the server through the queue.
 *
 * A realtime event carries no payload on purpose: the app refetches the queries the topic covers,
 * so a duplicated event costs one refetch and a missed one costs nothing a later read does not fix.
 * The mapping is a plain table because it is the whole contract between the port and the screens.
 */
import { isOrderRecord, type OutboxRecord } from '@/features/sync/types';
import { queryKeys } from '@/lib/query';
import type { RealtimeTopic } from '@/ports';

/** The room: the grid, every table's order under it, and the kitchen's tickets. Prefix keys. */
export const ROOM_QUERY_KEYS: readonly (readonly string[])[] = [
  queryKeys.tables,
  queryKeys.kitchen,
];

/** Prefix keys: invalidating `tables` takes the grid and every table's open order with it. */
const AFFECTED: Record<RealtimeTopic, readonly (readonly string[])[]> = {
  // An order opening or closing changes the grid, the table someone is looking at, and the board
  // the kitchen reads, because a cancelled order takes its ticket with it.
  open_orders: ROOM_QUERY_KEYS,
  open_order_items: ROOM_QUERY_KEYS,
  // A table renamed or taken out of service changes the grid and the list behind it.
  dining_tables: [queryKeys.tables],
  // A price or an availability change is the menu, not the room: what is already on a table keeps
  // the price snapshotted when it was ordered.
  products: [queryKeys.products],
};

export function affectedQueryKeys(topic: RealtimeTopic): readonly (readonly string[])[] {
  return AFFECTED[topic];
}

/**
 * Whether an order record of this device reached the server after `since` (null: at any time), so
 * the room queries were read before the server had it. The screens draw an acked record over those
 * reads until they are read again; this is what gets them read again, realtime or not.
 */
export function roomChangedSince(records: readonly OutboxRecord[], since: number | null): boolean {
  return records.some(
    (record) =>
      isOrderRecord(record) &&
      record.status === 'acked' &&
      record.ackedAt !== null &&
      (since === null || record.ackedAt > since),
  );
}
