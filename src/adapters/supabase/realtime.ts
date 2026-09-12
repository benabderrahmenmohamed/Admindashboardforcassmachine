import {
  REALTIME_SUBSCRIBE_STATES,
  type RealtimeChannel,
  type RealtimeRemoveChannelResponse,
} from '@supabase/supabase-js';
import { toAppError } from '@/lib/errors';
import { realtimeTopicSchema, type RealtimePort, type RealtimeTopic } from '@/ports';

/**
 * The tables a change on reaches the app, each one a topic of the port. Every one of them carries
 * `shop_id`, which is what the subscription filters on; row-level security applies to Realtime too,
 * so the filter narrows what is delivered rather than being what keeps shops apart.
 */
const TOPICS: readonly RealtimeTopic[] = realtimeTopicSchema.options;

/** The column every topic table is filtered by. */
const SHOP_COLUMN = 'shop_id';

/** Backoff between reconnection attempts: 500 ms doubling to a minute, with jitter. */
export function reconnectDelayMs(attempt: number, random: () => number = Math.random): number {
  const backoff = Math.min(500 * 2 ** Math.min(attempt, 10), 60_000);
  return Math.round(backoff * (0.5 + random() / 2));
}

/** What this adapter uses of the Supabase client, so tests can pass a fake. */
export interface SupabaseRealtimeApi {
  channel(name: string): RealtimeChannel;
  removeChannel(channel: RealtimeChannel): Promise<RealtimeRemoveChannelResponse>;
}

export interface SupabaseRealtimeOptions {
  /** How long to wait before opening a channel again. Default: `reconnectDelayMs`. */
  readonly retryDelayMs?: (attempt: number) => number;
}

/** Channel names are unique per subscription, so two screens never share one channel's lifetime. */
let channelCount = 0;

function nextChannelName(shopId: string): string {
  channelCount += 1;
  return `shop:${shopId}:${channelCount}`;
}

/**
 * RealtimePort on one Supabase Realtime channel per subscription, listening to every change on the
 * four tables the app reads. Nothing of a change is passed on but its topic: the app re-reads the
 * queries the topic covers, so a missed or duplicated event costs a refetch and never a wrong screen.
 *
 * A dropped channel is opened again after a backoff, for as long as the subscription lasts, and
 * nothing here ever throws into the caller: a live update is an improvement on reading, never a
 * thing a screen depends on.
 */
export function createSupabaseRealtime(
  client: SupabaseRealtimeApi,
  options: SupabaseRealtimeOptions = {},
): RealtimePort {
  const retryDelayMs = options.retryDelayMs ?? reconnectDelayMs;

  return {
    subscribe(shopId, listener) {
      let stopped = false;
      let attempts = 0;
      let channel: RealtimeChannel | undefined;
      let retry: ReturnType<typeof setTimeout> | undefined;

      /** A listener that throws must not take the subscription, or the channel, down with it. */
      function notify(topic: RealtimeTopic): void {
        if (stopped) {
          return;
        }
        try {
          listener(topic);
        } catch (error) {
          console.warn(`A listener failed on a ${topic} change`, toAppError(error));
        }
      }

      function close(): void {
        const open = channel;
        channel = undefined;
        if (open === undefined) {
          return;
        }
        // Leaving the channel is best effort: the subscription is over either way.
        client.removeChannel(open).then(undefined, (error: unknown) => {
          console.warn('Could not leave the realtime channel', toAppError(error));
        });
      }

      function reopen(reason: string, cause?: Error): void {
        if (stopped || retry !== undefined) {
          return;
        }
        close();
        const delay = retryDelayMs(attempts);
        attempts += 1;
        console.warn(`Live updates stopped (${reason}); reconnecting in ${delay} ms`, cause);
        retry = setTimeout(() => {
          retry = undefined;
          if (!stopped) {
            open();
          }
        }, delay);
      }

      function open(): void {
        try {
          const opening = client.channel(nextChannelName(shopId));
          for (const topic of TOPICS) {
            opening.on(
              'postgres_changes',
              {
                event: '*',
                schema: 'public',
                table: topic,
                filter: `${SHOP_COLUMN}=eq.${shopId}`,
              },
              () => {
                notify(topic);
              },
            );
          }
          channel = opening;
          opening.subscribe((status, error) => {
            if (stopped || opening !== channel) {
              return;
            }
            if (status === REALTIME_SUBSCRIBE_STATES.SUBSCRIBED) {
              attempts = 0;
              return;
            }
            if (
              status === REALTIME_SUBSCRIBE_STATES.CHANNEL_ERROR ||
              status === REALTIME_SUBSCRIBE_STATES.TIMED_OUT ||
              status === REALTIME_SUBSCRIBE_STATES.CLOSED
            ) {
              reopen(status, error);
            }
          });
        } catch (error) {
          // Opening a socket can fail outright (no WebSocket, a refused upgrade). The screen that
          // asked for live updates must not fail with it; try again after the backoff instead.
          reopen('the channel could not be opened', toAppError(error));
        }
      }

      open();

      return () => {
        stopped = true;
        if (retry !== undefined) {
          clearTimeout(retry);
          retry = undefined;
        }
        close();
      };
    },
  };
}
