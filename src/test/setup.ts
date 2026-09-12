import 'fake-indexeddb/auto';
import { cleanup } from '@testing-library/react';
import { afterEach, beforeEach } from 'vitest';
import { installWebLocks, setSecureContext } from './browserEnv';

/**
 * Every screen test starts in the browser the register is meant to run in: a secure context with a
 * Web Locks API and an IndexedDB. A test that wants one of them gone takes it away itself.
 *
 * `fake-indexeddb/auto` is here because the composition root clears this device's stored state when
 * it builds the demo backend, and because the catalog cache is an IndexedDB store.
 */
beforeEach(() => {
  setSecureContext(true);
  installWebLocks();
});

afterEach(() => {
  cleanup();
});
