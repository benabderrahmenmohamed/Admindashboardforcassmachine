/**
 * Live updates over a service that holds nothing open: the adapter polls `GET /open-orders?since=`
 * and fires the topics the answer names. The port contract suites do not cover this — a backend is
 * allowed to deliver nothing at all — so what it must do is pinned down here: fire what changed and
 * only that, start from a cursor rather than a backlog, stop on unsubscribe, and never let a failed
 * poll reach the screen that subscribed.
 */
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Backend, DemoAccount, RealtimeTopic } from '@/ports';
import type { ContractFixture } from '@/ports/__contracts__';
import { createProduct, orderRecord } from '@/ports/__contracts__/support';
import { createFakeApi, demoFixture, memoryStorage, type FakeApi } from './fakeApi';
import { createRestBackend } from './index';
import { pollRetryDelayMs } from './realtime';

/** Short enough that no test waits on it, long enough to still be a real timer. */
const POLL_MS = 5;

const server = setupServer();

let api: FakeApi;
let fixture: ContractFixture;
let subscriptions: (() => void)[] = [];

beforeAll(() => {
  server.listen({ onUnhandledRequest: 'error' });
});

beforeEach(async () => {
  api = createFakeApi();
  server.use(...api.handlers);
  fixture = await demoFixture(api);
  subscriptions = [];
});

afterEach(() => {
  // A subscription that outlived its test would poll an API the next one has replaced.
  for (const stop of subscriptions) {
    stop();
  }
  server.resetHandlers();
  server.events.removeAllListeners();
  vi.restoreAllMocks();
});

afterAll(() => {
  server.close();
});

function apiPath(path: string): string {
  return `${api.baseUrl}/api/v1${path}`;
}

function accountOf(email: string): DemoAccount {
  const account = api.backend.demoAccounts.find((candidate) => candidate.email === email);
  if (!account) {
    return expect.unreachable(`The API offers no demo account for ${email}`);
  }
  return account;
}

/** A device of its own, signed in, that polls fast enough for a test to watch it. */
async function watchingDevice(): Promise<Backend> {
  const account = accountOf(fixture.cashierUser.email);
  const storage = memoryStorage();
  const backend = createRestBackend({
    baseUrl: api.baseUrl,
    storage: () => storage,
    storageKey: 'rest-watcher',
    realtime: { intervalMs: POLL_MS, retryDelayMs: () => POLL_MS },
  });
  await backend.auth.signIn({ email: account.email, password: account.password });
  return backend;
}

/** Subscribes and collects what it is told; the subscription ends with the test whatever happens. */
function watch(backend: Backend): { readonly seen: RealtimeTopic[]; readonly stop: () => void } {
  const seen: RealtimeTopic[] = [];
  const stop = backend.realtime.subscribe(fixture.cashierUser.shopId, (topic) => {
    seen.push(topic);
  });
  subscriptions.push(stop);
  return { seen, stop };
}

/** How many polls the API has answered, counted from the call. */
function pollCount(): () => number {
  let polls = 0;
  server.events.on('response:mocked', ({ request }) => {
    if (new URL(request.url).pathname === '/api/v1/open-orders') {
      polls += 1;
    }
  });
  return () => polls;
}

/** The poll count after long enough for ten more polls, had anything still been polling. */
async function afterAWhile(polls: () => number): Promise<number> {
  await new Promise((resolve) => setTimeout(resolve, POLL_MS * 10));
  return polls();
}

/** Puts one item on `tableId` as the waiter: one add, two topics — the order and its items. */
async function addAnItem(tableId: string, productId: string): Promise<void> {
  await fixture.waiter.orders.addItem(
    await orderRecord({ tableId, productId, qty: 1, note: '' }, { deviceId: 'device-realtime' }),
  );
}

describe('live updates by polling', () => {
  it('fires the topics that changed, and nothing for what happened before it subscribed', async () => {
    const table = await fixture.newTable();
    const product = await createProduct(fixture, 'Express', 1_900);
    const polls = pollCount();
    const backend = await watchingDevice();

    const { seen } = watch(backend);

    // The first answer is a cursor: the table and the product above are already in what a screen
    // read before it subscribed, so nothing of them is fired.
    await vi.waitFor(() => {
      expect(polls()).toBeGreaterThan(0);
    });
    expect(seen).toEqual([]);

    await addAnItem(table.id, product.id);

    await vi.waitFor(() => {
      expect([...new Set(seen)].sort()).toEqual(['open_order_items', 'open_orders']);
    });
  });

  it('stops polling on unsubscribe, and tells its listener nothing afterwards', async () => {
    const table = await fixture.newTable();
    const product = await createProduct(fixture, 'Thé', 2_100);
    const polls = pollCount();
    const backend = await watchingDevice();
    const { seen, stop } = watch(backend);
    await vi.waitFor(() => {
      expect(polls()).toBeGreaterThan(1);
    });

    stop();

    // A poll already in flight may still land, so the proof is that the count then stops moving.
    const settled = await afterAWhile(polls);
    await addAnItem(table.id, product.id);
    expect(await afterAWhile(polls)).toBe(settled);
    expect(seen).toEqual([]);
  });

  it('retries a failed poll instead of telling the caller about it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    let answered = 0;
    server.use(
      http.get(apiPath('/open-orders'), () => {
        answered += 1;
        if (answered === 1) {
          return HttpResponse.error();
        }
        // The first answer that arrives is the cursor, so its topics are not fired; later ones are.
        return HttpResponse.json(
          answered === 2
            ? { cursor: '1', topics: ['products'] }
            : { cursor: '2', topics: ['dining_tables'] },
          { status: 200 },
        );
      }),
    );
    const backend = await watchingDevice();

    const { seen } = watch(backend);

    await vi.waitFor(() => {
      expect(seen).toContain('dining_tables');
    });
    expect(seen).not.toContain('products');
    // Reported, never swallowed: a person reading the console sees why a screen went quiet.
    expect(warn).toHaveBeenCalled();
  });

  it('waits longer after each failed poll, up to a minute', () => {
    const lowest = [0, 1, 5, 10, 20].map((attempt) => pollRetryDelayMs(attempt, () => 0));

    // 500 ms doubling per attempt and capped at a minute, halved by the jitter at its lowest.
    expect(lowest).toEqual([250, 500, 8_000, 30_000, 30_000]);
    expect(pollRetryDelayMs(3, () => 1)).toBe(4_000);
  });
});
