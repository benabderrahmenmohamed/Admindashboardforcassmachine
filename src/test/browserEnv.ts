/**
 * The two browser APIs the register needs that jsdom does not implement: `isSecureContext` and the
 * Web Locks API. Both are read from globals by code that has no way to take them as an argument —
 * `PosPage` reads `globalThis.isSecureContext`, `useTerminalLock` reads `navigator.locks` — so a
 * test that wants a register on screen has to put them there. Everything else the outbox needs is
 * injected, so the runtime is built with fakes instead (see harness.tsx).
 *
 * Both are also states a real register can be in, so a test can turn either one off and read what
 * the screen says about it.
 */

/** A Web Locks API for one JavaScript context: enough for `ifAvailable` requests, which is all the app makes. */
export interface FakeLockManager extends LockManager {
  /** Takes `name` the way another tab would, until the returned function gives it back. */
  hold(name: string): () => void;
}

export function createFakeLockManager(): FakeLockManager {
  const held = new Set<string>();

  async function request<T>(
    name: string,
    optionsOrCallback: LockOptions | LockGrantedCallback<T>,
    maybeCallback?: LockGrantedCallback<T>,
  ): Promise<Awaited<T>> {
    const options: LockOptions = typeof optionsOrCallback === 'function' ? {} : optionsOrCallback;
    const callback = typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback;
    if (!callback) {
      throw new TypeError('A lock request needs a callback');
    }
    if (!options.ifAvailable) {
      // The app only ever asks with ifAvailable; queueing behind a held lock is not implemented,
      // and a test that needs it should hear so rather than hang.
      throw new Error('This fake LockManager only implements ifAvailable requests');
    }
    if (held.has(name)) {
      return await callback(null);
    }
    held.add(name);
    try {
      return await callback({ name, mode: options.mode ?? 'exclusive' });
    } finally {
      held.delete(name);
    }
  }

  return {
    request,
    query: () =>
      Promise.resolve({
        held: [...held].map((name) => ({ name, mode: 'exclusive' as const })),
        pending: [],
      }),
    hold(name) {
      let release = (): void => undefined;
      void request(
        name,
        { ifAvailable: true },
        () =>
          new Promise<void>((resolve) => {
            release = resolve;
          }),
      );
      return () => release();
    },
  };
}

/** `window.isSecureContext`: true everywhere the register is allowed to run. */
export function setSecureContext(secure: boolean): void {
  Object.defineProperty(globalThis, 'isSecureContext', { value: secure, configurable: true });
}

/** Gives this context a Web Locks API and returns it, so a test can take a lock from another tab. */
export function installWebLocks(): FakeLockManager {
  const locks = createFakeLockManager();
  Object.defineProperty(globalThis.navigator, 'locks', { value: locks, configurable: true });
  return locks;
}

/** A browser with no Web Locks API at all, like a page served over plain http. */
export function removeWebLocks(): void {
  Object.defineProperty(globalThis.navigator, 'locks', { value: undefined, configurable: true });
}
