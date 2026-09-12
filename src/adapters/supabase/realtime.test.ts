import { REALTIME_SUBSCRIBE_STATES } from '@supabase/supabase-js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RealtimeTopic } from '@/ports';
import { fakeRealtime, type FakeChannel } from './fakeSupabase';
import { createSupabaseRealtime, reconnectDelayMs, type SupabaseRealtimeApi } from './realtime';

const SHOP = 'shop-1';

const TOPICS: readonly RealtimeTopic[] = [
  'open_orders',
  'open_order_items',
  'dining_tables',
  'products',
];

/** The newest channel the client opened; fails the test when it opened none. */
function latest(channels: readonly FakeChannel[]): FakeChannel {
  return channels.at(-1) ?? expect.unreachable('no channel was opened');
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('supabase realtime', () => {
  it('listens to every topic of the shop on one channel', () => {
    const { api, channels } = fakeRealtime();

    const stop = createSupabaseRealtime(api).subscribe(SHOP, () => undefined);

    expect(channels).toHaveLength(1);
    expect(latest(channels).open).toBe(true);
    expect(latest(channels).bindings.map((binding) => binding.table)).toEqual(TOPICS);
    expect(latest(channels).bindings.map((binding) => binding.filter)).toEqual(
      TOPICS.map(() => `shop_id=eq.${SHOP}`),
    );
    stop();
  });

  it.each(TOPICS)('reports a change on %s as its topic, without the row', (topic) => {
    const seen: RealtimeTopic[] = [];
    const { api, channels } = fakeRealtime();
    const stop = createSupabaseRealtime(api).subscribe(SHOP, (changed) => {
      seen.push(changed);
    });

    latest(channels).change(topic);

    expect(seen).toEqual([topic]);
    stop();
  });

  it('gives each subscription a channel of its own', () => {
    const first: RealtimeTopic[] = [];
    const second: RealtimeTopic[] = [];
    const { api, channels } = fakeRealtime();
    const realtime = createSupabaseRealtime(api);

    const stopFirst = realtime.subscribe(SHOP, (topic) => first.push(topic));
    const stopSecond = realtime.subscribe(SHOP, (topic) => second.push(topic));
    expect(new Set(channels.map((channel) => channel.name)).size).toBe(2);

    channels[0].change('products');
    channels[1].change('dining_tables');
    expect(first).toEqual(['products']);
    expect(second).toEqual(['dining_tables']);

    // One screen leaving does not stop the other.
    stopFirst();
    channels[1].change('open_orders');
    expect(second).toEqual(['dining_tables', 'open_orders']);
    stopSecond();
  });

  it('opens a new channel after the old one errors, without throwing', async () => {
    vi.useFakeTimers();
    const { api, channels } = fakeRealtime();
    const seen: RealtimeTopic[] = [];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const stop = createSupabaseRealtime(api, { retryDelayMs: () => 1000 }).subscribe(
      SHOP,
      (topic) => {
        seen.push(topic);
      },
    );
    const dropped = latest(channels);
    dropped.report(REALTIME_SUBSCRIBE_STATES.CHANNEL_ERROR, new Error('socket closed'));

    // The dead channel is left at once, and nothing happens until the backoff has passed.
    expect(dropped.removed).toBe(true);
    expect(channels).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1000);

    expect(channels).toHaveLength(2);
    const reopened = latest(channels);
    expect(reopened.bindings.map((binding) => binding.table)).toEqual(TOPICS);
    reopened.report(REALTIME_SUBSCRIBE_STATES.SUBSCRIBED);
    reopened.change('open_order_items');
    expect(seen).toEqual(['open_order_items']);
    expect(warn).toHaveBeenCalled();
    stop();
  });

  it.each([REALTIME_SUBSCRIBE_STATES.TIMED_OUT, REALTIME_SUBSCRIBE_STATES.CLOSED])(
    'reconnects after %s too',
    async (status) => {
      vi.useFakeTimers();
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const { api, channels } = fakeRealtime();

      const stop = createSupabaseRealtime(api, { retryDelayMs: () => 10 }).subscribe(
        SHOP,
        () => undefined,
      );
      latest(channels).report(status);
      await vi.advanceTimersByTimeAsync(10);

      expect(channels).toHaveLength(2);
      stop();
    },
  );

  it('keeps trying, backing off, for as long as the subscription lasts', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const delays: number[] = [];
    const { api, channels } = fakeRealtime();

    const stop = createSupabaseRealtime(api, {
      retryDelayMs: (attempt) => {
        delays.push(attempt);
        return 5;
      },
    }).subscribe(SHOP, () => undefined);
    for (let round = 0; round < 3; round += 1) {
      latest(channels).report(REALTIME_SUBSCRIBE_STATES.CHANNEL_ERROR);
      await vi.advanceTimersByTimeAsync(5);
    }

    expect(channels).toHaveLength(4);
    expect(delays).toEqual([0, 1, 2]);

    // A channel that joins starts the backoff again from the beginning.
    latest(channels).report(REALTIME_SUBSCRIBE_STATES.SUBSCRIBED);
    latest(channels).report(REALTIME_SUBSCRIBE_STATES.CHANNEL_ERROR);
    await vi.advanceTimersByTimeAsync(5);
    expect(delays).toEqual([0, 1, 2, 0]);
    stop();
  });

  it('does not throw at the caller when a channel cannot even be opened', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { api, channels } = fakeRealtime();
    let openings = 0;
    const flaky: SupabaseRealtimeApi = {
      channel: (name) => {
        openings += 1;
        if (openings === 1) {
          throw new Error('no websocket here');
        }
        return api.channel(name);
      },
      removeChannel: (channel) => api.removeChannel(channel),
    };

    const stop = createSupabaseRealtime(flaky, { retryDelayMs: () => 5 }).subscribe(
      SHOP,
      () => undefined,
    );

    expect(channels).toEqual([]);
    await vi.advanceTimersByTimeAsync(5);
    expect(channels).toHaveLength(1);
    stop();
  });

  it('opens nothing more once the caller has unsubscribed', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { api, channels } = fakeRealtime();

    const stop = createSupabaseRealtime(api, { retryDelayMs: () => 1000 }).subscribe(
      SHOP,
      () => undefined,
    );
    latest(channels).report(REALTIME_SUBSCRIBE_STATES.CHANNEL_ERROR);
    stop();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(channels).toHaveLength(1);
    expect(channels[0].removed).toBe(true);
  });

  it('reports nothing to a listener that has unsubscribed, even on a late event', () => {
    const seen: RealtimeTopic[] = [];
    const { api, channels } = fakeRealtime();

    const stop = createSupabaseRealtime(api).subscribe(SHOP, (topic) => {
      seen.push(topic);
    });
    const opened = latest(channels);
    stop();
    opened.change('products');

    expect(seen).toEqual([]);
    expect(opened.removed).toBe(true);
  });

  it('survives a listener that throws: the channel stays and the next change arrives', () => {
    const seen: RealtimeTopic[] = [];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { api, channels } = fakeRealtime();

    const stop = createSupabaseRealtime(api).subscribe(SHOP, (topic) => {
      seen.push(topic);
      if (topic === 'products') {
        throw new Error('a screen blew up');
      }
    });
    expect(() => latest(channels).change('products')).not.toThrow();
    latest(channels).change('dining_tables');

    expect(seen).toEqual(['products', 'dining_tables']);
    expect(warn).toHaveBeenCalled();
    stop();
  });

  it('never throws when leaving the channel fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { api } = fakeRealtime(() => Promise.reject(new Error('socket already gone')));

    const stop = createSupabaseRealtime(api).subscribe(SHOP, () => undefined);

    expect(() => {
      stop();
    }).not.toThrow();
    await Promise.resolve();

    expect(warn).toHaveBeenCalledWith('Could not leave the realtime channel', expect.anything());
  });
});

describe('reconnectDelayMs', () => {
  it('doubles from half a second and stops at a minute, jitter included', () => {
    expect(reconnectDelayMs(0, () => 1)).toBe(500);
    expect(reconnectDelayMs(1, () => 1)).toBe(1000);
    expect(reconnectDelayMs(4, () => 1)).toBe(8000);
    expect(reconnectDelayMs(30, () => 1)).toBe(60_000);
  });

  it('never waits less than half of what it would without jitter', () => {
    for (const attempt of [0, 1, 5, 12]) {
      const floor = reconnectDelayMs(attempt, () => 0);
      const ceiling = reconnectDelayMs(attempt, () => 1);
      expect(floor).toBe(Math.round(ceiling / 2));
      expect(floor).toBeGreaterThan(0);
    }
  });
});
