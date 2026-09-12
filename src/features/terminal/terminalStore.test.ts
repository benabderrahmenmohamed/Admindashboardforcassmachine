import { afterEach, describe, expect, it, vi } from 'vitest';
import { openRecord, saleRecord } from '@/features/pos/__fixtures__/records';
import { createMemoryOutboxStorage } from '@/features/sync/memoryStorage';
import type { OutboxMeta, OutboxRecord, OutboxStorage } from '@/features/sync/types';
import { AppError } from '@/lib/errors';
import type { TerminalRegistration } from '@/ports';
import {
  assertCanRegister,
  LEGACY_PENDING_KEY,
  LEGACY_TERMINAL_KEY,
  migrateLegacyTerminal,
  readRegistration,
  registerTerminal,
  type KeyValueStorage,
} from './terminalStore';

// Black-box tests of this device's registration in the outbox's meta store: the receipt counter
// never goes back, registering waits for the queue to empty, and a Phase 3 device moves over once.

const NOW = Date.parse('2026-09-12T07:00:00.000Z');

class MemoryKeyValue implements KeyValueStorage {
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

function registration(overrides: Partial<TerminalRegistration> = {}): TerminalRegistration {
  return {
    terminalId: 'terminal-t1',
    code: 'T1',
    epoch: 1,
    lastSeq: 41,
    openSession: null,
    ...overrides,
  };
}

/** A storage with one record in the queue, so registering is refused while it is unfinished. */
async function withRecord(record: OutboxRecord): Promise<OutboxStorage> {
  const storage = createMemoryOutboxStorage();
  const meta = await registerTerminal(storage, registration(), NOW);
  const added = await storage.appendIfUnchanged(
    { lastSeq: meta.lastSeq, nextOrdinal: meta.nextOrdinal },
    { ...record, ordinal: meta.nextOrdinal },
    { ...meta, nextOrdinal: meta.nextOrdinal + 1 },
  );
  expect(added).toBe(true);
  return storage;
}

async function expectCode(action: () => Promise<unknown>, code: string): Promise<void> {
  const error = await action().then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(AppError);
  expect(error).toHaveProperty('code', code);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('registerTerminal', () => {
  it('starts with nothing and adopts what the server reports', async () => {
    const storage = createMemoryOutboxStorage();
    expect(await readRegistration(storage)).toBeNull();

    const meta = await registerTerminal(storage, registration(), NOW);

    expect(meta).toEqual<OutboxMeta>({
      terminalId: 'terminal-t1',
      code: 'T1',
      epoch: 1,
      lastSeq: 41,
      nextOrdinal: 1,
      registeredAt: NOW,
    });
    expect(await readRegistration(storage)).toEqual(meta);
  });

  it('keeps the higher number when the same terminal is registered again', async () => {
    const storage = createMemoryOutboxStorage();
    await registerTerminal(storage, registration({ lastSeq: 45 }), NOW);

    const again = await registerTerminal(storage, registration({ epoch: 2, lastSeq: 43 }), NOW);

    expect(again).toMatchObject({ epoch: 2, lastSeq: 45 });
  });

  it('takes the server number when the same code is another terminal, even a lower one', async () => {
    // The shop was reset: T1 is a new row that has numbered nothing yet. Keeping this device's
    // counter would leave it ahead of the server, and every sale would be a SEQUENCE_GAP.
    const storage = createMemoryOutboxStorage();
    await registerTerminal(storage, registration({ lastSeq: 45 }), NOW);

    const fresh = await registerTerminal(
      storage,
      registration({ terminalId: 'terminal-t1-new', lastSeq: 0 }),
      NOW,
    );

    expect(fresh).toMatchObject({ terminalId: 'terminal-t1-new', code: 'T1', lastSeq: 0 });
  });

  it('adopts the server number when another terminal code is registered', async () => {
    const storage = createMemoryOutboxStorage();
    await registerTerminal(storage, registration({ lastSeq: 45 }), NOW);

    const other = await registerTerminal(
      storage,
      registration({ terminalId: 'terminal-t2', code: 'T2', epoch: 0, lastSeq: 3 }),
      NOW,
    );

    expect(other).toMatchObject({ code: 'T2', lastSeq: 3 });
  });

  it('never reuses an ordinal, because the records that took them are still in the queue', async () => {
    const storage = await withRecord(saleRecord({ seq: 42, status: 'acked' }));

    const again = await registerTerminal(storage, registration({ epoch: 2 }), NOW);

    expect(again.nextOrdinal).toBe(2);
    expect((await storage.list()).map((record) => record.ordinal)).toEqual([1]);
  });
});

describe('registering while the queue still has records', () => {
  it.each(['pending', 'sending', 'conflict'] as const)(
    'is refused with VALIDATION_ERROR while a record is %s',
    async (status) => {
      const storage = await withRecord(saleRecord({ seq: 42, status }));
      const before = await readRegistration(storage);

      await expectCode(() => assertCanRegister(storage), 'VALIDATION_ERROR');
      await expectCode(
        () => registerTerminal(storage, registration({ epoch: 9 }), NOW),
        'VALIDATION_ERROR',
      );
      expect(await readRegistration(storage)).toEqual(before);
    },
  );

  it.each(['acked', 'voided'] as const)('is allowed once every record is %s', async (status) => {
    const storage = await withRecord(openRecord({ status }));

    await expect(assertCanRegister(storage)).resolves.toBeUndefined();
    expect((await registerTerminal(storage, registration({ epoch: 2 }), NOW)).epoch).toBe(2);
  });
});

describe('migrateLegacyTerminal', () => {
  const legacyTerminal = {
    terminalId: 'terminal-t1',
    code: 'T1',
    epoch: 1,
    lastSeq: 41,
    registeredAt: '2026-09-11T07:00:00.000Z',
  };

  function phase3(pending?: unknown): MemoryKeyValue {
    const keyValue = new MemoryKeyValue();
    keyValue.setItem(LEGACY_TERMINAL_KEY, JSON.stringify(legacyTerminal));
    if (pending !== undefined) {
      keyValue.setItem(LEGACY_PENDING_KEY, JSON.stringify(pending));
    }
    return keyValue;
  }

  it('moves the registration and the unsent record into the queue, then drops the old keys', async () => {
    const storage = createMemoryOutboxStorage();
    const unsent = saleRecord({ seq: 42 });
    const keyValue = phase3({ type: 'sale', record: unsent.payload });

    const moved = await migrateLegacyTerminal(storage, NOW, keyValue);

    expect(moved).toEqual({ terminal: true, record: true });
    expect(await readRegistration(storage)).toEqual<OutboxMeta>({
      terminalId: 'terminal-t1',
      code: 'T1',
      epoch: 1,
      // Phase 3 committed a number only once the server answered, so the record holds 42 and the
      // counter has not reached it: the queue must not hand 42 out again.
      lastSeq: 42,
      nextOrdinal: 2,
      registeredAt: Date.parse(legacyTerminal.registeredAt),
    });
    const [record] = await storage.list();
    expect(record).toMatchObject({
      id: unsent.payload.id,
      kind: 'sale',
      seq: 42,
      ordinal: 1,
      status: 'pending',
      payloadHash: unsent.payload.payloadHash,
    });
    expect(keyValue.items.size).toBe(0);
  });

  it('moves a session record without touching the receipt counter', async () => {
    const storage = createMemoryOutboxStorage();
    const unsent = openRecord();
    const keyValue = phase3({ type: 'session_open', record: unsent.payload });

    await migrateLegacyTerminal(storage, NOW, keyValue);

    expect(await readRegistration(storage)).toMatchObject({ lastSeq: 41, nextOrdinal: 2 });
    expect((await storage.list())[0]).toMatchObject({ kind: 'session_open', seq: null });
  });

  it('moves a registration on its own', async () => {
    const storage = createMemoryOutboxStorage();
    const keyValue = phase3();

    expect(await migrateLegacyTerminal(storage, NOW, keyValue)).toEqual({
      terminal: true,
      record: false,
    });
    expect(await readRegistration(storage)).toMatchObject({ lastSeq: 41, nextOrdinal: 1 });
  });

  it('does nothing on a device that never had the old keys', async () => {
    const storage = createMemoryOutboxStorage();

    expect(await migrateLegacyTerminal(storage, NOW, new MemoryKeyValue())).toEqual({
      terminal: false,
      record: false,
    });
    expect(await readRegistration(storage)).toBeNull();
  });

  it('keeps a Phase 4 registration and only drops the stale keys', async () => {
    const storage = createMemoryOutboxStorage();
    const meta = await registerTerminal(storage, registration({ epoch: 7, lastSeq: 3 }), NOW);
    const keyValue = phase3({ type: 'sale', record: saleRecord({ seq: 42 }).payload });

    expect(await migrateLegacyTerminal(storage, NOW, keyValue)).toEqual({
      terminal: false,
      record: false,
    });
    expect(await readRegistration(storage)).toEqual(meta);
    expect(await storage.list()).toEqual([]);
    expect(keyValue.items.size).toBe(0);
  });

  it('drops an unsent record that has no registration to be sent under', async () => {
    const storage = createMemoryOutboxStorage();
    const keyValue = new MemoryKeyValue();
    keyValue.setItem(
      LEGACY_PENDING_KEY,
      JSON.stringify({ type: 'sale', record: saleRecord({ seq: 42 }).payload }),
    );

    expect(await migrateLegacyTerminal(storage, NOW, keyValue)).toEqual({
      terminal: false,
      record: false,
    });
    expect(await readRegistration(storage)).toBeNull();
    expect(keyValue.items.size).toBe(0);
  });

  it('reports a stored value it cannot read and carries on without it', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const storage = createMemoryOutboxStorage();
    const keyValue = phase3({ type: 'sale', record: { id: 'not a record' } });

    expect(await migrateLegacyTerminal(storage, NOW, keyValue)).toEqual({
      terminal: true,
      record: false,
    });
    expect(logged).toHaveBeenCalled();
    expect(await storage.list()).toEqual([]);
    expect(keyValue.items.size).toBe(0);
  });

  it('does nothing at all without local storage', async () => {
    const storage = createMemoryOutboxStorage();
    expect(await migrateLegacyTerminal(storage, NOW, null)).toEqual({
      terminal: false,
      record: false,
    });
  });
});
