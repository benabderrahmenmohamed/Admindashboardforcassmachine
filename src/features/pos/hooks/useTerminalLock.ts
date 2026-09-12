import { useEffect, useState } from 'react';
import type { TerminalLock } from '../gate';

/** What the lock request answered, and which terminal it answered for. */
interface Held {
  readonly code: string;
  readonly state: TerminalLock;
}

/**
 * Holds the Web Lock `terminal:<code>` for as long as the register is on screen. Only the tab that
 * holds it may sell: receipt numbers are gapless because one writer allocates them, and a second tab
 * allocating at the same time would hand the same number out twice. `ifAvailable` means a tab that
 * finds the lock taken hears so at once instead of queueing behind the tab that has it.
 */
export function useTerminalLock(code: string | null): TerminalLock {
  const [held, setHeld] = useState<Held | null>(null);
  const locks: LockManager | undefined = globalThis.navigator?.locks;

  useEffect(() => {
    if (code === null || !locks) {
      return;
    }
    let release = (): void => undefined;
    const holding = new Promise<void>((resolve) => {
      release = resolve;
    });
    let live = true;

    void locks
      .request(`terminal:${code}`, { ifAvailable: true }, async (lock) => {
        if (!live) {
          return;
        }
        setHeld({ code, state: lock ? 'held' : 'taken' });
        if (lock) {
          // The callback's promise is the lock's lifetime: it is held until this effect is cleaned up.
          await holding;
        }
      })
      .catch((error: unknown) => {
        console.error('This device could not take the terminal lock', error);
        if (live) {
          setHeld({ code, state: 'unavailable' });
        }
      });

    return () => {
      live = false;
      release();
    };
  }, [code, locks]);

  if (code === null) {
    return 'pending';
  }
  if (!locks) {
    // No Web Locks: this browser cannot tell one tab from another, so nothing may sell.
    return 'unavailable';
  }
  // An answer about another terminal says nothing about this one: wait for its own.
  return held?.code === code ? held.state : 'pending';
}
