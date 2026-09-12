/**
 * The memory backend's own fault injector, reachable from a test.
 *
 * `createMemoryBackend()` builds one injector and keeps it to itself: the composition root takes no
 * options, and nothing in the app hands it out, so a test that wants the commit-then-drop fault has
 * to reach the module that makes it. The dev server serves every source file as its own ES module,
 * so this appends a few lines to `src/adapters/memory/faults.ts` as it is served, which record each
 * injector the module makes and hand its queue to the test.
 *
 * Nothing else changes: the app under test still runs its own composition root, its own outbox and
 * the real memory backend, and with no fault armed every call behaves exactly as it does untouched.
 * Should the app ever offer a supported way in — a demo control, a query parameter — this whole
 * module goes and `armCommitThenDrop` uses it instead.
 */
import type { Page } from '@playwright/test';

/** What the injector did with a call: ran it, dropped its answer, or failed it outright. */
export type FaultEffect = 'run' | 'drop' | 'fail';

/** One call of a port method, as the injector saw it. */
export interface FaultCall {
  readonly operation: string;
  readonly effect: FaultEffect;
}

interface MemoryFaultHook {
  /** The next `times` calls (default 1) of `operation` commit and then lose their answer. */
  dropNext(operation: string, times?: number): void;
  /** Every call the injector has seen, oldest first. */
  calls(): FaultCall[];
}

declare global {
  interface Window {
    readonly __posMemoryFaults?: MemoryFaultHook;
  }
}

/** The path of the module that makes the injector, as the dev server serves it. */
const FAULTS_MODULE = '/src/adapters/memory/faults.ts';

/**
 * Appended to that module. It runs at module evaluation, so it is in place long before the backend
 * is built. `createFaultInjector` is a function declaration, so the module can put a wrapper in its
 * place and everything importing it gets the wrapper.
 */
const HOOK_SOURCE = `
/* Appended by e2e/support/memoryFaults.ts. Not part of the app. */
{
  const seen = [];
  const made = [];
  const build = createFaultInjector;
  createFaultInjector = (...args) => {
    const injector = build(...args);
    made.push(injector);
    return {
      ...injector,
      check(operation) {
        try {
          const effect = injector.check(operation);
          seen.push({ operation, effect });
          return effect;
        } catch (error) {
          seen.push({ operation, effect: 'fail' });
          throw error;
        }
      },
    };
  };
  window.__posMemoryFaults = {
    dropNext(operation, times) {
      const injector = made[0];
      if (!injector) {
        throw new Error('The memory backend has not built its fault injector yet.');
      }
      injector.dropNext(operation, times);
    },
    calls: () => seen.slice(),
  };
}
`;

/**
 * Puts the hook in place. Call it before the first navigation, so the module is patched by the time
 * the app imports it.
 */
export async function installMemoryFaultHook(page: Page): Promise<void> {
  await page.route(
    (url) => url.pathname === FAULTS_MODULE,
    async (route) => {
      const response = await route.fetch();
      const headers = { ...response.headers() };
      // The body grows; letting the old length stand would cut the module short.
      delete headers['content-length'];
      await route.fulfill({ response, headers, body: `${await response.text()}\n${HOOK_SOURCE}` });
    },
  );
}

/**
 * Arms the next `times` calls of `operation` to commit and then lose their answer, as a response
 * lost on the way back: the backend holds the record, the device never hears so, and the replay it
 * sends next has to return the stored outcome rather than record it twice.
 */
export async function armCommitThenDrop(page: Page, operation: string, times = 1): Promise<void> {
  await page.evaluate(
    ([name, count]) => {
      const hook = window.__posMemoryFaults;
      if (!hook) {
        throw new Error('The memory fault hook is not installed on this page.');
      }
      hook.dropNext(name, count);
    },
    [operation, times] as const,
  );
}

/** Every call the backend's injector has seen so far. */
export function faultCalls(page: Page): Promise<FaultCall[]> {
  return page.evaluate(() => window.__posMemoryFaults?.calls() ?? []);
}
