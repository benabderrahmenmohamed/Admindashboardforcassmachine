/**
 * This device's terminal registration and its receipt counter, in the outbox's meta store beside the
 * records. They live there because a receipt number is allocated in the very transaction that writes
 * the record that takes it: a counter kept anywhere else could hand the same number out twice.
 * Phase 3 kept both in local storage; `migrateLegacyTerminal` moves an old device over once.
 */
import { z } from 'zod';
import type { OutboxMeta, OutboxRecord, OutboxStorage } from '@/features/sync/types';
import { AppError } from '@/lib/errors';
import {
  closeSessionRecordSchema,
  openSessionRecordSchema,
  saleRecordSchema,
  type TerminalRegistration,
} from '@/ports';

/** The Phase 3 local-storage keys, read once by the migration and then removed. */
export const LEGACY_TERMINAL_KEY = 'pos.terminal';
export const LEGACY_PENDING_KEY = 'pos.pendingRecord';

/** The registration as Phase 3 stored it. Kept only so a device that has one can be migrated. */
const legacyTerminalSchema = z.object({
  terminalId: z.string().min(1),
  code: z.string().min(1),
  epoch: z.number().int().min(0),
  lastSeq: z.number().int().min(0),
  registeredAt: z.string().min(1),
});

/** The one unsent record Phase 3 held outside the queue. */
const legacyPendingSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('sale'), record: saleRecordSchema }),
  z.object({ type: z.literal('session_open'), record: openSessionRecordSchema }),
  z.object({ type: z.literal('session_close'), record: closeSessionRecordSchema }),
]);
type LegacyPending = z.infer<typeof legacyPendingSchema>;

export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export function browserStorage(): KeyValueStorage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch (error) {
    console.error('Local storage is unavailable', error);
    return null;
  }
}

export function readRegistration(storage: OutboxStorage): Promise<OutboxMeta | null> {
  return storage.readMeta();
}

/**
 * Registering bumps the terminal's epoch on the server, so a record still waiting to be sent would
 * be refused under the new registration, and a record in conflict would lose the terminal it names.
 */
export async function assertCanRegister(storage: OutboxStorage): Promise<void> {
  if (await storage.firstUnfinished()) {
    throw new AppError(
      'VALIDATION_ERROR',
      'This device still has records waiting to be sent. Let the queue empty before registering again.',
    );
  }
}

/**
 * Adopts a registration. The counter never goes back for the same terminal row, so a receipt number
 * this device has used is never handed out twice. A different terminal behind the same code — a new
 * row after the shop was reset — starts from the counter the server reports. The ordinal counter
 * always moves forward, because the records it numbered are still in the outbox.
 */
export async function registerTerminal(
  storage: OutboxStorage,
  registration: TerminalRegistration,
  now: number,
): Promise<OutboxMeta> {
  await assertCanRegister(storage);
  const previous = await storage.readMeta();
  const sameTerminal =
    previous !== null &&
    previous.code === registration.code &&
    previous.terminalId === registration.terminalId;
  const meta: OutboxMeta = {
    terminalId: registration.terminalId,
    code: registration.code,
    epoch: registration.epoch,
    lastSeq: sameTerminal ? Math.max(previous.lastSeq, registration.lastSeq) : registration.lastSeq,
    nextOrdinal: previous?.nextOrdinal ?? 1,
    registeredAt: now,
  };
  await storage.writeMeta(meta);
  return meta;
}

function readLegacy<Schema extends z.ZodType>(
  keyValue: KeyValueStorage,
  key: string,
  schema: Schema,
): z.output<Schema> | null {
  let raw: string | null;
  try {
    raw = keyValue.getItem(key);
  } catch (error) {
    console.error(`Could not read ${key} from local storage`, error);
    return null;
  }
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

function legacyTimestamp(pending: LegacyPending, fallback: number): number {
  const text =
    pending.type === 'sale'
      ? pending.record.createdAt
      : pending.type === 'session_open'
        ? pending.record.openedAt
        : pending.record.closedAt;
  const parsed = Date.parse(text);
  return Number.isNaN(parsed) ? fallback : parsed;
}

/** The Phase 3 unsent record as a queue record, keeping its id, its hash and its receipt number. */
function legacyRecord(pending: LegacyPending, ordinal: number, now: number): OutboxRecord {
  const createdAt = legacyTimestamp(pending, now);
  const base = {
    id: pending.record.id,
    ordinal,
    terminalCode: pending.record.terminalCode,
    payloadHash: pending.record.payloadHash,
    createdAt,
    attempts: 0,
    nextAttemptAt: now,
    status: 'pending' as const,
    lastError: null,
    result: null,
    ackedAt: null,
  };
  switch (pending.type) {
    case 'sale':
      return {
        ...base,
        kind: pending.record.kind,
        seq: pending.record.seq,
        sessionId: pending.record.sessionId,
        payload: pending.record,
      };
    case 'session_open':
      return {
        ...base,
        kind: 'session_open',
        seq: null,
        sessionId: pending.record.id,
        payload: pending.record,
      };
    case 'session_close':
      return {
        ...base,
        kind: 'session_close',
        seq: null,
        sessionId: pending.record.sessionId,
        payload: pending.record,
      };
  }
}

/**
 * Moves a Phase 3 device into the outbox, once: its registration becomes the meta row and its one
 * unsent record becomes the first record of the queue, with the id, hash and number it was written
 * with, so replaying it is the harmless replay it always was. Both keys are then removed. A device
 * that already has an outbox meta row keeps it — only the old keys go. Returns what it moved.
 */
export async function migrateLegacyTerminal(
  storage: OutboxStorage,
  now: number,
  keyValue: KeyValueStorage | null = browserStorage(),
): Promise<{ readonly terminal: boolean; readonly record: boolean }> {
  const nothing = { terminal: false, record: false };
  if (!keyValue) {
    return nothing;
  }
  const legacy = readLegacy(keyValue, LEGACY_TERMINAL_KEY, legacyTerminalSchema);
  const pending = readLegacy(keyValue, LEGACY_PENDING_KEY, legacyPendingSchema);
  const drop = () => {
    keyValue.removeItem(LEGACY_TERMINAL_KEY);
    keyValue.removeItem(LEGACY_PENDING_KEY);
  };
  if (!legacy && !pending) {
    return nothing;
  }
  if ((await storage.readMeta()) !== null) {
    // Registered under Phase 4 already: the old keys are stale, whatever they say.
    drop();
    return nothing;
  }
  if (!legacy) {
    // A record without a registration can never be sent: its terminal and epoch are unknown here.
    drop();
    return nothing;
  }
  const registeredAt = Date.parse(legacy.registeredAt);
  const base: OutboxMeta = {
    terminalId: legacy.terminalId,
    code: legacy.code,
    epoch: legacy.epoch,
    lastSeq: legacy.lastSeq,
    nextOrdinal: 1,
    registeredAt: Number.isNaN(registeredAt) ? now : registeredAt,
  };
  await storage.writeMeta(base);
  let moved = false;
  if (pending && !(await storage.get(pending.record.id))) {
    const record = legacyRecord(pending, base.nextOrdinal, now);
    // Phase 3 committed a receipt number only once the server had answered, so the record still
    // holds a number the counter has not reached; the queue must not hand that number out again.
    const next: OutboxMeta = {
      ...base,
      lastSeq:
        record.seq !== null && record.terminalCode === base.code
          ? Math.max(record.seq, base.lastSeq)
          : base.lastSeq,
      nextOrdinal: base.nextOrdinal + 1,
    };
    moved = await storage.appendIfUnchanged(
      { lastSeq: base.lastSeq, nextOrdinal: base.nextOrdinal },
      record,
      next,
    );
  }
  drop();
  return { terminal: true, record: moved };
}
