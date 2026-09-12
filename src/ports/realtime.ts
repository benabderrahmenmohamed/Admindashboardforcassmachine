import { z } from 'zod';

/**
 * What another device changed. The app does not take the payload of a change: it re-reads the
 * queries the topic covers, so a missed or duplicated event costs a refetch and never a wrong
 * screen. A waiter's phone and the caisse therefore agree without either polling hard.
 */
export const realtimeTopicSchema = z.enum([
  'open_orders',
  'open_order_items',
  'dining_tables',
  'products',
]);
export type RealtimeTopic = z.infer<typeof realtimeTopicSchema>;

export type RealtimeListener = (topic: RealtimeTopic) => void;

export interface RealtimePort {
  /**
   * Calls `listener` whenever something in the shop changes, and returns the function that stops it.
   * A backend with nothing behind it (the demo, a REST server without polling) may never call the
   * listener; every screen must still work from its own reads.
   */
  subscribe(shopId: string, listener: RealtimeListener): () => void;
}
