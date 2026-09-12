import type { ErrorCode } from '@/lib/errors';
import type {
  CloseSessionRecord,
  OpenSessionRecord,
  OrderCancelRecord,
  OrderItemAddRecord,
  OrderItemPrepareRecord,
  OrderItemRemoveRecord,
  OrderSendRecord,
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
 * conflict → discarded a person gave up on an order record, saying why — never a ledger record
 * sending → pending    at the start of a drain pass: a pass that died left it behind
 */
export type OutboxStatus = 'pending' | 'sending' | 'acked' | 'conflict' | 'voided' | 'discarded';

/** Records that move money or a till. They are never dropped: only retried or voided. */
export type LedgerKind = 'sale' | 'refund' | 'session_open' | 'session_close';

/**
 * Records that change what is on a table: working state, not the ledger. A stale item on a table the
 * caisse already closed must not block a waiter's phone forever, so a person may discard one of
 * these, with a reason, into the device's dead-letter list.
 */
export const ORDER_KINDS = [
  'order_item_add',
  'order_item_remove',
  'order_send',
  'order_item_prepare',
  'order_cancel',
] as const;
export type OrderKind = (typeof ORDER_KINDS)[number];

export type OutboxKind = LedgerKind | OrderKind;

export interface OutboxError {
  readonly code: ErrorCode;
  readonly message: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

export interface OutboxResult {
  readonly status: RecordStatus | WriteStatus | 'recorded';
  readonly receiptNumber?: string;
  readonly zReport?: ZReport;
  /** The order an order record landed on. */
  readonly orderId?: string;
  /** How many items an order record touched: sent, prepared, removed or cancelled. */
  readonly affected?: number;
}

/** Why a person gave up on an order record, and who and when. */
export interface OutboxDiscard {
  readonly reason: string;
  /** The user signed in when it was discarded, or null when nobody was. */
  readonly discardedBy: string | null;
  /**
   * That user's name as it was then. A phone has no staff list to look an id up in, and the admin
   * who reads the dead-letter list later needs to know who, not which account.
   */
  readonly discardedByName: string | null;
  readonly discardedAt: number;
}

/**
 * What every record carries. There is no device id on the record: this store is the device's own,
 * so every record in it was written here, and the order payloads carry the device id the server
 * sees.
 */
interface RecordBase {
  readonly id: string;
  /** Drain order across every kind of record on this device. */
  readonly ordinal: number;
  readonly payloadHash: string;
  /** Device clock, milliseconds since the epoch. */
  readonly createdAt: number;
  readonly attempts: number;
  readonly nextAttemptAt: number;
  readonly status: OutboxStatus;
  readonly lastError: OutboxError | null;
  readonly result: OutboxResult | null;
  readonly ackedAt: number | null;
  /** Set when, and only when, the status is 'discarded'. */
  readonly discard: OutboxDiscard | null;
}

/** A record written on a register: it names the terminal and the session it belongs to. */
interface LedgerBase extends RecordBase {
  readonly terminalCode: string;
  /** The session the record belongs to (a session-open record's own id). */
  readonly sessionId: string;
}

/** A record written on any device — a waiter's phone has no terminal and no session. */
interface OrderBase extends RecordBase {
  readonly terminalCode: null;
  readonly sessionId: null;
  readonly seq: null;
}

export type LedgerOutboxRecord =
  | (LedgerBase & {
      readonly kind: 'sale' | 'refund';
      readonly seq: number;
      readonly payload: SaleRecord;
    })
  | (LedgerBase & {
      readonly kind: 'session_open';
      readonly seq: null;
      readonly payload: OpenSessionRecord;
    })
  | (LedgerBase & {
      readonly kind: 'session_close';
      readonly seq: null;
      readonly payload: CloseSessionRecord;
    });

export type OrderOutboxRecord =
  | (OrderBase & { readonly kind: 'order_item_add'; readonly payload: OrderItemAddRecord })
  | (OrderBase & { readonly kind: 'order_item_remove'; readonly payload: OrderItemRemoveRecord })
  | (OrderBase & { readonly kind: 'order_send'; readonly payload: OrderSendRecord })
  | (OrderBase & { readonly kind: 'order_item_prepare'; readonly payload: OrderItemPrepareRecord })
  | (OrderBase & { readonly kind: 'order_cancel'; readonly payload: OrderCancelRecord });

export type OutboxRecord = LedgerOutboxRecord | OrderOutboxRecord;

export type OutboxPayload = OutboxRecord['payload'];

/** The payload an order record of `kind` carries. */
export type OrderPayload<K extends OrderKind> = Extract<OrderOutboxRecord, { kind: K }>['payload'];

export function isOrderRecord(record: OutboxRecord): record is OrderOutboxRecord {
  return (ORDER_KINDS as readonly string[]).includes(record.kind);
}

/** A register's terminal registration and its receipt counter. */
export interface TerminalMeta {
  readonly terminalId: string;
  readonly code: string;
  readonly epoch: number;
  /** The highest receipt number allocated on this device. */
  readonly lastSeq: number;
  readonly registeredAt: number;
}

/**
 * This device's queue, stored beside its records: the drain counter every record takes a number
 * from, and the terminal registration when the device is a register. One queue per device, not per
 * terminal, because a waiter's phone writes records too and has no terminal at all.
 */
export interface OutboxMeta {
  readonly nextOrdinal: number;
  readonly terminal: TerminalMeta | null;
}

export type OutboxRecordPatch = Partial<
  Pick<
    RecordBase,
    'attempts' | 'nextAttemptAt' | 'status' | 'lastError' | 'result' | 'ackedAt' | 'discard'
  >
>;

export interface OutboxStorage {
  /** The device's queue meta, or null on a device that has never written anything. */
  readMeta(): Promise<OutboxMeta | null>;
  writeMeta(meta: OutboxMeta): Promise<void>;
  /**
   * In one transaction: if the stored meta is still `expected` — null meaning nothing is stored —
   * add `record` and store `next`; otherwise change nothing and return false.
   */
  appendIfUnchanged(
    expected: OutboxMeta | null,
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
  /**
   * In one transaction: hands `select` every record in ordinal order, and deletes the records whose
   * ids it returns — only those the server has taken, whatever `select` says, so a record only this
   * device holds is never lost. The counters stay, so no ordinal is used twice. Returns how many went.
   */
  prune(select: (records: readonly OutboxRecord[]) => readonly string[]): Promise<number>;
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
  | { readonly state: 'paused'; readonly reason: 'auth' }
  | { readonly state: 'busy' };

export interface OutboxSummary {
  readonly pending: number;
  readonly conflicts: number;
  /** Order records a person gave up on: the dead-letter list the admin is shown. */
  readonly discarded: number;
  readonly lastAckAt: number | null;
}
