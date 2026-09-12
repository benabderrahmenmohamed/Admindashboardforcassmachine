import { describe, expect, it } from 'vitest';
import { AppError } from '@/lib/errors';
import { createInProcessDrainLock, createWebLocksDrainLock } from './locks';

// The lock that keeps two tabs from draining one terminal at the same time. Node has no Web Locks
// API, so the browser flavour runs against a stub manager that behaves as `ifAvailable` does.

interface RequestedLock {
  readonly name: string;
  readonly ifAvailable: boolean | undefined;
}

interface StubLocks {
  readonly manager: LockManager;
  readonly requested: readonly RequestedLock[];
}

/** A Web Locks manager that grants every name except the ones another tab already holds. */
function stubLocks(taken: readonly string[] = []): StubLocks {
  const requested: RequestedLock[] = [];
  const manager: LockManager = {
    query: () => Promise.resolve({ held: [], pending: [] }),
    request: async <T>(
      name: string,
      options: LockOptions | LockGrantedCallback<T>,
      callback?: LockGrantedCallback<T>,
    ): Promise<Awaited<T>> => {
      const granted = typeof options === 'function' ? options : callback;
      if (!granted) {
        return expect.unreachable('the drain lock always passes a callback');
      }
      requested.push({
        name,
        ifAvailable: typeof options === 'function' ? undefined : options.ifAvailable,
      });
      // A name another tab holds is answered with a null lock, which is what `ifAvailable` does.
      const held: Lock | null = taken.includes(name) ? null : { name, mode: 'exclusive' };
      return await granted(held);
    },
  };
  return { manager, requested };
}

/** A promise the test resolves by hand, to hold a lock for as long as it needs it. */
function heldUntilReleased(): { readonly held: Promise<void>; release: () => void } {
  let release = (): void => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { held, release: () => release() };
}

describe('createWebLocksDrainLock', () => {
  it('asks for the lock by name, and never queues behind another tab', async () => {
    const locks = stubLocks();

    await expect(
      createWebLocksDrainLock(locks.manager).runExclusive('outbox:T1', () =>
        Promise.resolve('drained'),
      ),
    ).resolves.toBe('drained');

    expect(locks.requested).toEqual([{ name: 'outbox:T1', ifAvailable: true }]);
  });

  it('says busy, and runs nothing, while another tab holds the lock', async () => {
    const locks = stubLocks(['outbox:T1']);
    let passes = 0;

    const outcome = await createWebLocksDrainLock(locks.manager).runExclusive('outbox:T1', () => {
      passes += 1;
      return Promise.resolve('drained');
    });

    expect(outcome).toBe('busy');
    expect(passes).toBe(0);
  });

  it('holds one lock per terminal, so another terminal drains just the same', async () => {
    const lock = createWebLocksDrainLock(stubLocks(['outbox:T1']).manager);

    await expect(lock.runExclusive('outbox:T2', () => Promise.resolve('drained'))).resolves.toBe(
      'drained',
    );
  });

  it('refuses with CONFIG_ERROR where the browser has no Web Locks API', async () => {
    // Web Locks need a secure context; the POS refuses to sell without one, and so does the queue.
    expect(globalThis.navigator?.locks).toBeUndefined();
    const lock = createWebLocksDrainLock(undefined);

    const pass = lock.runExclusive('outbox:T1', () => Promise.resolve('drained'));

    await expect(pass).rejects.toBeInstanceOf(AppError);
    await expect(pass).rejects.toHaveProperty('code', 'CONFIG_ERROR');
  });
});

describe('createInProcessDrainLock', () => {
  it('runs the work and gives back what it returned', async () => {
    const lock = createInProcessDrainLock();

    await expect(lock.runExclusive('outbox:T1', () => Promise.resolve(42))).resolves.toBe(42);
  });

  it('turns a second caller away while the first is still running', async () => {
    const lock = createInProcessDrainLock();
    const { held, release } = heldUntilReleased();
    let passes = 0;

    const first = lock.runExclusive('outbox:T1', async () => {
      passes += 1;
      await held;
      return 'first';
    });
    const second = await lock.runExclusive('outbox:T1', () => {
      passes += 1;
      return Promise.resolve('second');
    });

    expect(second).toBe('busy');
    expect(passes).toBe(1);
    release();
    await expect(first).resolves.toBe('first');
  });

  it('lets another name run at the same time', async () => {
    const lock = createInProcessDrainLock();
    const { held, release } = heldUntilReleased();

    const first = lock.runExclusive('outbox:T1', async () => {
      await held;
      return 'first';
    });

    await expect(lock.runExclusive('outbox:T2', () => Promise.resolve('second'))).resolves.toBe(
      'second',
    );
    release();
    await expect(first).resolves.toBe('first');
  });

  it('gives the name back when the work fails, so the next pass can run', async () => {
    const lock = createInProcessDrainLock();

    await expect(
      lock.runExclusive('outbox:T1', () => Promise.reject(new AppError('UNKNOWN', 'Boom'))),
    ).rejects.toBeInstanceOf(AppError);

    await expect(lock.runExclusive('outbox:T1', () => Promise.resolve('drained'))).resolves.toBe(
      'drained',
    );
  });

  it('lets the next caller in once the one before it finished', async () => {
    const lock = createInProcessDrainLock();

    await expect(lock.runExclusive('outbox:T1', () => Promise.resolve('first'))).resolves.toBe(
      'first',
    );
    await expect(lock.runExclusive('outbox:T1', () => Promise.resolve('second'))).resolves.toBe(
      'second',
    );
  });
});
