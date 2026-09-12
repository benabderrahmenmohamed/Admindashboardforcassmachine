import { useSyncExternalStore } from 'react';

function subscribe(onChange: () => void): () => void {
  globalThis.addEventListener?.('online', onChange);
  globalThis.addEventListener?.('offline', onChange);
  return () => {
    globalThis.removeEventListener?.('online', onChange);
    globalThis.removeEventListener?.('offline', onChange);
  };
}

/** What the browser thinks; a reachable network still says nothing about the server being up. */
function isOnline(): boolean {
  return globalThis.navigator?.onLine ?? true;
}

/** Whether this device has a network at all, following the browser's own events. */
export function useOnline(): boolean {
  return useSyncExternalStore(subscribe, isOnline, () => true);
}
