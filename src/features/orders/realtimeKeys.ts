/**
 * What to re-read when another device changes something.
 *
 * A realtime event carries no payload on purpose: the app refetches the queries the topic covers,
 * so a duplicated event costs one refetch and a missed one costs nothing a later read does not fix.
 * The mapping is a plain table because it is the whole contract between the port and the screens.
 */
import { queryKeys } from '@/lib/query';
import type { RealtimeTopic } from '@/ports';

/** Prefix keys: invalidating `tables` takes the grid and every table's open order with it. */
const AFFECTED: Record<RealtimeTopic, readonly (readonly string[])[]> = {
  // An order opening or closing changes the grid, the table someone is looking at, and the board
  // the kitchen reads, because a cancelled order takes its ticket with it.
  open_orders: [queryKeys.tables, queryKeys.kitchen],
  open_order_items: [queryKeys.tables, queryKeys.kitchen],
  // A table renamed or taken out of service changes the grid and the list behind it.
  dining_tables: [queryKeys.tables],
  // A price or an availability change is the menu, not the room: what is already on a table keeps
  // the price snapshotted when it was ordered.
  products: [queryKeys.products],
};

export function affectedQueryKeys(topic: RealtimeTopic): readonly (readonly string[])[] {
  return AFFECTED[topic];
}
