import { describe, expect, it } from 'vitest';
import { saleRecord } from '@/features/pos/__fixtures__/records';
import { queryKeys } from '@/lib/query';
import { realtimeTopicSchema, type RealtimeTopic } from '@/ports';
import { addRecord, ms, sendRecord } from './__fixtures__/room';
import { affectedQueryKeys, ROOM_QUERY_KEYS, roomChangedSince } from './realtimeKeys';

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

describe('roomChangedSince', () => {
  it('re-reads the grid, the tables and the kitchen', () => {
    expect(ROOM_QUERY_KEYS).toEqual([queryKeys.tables, queryKeys.kitchen]);
  });

  it('is true once an order record reached the server after the last pass', () => {
    const records = [
      addRecord({ id: 'a' }, { ordinal: 1, status: 'acked', ackedAt: ms(5) }),
      sendRecord('s', { ordinal: 2, status: 'acked', ackedAt: ms(8) }),
    ];

    expect(roomChangedSince(records, null)).toBe(true);
    expect(roomChangedSince(records, ms(7))).toBe(true);
    expect(roomChangedSince(records, ms(8))).toBe(false);
  });

  it('is false for an order record the server has not taken, and for a sale', () => {
    const records = [
      addRecord({ id: 'a' }, { ordinal: 1, status: 'pending' }),
      addRecord({ id: 'b' }, { ordinal: 2, status: 'conflict' }),
      addRecord({ id: 'c' }, { ordinal: 3, status: 'discarded' }),
      saleRecord({ seq: 1, ordinal: 4, status: 'acked' }),
    ];

    expect(roomChangedSince(records, null)).toBe(false);
  });
});
