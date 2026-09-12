import { z } from 'zod';
import { toAppError } from '@/lib/errors';
import { realtimeTopicSchema, type RealtimePort, type RealtimeTopic } from '@/ports';
import type { RestClient } from './http';
import { fromWire } from './wire';

/**
 * How long to wait before asking again. A waiter's phone, the caisse and the kitchen screen all
 * watch the same tables, so a couple of seconds is what "live" means here; the answer is a cursor
 * and a list of topic names, so a poll that finds nothing costs almost nothing.
 */
const POLL_INTERVAL_MS = 2_000;

/** The backoff of docs/spec.md: 500 ms doubling to a minute, with jitter so devices spread out. */
export function pollRetryDelayMs(attempt: number, random: () => number = Math.random): number {
  const backoff = Math.min(500 * 2 ** Math.min(attempt, 10), 60_000);
  return Math.round(backoff * (0.5 + random() / 2));
}

const changesSchema = z.object({
  cursor: z.string().min(1),
  topics: z.array(realtimeTopicSchema),
});

export interface RestRealtimeOptions {
  /** Milliseconds between polls. Default: POLL_INTERVAL_MS. */
  readonly intervalMs?: number;
  /** How long to wait after a failed poll. Default: `pollRetryDelayMs`. */
  readonly retryDelayMs?: (attempt: number) => number;
}

/**
 * RealtimePort by polling `GET /open-orders?since=<cursor>`: the REST service holds no connection
 * open, so the client asks what has changed and re-reads the queries those topics cover. Nothing of
 * a change is passed on but its topic, so a missed or a repeated poll costs a refetch and never a
 * wrong screen.
 *
 * The first poll takes the cursor and fires nothing: what changed before a screen subscribed is
 * already in what it read. Afterwards only the topics the answer names are fired.
 *
 * Nothing here ever throws into the caller. A failed poll — the network, a 5xx, a device that is
 * signed out, an answer that cannot be read — is retried with backoff for as long as the
 * subscription lasts: live updates are an improvement on reading, never a thing a screen depends on.
 */
export function createRestRealtime(
  client: RestClient,
  options: RestRealtimeOptions = {},
): RealtimePort {
  const intervalMs = options.intervalMs ?? POLL_INTERVAL_MS;
  const retryDelayMs = options.retryDelayMs ?? pollRetryDelayMs;

  return {
    subscribe(shopId, listener) {
      let stopped = false;
      let attempts = 0;
      let timer: ReturnType<typeof setTimeout> | undefined;
      /** Where this subscription has read up to; null until the first answer arrives. */
      let cursor: string | null = null;

      /** A listener that throws must not stop the polling, or the screens beside it. */
      function notify(topic: RealtimeTopic): void {
        try {
          listener(topic);
        } catch (error) {
          console.warn(`A listener failed on a ${topic} change`, toAppError(error));
        }
      }

      function schedule(delayMs: number): void {
        if (stopped) {
          return;
        }
        timer = setTimeout(() => {
          timer = undefined;
          void poll();
        }, delayMs);
      }

      async function poll(): Promise<void> {
        if (stopped) {
          return;
        }
        try {
          const response = await client.request('GET', '/open-orders', {
            query: { since: cursor ?? undefined },
          });
          const changes = fromWire(changesSchema, response.body, 'the open order changes');
          if (stopped) {
            // Unsubscribed while the answer was in flight: its topics are nobody's business now.
            return;
          }
          attempts = 0;
          const starting = cursor === null;
          cursor = changes.cursor;
          if (!starting) {
            for (const topic of changes.topics) {
              notify(topic);
            }
          }
          schedule(intervalMs);
        } catch (error) {
          if (stopped) {
            return;
          }
          const delayMs = retryDelayMs(attempts);
          attempts += 1;
          console.warn(
            `Could not read the changes of shop ${shopId}; asking again in ${delayMs} ms`,
            toAppError(error),
          );
          schedule(delayMs);
        }
      }

      void poll();

      return () => {
        stopped = true;
        if (timer !== undefined) {
          clearTimeout(timer);
          timer = undefined;
        }
      };
    },
  };
}
