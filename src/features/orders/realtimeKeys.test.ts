import { describe, expect, it } from 'vitest';
import { queryKeys } from '@/lib/query';
import { realtimeTopicSchema, type RealtimeTopic } from '@/ports';
import { affectedQueryKeys } from './realtimeKeys';

const TOPICS: readonly RealtimeTopic[] = realtimeTopicSchema.options;

describe('affectedQueryKeys', () => {
  it('answers for every topic the port can send', () => {
    for (const topic of TOPICS) {
      expect(affectedQueryKeys(topic).length, topic).toBeGreaterThan(0);
    }
  });

  it('re-reads the room and the kitchen when what is on a table changes', () => {
    expect(affectedQueryKeys('open_order_items')).toEqual([queryKeys.tables, queryKeys.kitchen]);
  });

  it('re-reads the room when a table is renamed or taken out of service', () => {
    expect(affectedQueryKeys('dining_tables')).toEqual([queryKeys.tables]);
  });

  it('leaves what is already on a table alone when a price changes', () => {
    expect(affectedQueryKeys('products')).toEqual([queryKeys.products]);
  });

  it('uses prefix keys, so one invalidation covers the grid and each table under it', () => {
    // queryKeys.openOrder('table-1') starts with queryKeys.tables.
    expect(queryKeys.openOrder('table-1').slice(0, queryKeys.tables.length)).toEqual([
      ...queryKeys.tables,
    ]);
    expect(queryKeys.board.slice(0, queryKeys.tables.length)).toEqual([...queryKeys.tables]);
  });
});
