import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '@/lib/errors';
import { mm } from '@/lib/money';
import {
  createTerminalStore,
  type KeyValueStorage,
  type PendingRecord,
  type StoredTerminal,
} from './terminalStore';

// Black-box tests of this device's terminal store over an in-memory storage: the receipt counter
// never goes back, registration waits for an unsent record, snapshots keep their identity until
// something changes, and subscribers hear about every change.

class MemoryStorage implements KeyValueStorage {
  readonly items = new Map<string, string>();

  getItem(key: string): string | null {
    return this.items.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.items.set(key, value);
  }

  removeItem(key: string): void {
    this.items.delete(key);
  }
}

function registration(overrides: Partial<StoredTerminal> = {}): StoredTerminal {
  return {
    terminalId: 'terminal-t1',
    code: 'T1',
    epoch: 1,
    lastSeq: 41,
    registeredAt: '2026-09-11T07:00:00.000Z',
    ...overrides,
  };
}

const pendingOpen: PendingRecord = {
  type: 'session_open',
  record: {
    id: 'a3b1c2d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d',
    terminalCode: 'T1',
    epoch: 1,
    actorUserId: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
    openedAt: '2026-09-11T08:00:00.000Z',
    openingFloatMillimes: mm(50_000),
    payloadHash: 'ba8d211d41c6559c460680954985fe82d6323e4e0e97b3e4b6d3004e26184a2c',
  },
};

function expectCode(action: () => unknown, code: string): void {
  let error: unknown;
  try {
    action();
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(AppError);
  expect(error).toHaveProperty('code', code);
}

/** The storage keys the store writes its registration and its pending record under. */
function storageKeys(): { terminalKey: string; pendingKey: string } {
  const storage = new MemoryStorage();
  const store = createTerminalStore(storage);
  store.register(registration());
  const [terminalKey] = [...storage.items.keys()];
  store.writePending(pendingOpen);
  const pendingKey = [...storage.items.keys()].find((key) => key !== terminalKey) ?? '';
  return { terminalKey, pendingKey };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('createTerminalStore', () => {
  it('starts with no registration and no pending record', () => {
    const store = createTerminalStore(new MemoryStorage());

    expect(store.read()).toBeNull();
    expect(store.readPending()).toBeNull();
    expect(store.snapshot()).toEqual({ terminal: null, pending: null });
  });

  it('keeps the registration and the pending record, same id and hash, across a reload', () => {
    const storage = new MemoryStorage();
    const store = createTerminalStore(storage);
    store.register(registration());
    store.commitSeq(42);
    store.writePending(pendingOpen);

    const reloaded = createTerminalStore(storage);

    expect(reloaded.read()).toEqual(registration({ lastSeq: 42 }));
    expect(reloaded.readPending()).toEqual(pendingOpen);
  });

  it('clears the registration and the pending record separately', () => {
    const store = createTerminalStore(new MemoryStorage());
    store.register(registration());
    store.writePending(pendingOpen);

    store.clearPending();
    expect(store.snapshot()).toEqual({ terminal: registration(), pending: null });
    store.clear();
    expect(store.snapshot()).toEqual({ terminal: null, pending: null });
  });
});

describe('the receipt counter', () => {
  it('moves forward with commitSeq and never goes back', () => {
    const storage = new MemoryStorage();
    const store = createTerminalStore(storage);
    store.register(registration({ lastSeq: 41 }));

    const seen: number[] = [];
    for (const seq of [42, 43, 40, 43, 0, 44]) {
      store.commitSeq(seq);
      seen.push(store.read()?.lastSeq ?? -1);
    }

    expect(seen).toEqual([42, 43, 43, 43, 43, 44]);
    expect(createTerminalStore(storage).read()?.lastSeq).toBe(44);
  });

  it('keeps the higher number when the same terminal code is registered again', () => {
    const store = createTerminalStore(new MemoryStorage());
    store.register(registration({ epoch: 1, lastSeq: 41 }));
    store.commitSeq(45);

    store.register(registration({ epoch: 2, lastSeq: 43 }));
    expect(store.read()).toEqual(registration({ epoch: 2, lastSeq: 45 }));

    store.register(registration({ terminalId: 'terminal-t1b', epoch: 3, lastSeq: 50 }));
    expect(store.read()).toEqual(
      registration({ terminalId: 'terminal-t1b', epoch: 3, lastSeq: 50 }),
    );
  });

  it('takes the server number when the same code is another terminal, even a lower one', () => {
    // The shop was reset: T1 is a new row that has numbered nothing yet. Keeping this device's
    // counter would leave it ahead of the server, and every sale would be a SEQUENCE_GAP.
    const store = createTerminalStore(new MemoryStorage());
    store.register(registration({ terminalId: 'terminal-t1', lastSeq: 41 }));
    store.commitSeq(45);

    store.register(registration({ terminalId: 'terminal-t1-new', epoch: 1, lastSeq: 0 }));

    expect(store.read()).toMatchObject({ code: 'T1', terminalId: 'terminal-t1-new', lastSeq: 0 });
  });

  it('adopts the server number when another terminal code is registered', () => {
    const store = createTerminalStore(new MemoryStorage());
    store.register(registration({ lastSeq: 45 }));

    store.register(registration({ terminalId: 'terminal-t2', code: 'T2', epoch: 0, lastSeq: 3 }));

    expect(store.read()).toMatchObject({ code: 'T2', lastSeq: 3 });
  });

  it('refuses to note a number on a device that is not registered, with CONFIG_ERROR', () => {
    const store = createTerminalStore(new MemoryStorage());

    expectCode(() => store.commitSeq(1), 'CONFIG_ERROR');
    expect(store.read()).toBeNull();
  });
});

describe('registering while a record is unsent', () => {
  it('is refused with VALIDATION_ERROR and changes nothing', () => {
    const store = createTerminalStore(new MemoryStorage());
    store.register(registration());
    store.writePending(pendingOpen);
    const before = store.snapshot();

    expectCode(() => store.assertCanRegister(), 'VALIDATION_ERROR');
    expectCode(() => store.register(registration({ epoch: 2 })), 'VALIDATION_ERROR');
    expectCode(() => store.register(registration({ code: 'T2', lastSeq: 0 })), 'VALIDATION_ERROR');

    expect(store.snapshot()).toBe(before);
    expect(store.read()).toEqual(registration());
    expect(store.readPending()).toEqual(pendingOpen);
  });

  it('is refused on a device holding only a pending record', () => {
    const store = createTerminalStore(new MemoryStorage());
    store.writePending(pendingOpen);

    expectCode(() => store.register(registration()), 'VALIDATION_ERROR');
    expect(store.read()).toBeNull();
  });

  it('is allowed again once the pending record is cleared', () => {
    const store = createTerminalStore(new MemoryStorage());
    store.register(registration());
    store.writePending(pendingOpen);

    store.clearPending();

    expect(() => store.assertCanRegister()).not.toThrow();
    store.register(registration({ epoch: 2 }));
    expect(store.read()?.epoch).toBe(2);
  });
});

describe('snapshot', () => {
  it('returns the same object until something changes', () => {
    const store = createTerminalStore(new MemoryStorage());
    store.register(registration({ lastSeq: 41 }));
    const first = store.snapshot();

    expect(store.snapshot()).toBe(first);
    expect(store.read()).toBe(first.terminal);

    store.commitSeq(40);
    expect(store.snapshot()).toBe(first);

    store.commitSeq(42);
    const second = store.snapshot();
    expect(second).not.toBe(first);
    expect(second.terminal?.lastSeq).toBe(42);
    expect(store.snapshot()).toBe(second);

    store.writePending(pendingOpen);
    const third = store.snapshot();
    expect(third).not.toBe(second);
    expect(third.pending).toEqual(pendingOpen);
    expect(store.readPending()).toBe(third.pending);

    store.clearPending();
    expect(store.snapshot()).not.toBe(third);
    expect(store.snapshot().pending).toBeNull();
  });

  it('keeps the same object when a write stores what was already there', () => {
    const store = createTerminalStore(new MemoryStorage());
    store.register(registration());
    const before = store.snapshot();

    store.register(registration());

    expect(store.snapshot()).toBe(before);
  });

  it('picks up a change another tab wrote to the same storage', () => {
    const storage = new MemoryStorage();
    const store = createTerminalStore(storage);
    store.register(registration({ lastSeq: 41 }));
    const before = store.snapshot();

    createTerminalStore(storage).commitSeq(42);

    expect(store.snapshot()).not.toBe(before);
    expect(store.read()?.lastSeq).toBe(42);
  });
});

describe('subscribe', () => {
  it('notifies every listener of each change made through the store', () => {
    const store = createTerminalStore(new MemoryStorage());
    const one = vi.fn();
    const two = vi.fn();
    store.subscribe(one);
    store.subscribe(two);

    store.register(registration());
    store.commitSeq(42);
    store.writePending(pendingOpen);
    store.clearPending();
    store.clear();

    expect(one).toHaveBeenCalledTimes(5);
    expect(two).toHaveBeenCalledTimes(5);
  });

  it('does not notify for a number that does not move the counter', () => {
    const store = createTerminalStore(new MemoryStorage());
    store.register(registration({ lastSeq: 41 }));
    const listener = vi.fn();
    store.subscribe(listener);

    store.commitSeq(41);
    store.commitSeq(3);

    expect(listener).not.toHaveBeenCalled();
  });

  it('stops notifying a listener once it unsubscribes, and keeps notifying the others', () => {
    const store = createTerminalStore(new MemoryStorage());
    const leaving = vi.fn();
    const staying = vi.fn();
    const unsubscribe = store.subscribe(leaving);
    store.subscribe(staying);

    store.register(registration());
    unsubscribe();
    store.commitSeq(42);

    expect(leaving).toHaveBeenCalledTimes(1);
    expect(staying).toHaveBeenCalledTimes(2);
  });

  it('notifies for storage events about its own keys from other tabs, and stops listening on unsubscribe', () => {
    const handlers = new Set<(event: StorageEvent) => void>();
    vi.stubGlobal('addEventListener', (type: string, handler: (event: StorageEvent) => void) => {
      if (type === 'storage') {
        handlers.add(handler);
      }
    });
    vi.stubGlobal('removeEventListener', (type: string, handler: (event: StorageEvent) => void) => {
      if (type === 'storage') {
        handlers.delete(handler);
      }
    });
    const { terminalKey, pendingKey } = storageKeys();
    const store = createTerminalStore(new MemoryStorage());
    const listener = vi.fn();
    const storageEvent = (key: string | null) => ({ key }) as StorageEvent;
    const dispatch = (key: string | null) =>
      handlers.forEach((handler) => handler(storageEvent(key)));

    const unsubscribe = store.subscribe(listener);
    expect(handlers.size).toBe(1);

    dispatch(terminalKey);
    dispatch(pendingKey);
    // A null key means another tab cleared the whole storage.
    dispatch(null);
    dispatch('sb-auth-token');
    expect(listener).toHaveBeenCalledTimes(3);

    unsubscribe();
    expect(handlers.size).toBe(0);
  });
});

describe('unreadable or missing storage', () => {
  it('ignores a stored value it cannot read, and reports it', () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { terminalKey, pendingKey } = storageKeys();
    const storage = new MemoryStorage();
    storage.setItem(terminalKey, '{not json');
    storage.setItem(pendingKey, JSON.stringify({ type: 'sale', record: { id: 'x' } }));
    const store = createTerminalStore(storage);

    expect(store.read()).toBeNull();
    expect(store.readPending()).toBeNull();
    expect(logged).toHaveBeenCalled();

    storage.setItem(terminalKey, JSON.stringify(registration({ lastSeq: -1 })));
    expect(store.read()).toBeNull();
  });

  it('reads nothing without storage and refuses to write with CONFIG_ERROR', () => {
    const store = createTerminalStore(null);

    expect(store.snapshot()).toEqual({ terminal: null, pending: null });
    expectCode(() => store.register(registration()), 'CONFIG_ERROR');
    expectCode(() => store.writePending(pendingOpen), 'CONFIG_ERROR');
  });
});
