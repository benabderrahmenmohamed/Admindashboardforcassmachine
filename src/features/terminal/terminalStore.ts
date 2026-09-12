import { z } from 'zod';
import { AppError } from '@/lib/errors';
import { parseOrInvalid } from '@/lib/validation';
import { closeSessionRecordSchema, openSessionRecordSchema, saleRecordSchema } from '@/ports';

const TERMINAL_KEY = 'pos.terminal';
const PENDING_KEY = 'pos.pendingRecord';

export const storedTerminalSchema = z.object({
  terminalId: z.string().min(1),
  code: z.string().min(1),
  epoch: z.number().int().min(0),
  /** The highest receipt number this device has used or adopted. It never goes back. */
  lastSeq: z.number().int().min(0),
  registeredAt: z.string().min(1),
});
export type StoredTerminal = z.infer<typeof storedTerminalSchema>;

/**
 * The one record this device wrote but has not yet had accepted. It is resent exactly as it was
 * (same id, same hash) until the server answers, so a lost response never costs a receipt number.
 */
export const pendingRecordSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('sale'), record: saleRecordSchema }),
  z.object({ type: z.literal('session_open'), record: openSessionRecordSchema }),
  z.object({ type: z.literal('session_close'), record: closeSessionRecordSchema }),
]);
export type PendingRecord = z.infer<typeof pendingRecordSchema>;

/** Both stored values, parsed once per change so React sees the same object until one changes. */
export interface TerminalSnapshot {
  readonly terminal: StoredTerminal | null;
  readonly pending: PendingRecord | null;
}

export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function browserStorage(): KeyValueStorage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch (error) {
    console.error('Local storage is unavailable', error);
    return null;
  }
}

function parseStored<Schema extends z.ZodType>(
  raw: string | null,
  key: string,
  schema: Schema,
): z.output<Schema> | null {
  if (raw === null) {
    return null;
  }
  try {
    return schema.parse(JSON.parse(raw));
  } catch (error) {
    console.error(`Ignoring unreadable ${key} in local storage`, error);
    return null;
  }
}

/**
 * This device's terminal registration, receipt counter and unsent record, in local storage (Phase 4
 * moves them into the outbox). Methods are plain functions, so they can be passed around unbound.
 */
export function createTerminalStore(storage: KeyValueStorage | null = browserStorage()) {
  const listeners = new Set<() => void>();
  let cache: {
    terminalRaw: string | null;
    pendingRaw: string | null;
    value: TerminalSnapshot;
  } | null = null;

  const readRaw = (key: string): string | null => {
    if (!storage) {
      return null;
    }
    try {
      return storage.getItem(key);
    } catch (error) {
      console.error(`Could not read ${key} from local storage`, error);
      return null;
    }
  };

  const snapshot = (): TerminalSnapshot => {
    const terminalRaw = readRaw(TERMINAL_KEY);
    const pendingRaw = readRaw(PENDING_KEY);
    if (!cache || cache.terminalRaw !== terminalRaw || cache.pendingRaw !== pendingRaw) {
      cache = {
        terminalRaw,
        pendingRaw,
        value: {
          terminal: parseStored(terminalRaw, TERMINAL_KEY, storedTerminalSchema),
          pending: parseStored(pendingRaw, PENDING_KEY, pendingRecordSchema),
        },
      };
    }
    return cache.value;
  };

  const write = (key: string, value: string | null): void => {
    if (!storage) {
      throw new AppError('CONFIG_ERROR', 'This browser cannot store the terminal registration.');
    }
    if (value === null) {
      storage.removeItem(key);
    } else {
      storage.setItem(key, value);
    }
    listeners.forEach((listener) => listener());
  };

  /** Registering again while a record is unsent would strand it under the old registration. */
  const assertCanRegister = (): void => {
    if (snapshot().pending) {
      throw new AppError(
        'VALIDATION_ERROR',
        'This device still has a record waiting to be sent. Send it before registering again.',
      );
    }
  };

  return {
    snapshot,

    /** Notifies changes made through this store, and by other tabs through local storage. */
    subscribe: (listener: () => void): (() => void) => {
      listeners.add(listener);
      const onStorage = (event: StorageEvent) => {
        if (event.key === null || event.key === TERMINAL_KEY || event.key === PENDING_KEY) {
          listener();
        }
      };
      globalThis.addEventListener?.('storage', onStorage);
      return () => {
        listeners.delete(listener);
        globalThis.removeEventListener?.('storage', onStorage);
      };
    },

    read: (): StoredTerminal | null => snapshot().terminal,

    assertCanRegister,

    /**
     * Adopts a registration. The counter never goes back for the same terminal row, so a receipt
     * number this device has used is never handed out twice. A different terminal behind the same
     * code — a new row after the shop was reset — starts from the counter the server reports.
     */
    register: (terminal: StoredTerminal): void => {
      assertCanRegister();
      const previous = snapshot().terminal;
      const sameTerminal =
        previous !== null &&
        previous.code === terminal.code &&
        previous.terminalId === terminal.terminalId;
      const lastSeq = sameTerminal
        ? Math.max(previous.lastSeq, terminal.lastSeq)
        : terminal.lastSeq;
      write(
        TERMINAL_KEY,
        JSON.stringify(
          parseOrInvalid(storedTerminalSchema, { ...terminal, lastSeq }, 'the registration'),
        ),
      );
    },

    clear: (): void => write(TERMINAL_KEY, null),

    /** Notes that `seq` was accepted. The counter only moves forward. */
    commitSeq: (seq: number): void => {
      const current = snapshot().terminal;
      if (!current) {
        throw new AppError('CONFIG_ERROR', 'This device is not registered as a terminal.');
      }
      if (seq > current.lastSeq) {
        write(TERMINAL_KEY, JSON.stringify({ ...current, lastSeq: seq }));
      }
    },

    readPending: (): PendingRecord | null => snapshot().pending,

    writePending: (pending: PendingRecord): void =>
      write(
        PENDING_KEY,
        JSON.stringify(parseOrInvalid(pendingRecordSchema, pending, 'the unsent record')),
      ),

    clearPending: (): void => write(PENDING_KEY, null),
  };
}

export type TerminalStore = ReturnType<typeof createTerminalStore>;

let device: TerminalStore | null = null;

/** The store of this browser, shared by the whole app; created on first use. */
export function deviceTerminal(): TerminalStore {
  device ??= createTerminalStore();
  return device;
}
