import type { ErrorCode } from '@/lib/errors';
import type {
  CloseSessionRecord,
  OpenSessionRecord,
  RecordStatus,
  SaleRecord,
  WriteStatus,
  ZReport,
} from '@/ports';

/**
 * pending → sending → acked
 * sending → pending    retriable failure (backoff) or auth lapse (no attempt counted)
 * sending → conflict   conflict-class failure; the queue stops here
 * sending → voided     the server says an admin voided this record
 * conflict → pending   a person retries after fixing the cause
 * conflict → voided | acked   a person voided it (or the void found it recorded)
 * sending → pending    at the start of a drain pass: a pass that died left it behind
 */
export type OutboxStatus = 'pending' | 'sending' | 'acked' | 'conflict' | 'voided';

export type OutboxKind = 'sale' | 'refund' | 'session_open' | 'session_close';

export interface OutboxError {
  readonly code: ErrorCode;
  readonly message: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

export interface OutboxResult {
  readonly status: RecordStatus | WriteStatus | 'recorded';
  readonly receiptNumber?: string;
  readonly zReport?: ZReport;
}

interface OutboxRecordBase {
  readonly id: string;
  /** Drain order across every kind of record on this device. */
  readonly ordinal: number;
  readonly terminalCode: string;
  /** The session the record belongs to (a session-open record's own id). */
  readonly sessionId: string;
  readonly payloadHash: string;
  /** Device clock, milliseconds since the epoch. */
  readonly createdAt: number;
  readonly attempts: number;
  readonly nextAttemptAt: number;
  readonly status: OutboxStatus;
  readonly lastError: OutboxError | null;
  readonly result: OutboxResult | null;
  readonly ackedAt: number | null;
}

export type OutboxRecord =
  | (OutboxRecordBase & {
      readonly kind: 'sale' | 'refund';
      readonly seq: number;
      readonly payload: SaleRecord;
    })
  | (OutboxRecordBase & {
      readonly kind: 'session_open';
      readonly seq: null;
      readonly payload: OpenSessionRecord;
    })
  | (OutboxRecordBase & {
      readonly kind: 'session_close';
      readonly seq: null;
      readonly payload: CloseSessionRecord;
    });

export type OutboxPayload = OutboxRecord['payload'];

/** This device's terminal registration and counters, stored beside the records. */
export interface OutboxMeta {
  readonly terminalId: string;
  readonly code: string;
  readonly epoch: number;
  /** The highest receipt number allocated on this device. */
  readonly lastSeq: number;
  readonly nextOrdinal: number;
  readonly registeredAt: number;
}

export type OutboxRecordPatch = Partial<
  Pick<
    OutboxRecordBase,
    'attempts' | 'nextAttemptAt' | 'status' | 'lastError' | 'result' | 'ackedAt'
  >
>;

export interface OutboxStorage {
  readMeta(): Promise<OutboxMeta | null>;
  writeMeta(meta: OutboxMeta): Promise<void>;
  /**
   * In one transaction: if the stored meta still has `expected.lastSeq` and `expected.nextOrdinal`,
   * add `record` and store `next`; otherwise change nothing and return false.
   */
  appendIfUnchanged(
    expected: { readonly lastSeq: number; readonly nextOrdinal: number },
    record: OutboxRecord,
    next: OutboxMeta,
  ): Promise<boolean>;
  get(id: string): Promise<OutboxRecord | undefined>;
  /** Every record in ordinal order. */
  list(): Promise<OutboxRecord[]>;
  /** The lowest-ordinal record that is pending, sending or in conflict. */
  firstUnfinished(): Promise<OutboxRecord | undefined>;
  update(id: string, patch: OutboxRecordPatch): Promise<OutboxRecord>;
  /** Moves every 'sending' record back to 'pending'; returns how many. */
  resetSending(): Promise<number>;
}

export interface OutboxTransport {
  send(record: OutboxRecord): Promise<OutboxResult>;
}

export interface Clock {
  now(): number;
}

/** Runs `fn` only if no other context holds `name`; returns 'busy' otherwise. */
export interface DrainLock {
  runExclusive<T>(name: string, fn: () => Promise<T>): Promise<T | 'busy'>;
}

export interface OutboxDeps {
  readonly storage: OutboxStorage;
  readonly transport: OutboxTransport;
  readonly clock: Clock;
  /** Uniform in [0, 1). */
  readonly random: () => number;
  readonly lock: DrainLock;
  /** False while there is no live session: nothing is sent, nothing is marked failed. */
  readonly canSend: () => boolean;
}

export type DrainOutcome =
  | { readonly state: 'idle' }
  | { readonly state: 'waiting'; readonly retryAt: number }
  | { readonly state: 'blocked'; readonly recordId: string }
  | { readonly state: 'paused'; readonly reason: 'auth' | 'unregistered' }
  | { readonly state: 'busy' };

export interface OutboxSummary {
  readonly pending: number;
  readonly conflicts: number;
  readonly lastAckAt: number | null;
}
