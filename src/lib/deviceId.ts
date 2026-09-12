import { AppError } from './errors';

/**
 * This device's identity, as the spec asks for it: a uuid kept in `localStorage` and carried on
 * every order event, so the server and the admin can tell which phone or till wrote what.
 *
 * It is not the terminal registration — a waiter's phone has a device id and no terminal — and it
 * outlives who is signed in on it. A browser that refuses storage (private mode, storage disabled)
 * still gets a working id; it simply changes on every reload, which is exactly what that browser is.
 */
const DEVICE_ID_KEY = 'pos.deviceId';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

let inMemory: string | null = null;

function newId(): string {
  if (typeof crypto.randomUUID !== 'function') {
    // Missing outside a secure context: a page served over plain http from another machine.
    throw new AppError(
      'CONFIG_ERROR',
      'Serve the app over https so this device can be identified.',
    );
  }
  return crypto.randomUUID();
}

/** The store, or null when the browser refuses one. Reading it can throw, so it is asked carefully. */
function store(): Storage | null {
  try {
    const candidate: Storage | undefined = globalThis.localStorage;
    return candidate ?? null;
  } catch {
    return null;
  }
}

/** What the store holds under the key, or null when it holds nothing or refuses to be read. */
function read(storage: Storage): string | null {
  try {
    return storage.getItem(DEVICE_ID_KEY);
  } catch {
    return null;
  }
}

/**
 * The id of this device, made on first use and kept from then on. Anything unreadable in storage —
 * a value from an older version, or something another script wrote — is replaced rather than sent.
 */
export function deviceId(): string {
  const storage = store();
  if (storage === null) {
    inMemory ??= newId();
    return inMemory;
  }
  const stored = read(storage);
  if (stored !== null && UUID.test(stored)) {
    return stored;
  }
  // An id this tab already made that the store would not keep: it is still this device's id.
  if (inMemory !== null) {
    return inMemory;
  }
  const id = newId();
  try {
    storage.setItem(DEVICE_ID_KEY, id);
  } catch {
    // A full or blocked store means this id lasts the tab and no longer; the events still go out.
    inMemory = id;
  }
  return id;
}

/** For tests and for the demo backend, which starts from nothing on every reload. */
export function forgetDeviceId(): void {
  inMemory = null;
  try {
    store()?.removeItem(DEVICE_ID_KEY);
  } catch {
    // Nothing to forget in a browser that has no store.
  }
}
