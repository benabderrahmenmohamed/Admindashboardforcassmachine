import { addItem, emptyCart, type Cart, type CartProduct } from '@/features/pos/cart';
import { buildRefundRecord, buildSaleRecord, type RecordEnvelope } from '@/features/sales/records';
import { buildCloseSessionRecord, buildOpenSessionRecord } from '@/features/sessions/records';
import { AppError, type ErrorCode } from '@/lib/errors';
import { mm } from '@/lib/money';
import type {
  CloseSessionRecord,
  OpenSessionRecord,
  PaymentMethod,
  Sale,
  SaleRecord,
} from '@/ports';
import type {
  Clock,
  OutboxMeta,
  OutboxRecord,
  OutboxRecordPatch,
  OutboxResult,
  OutboxTransport,
} from '../types';

// What every outbox test shares: stable ids, a clock and a random the test drives, a transport that
// remembers what it was asked to send, and payloads built by the same code the register uses, so no
// test invents a record the ports would refuse.

/** A UUID for `n`, so ids read the same from run to run. */
export function uuid(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
}

export const SESSION_ID = uuid(90_001);
export const CASHIER_ID = uuid(90_002);
export const TERMINAL_ID = uuid(90_003);
export const TERMINAL_CODE = 'T1';

const CLOSE_ID = uuid(90_004);
const PRODUCT: CartProduct = {
  id: uuid(90_005),
  name: 'Café moulu 250 g',
  priceMillimes: mm(8_750),
};

/** 2026-09-12T08:00:00.000Z, where every fake clock starts. */
export const START = Date.UTC(2026, 8, 12, 8, 0, 0);

export function isoAt(millis: number): string {
  return new Date(millis).toISOString();
}

/** This device's registration: terminal T1, nothing allocated yet. */
export function meta(overrides: Partial<OutboxMeta> = {}): OutboxMeta {
  return {
    terminalId: TERMINAL_ID,
    code: TERMINAL_CODE,
    epoch: 1,
    lastSeq: 0,
    nextOrdinal: 1,
    registeredAt: START,
    ...overrides,
  };
}

export interface FakeClock extends Clock {
  advance(ms: number): void;
}

export function createClock(start = START): FakeClock {
  let current = start;
  return {
    now: () => current,
    advance(ms) {
      current += ms;
    },
  };
}

/** Hands out `values` in turn, then repeats the last one. The default adds no jitter at all. */
export function createRandom(values: readonly number[] = [0]): () => number {
  let index = 0;
  return () => {
    const value = values[Math.min(index, values.length - 1)];
    index += 1;
    return value;
  };
}

/** Throws what an adapter throws for `code`; the outbox decides from the code alone. */
export function raise(code: ErrorCode): never {
  throw new AppError(code, `${code} from the fake backend`);
}

/** The answer a backend gives for a record it accepted. */
export function ackOf(
  record: OutboxRecord,
  status: OutboxResult['status'] = 'created',
): OutboxResult {
  return record.kind === 'sale' || record.kind === 'refund'
    ? { status, receiptNumber: `${record.terminalCode}-${record.seq}` }
    : { status };
}

/** What the fake backend answers for one send; `attempt` counts the sends of that record. */
export type Answer = (
  record: OutboxRecord,
  attempt: number,
) => OutboxResult | Promise<OutboxResult>;

export interface TrackedTransport extends OutboxTransport {
  /** Every record handed to `send`, in the order it was sent. */
  readonly sent: readonly OutboxRecord[];
  /** The most sends that were ever in flight at the same time. */
  peakInFlight(): number;
  /** The receipt numbers, or nulls for session records, of everything sent. */
  seqs(): (number | null)[];
}

export function createTransport(answer: Answer = (record) => ackOf(record)): TrackedTransport {
  const sent: OutboxRecord[] = [];
  let inFlight = 0;
  let peak = 0;
  return {
    sent,
    peakInFlight: () => peak,
    seqs: () => sent.map((record) => record.seq),
    async send(record) {
      sent.push(record);
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      try {
        return await answer(record, sent.filter((candidate) => candidate.id === record.id).length);
      } finally {
        inFlight -= 1;
      }
    },
  };
}

// Payloads, built as the register builds them.

function cartOf(units = 1): Cart {
  return addItem(emptyCart, PRODUCT, units);
}

function envelopeFor(
  registration: OutboxMeta,
  seq: number,
  id: string,
  createdAt: string,
): RecordEnvelope {
  return {
    id,
    seq,
    sessionId: SESSION_ID,
    createdAt,
    terminal: { terminalCode: registration.code, epoch: registration.epoch },
  };
}

export function salePayload(
  registration: OutboxMeta,
  seq: number,
  id: string,
  createdAt: string = isoAt(START),
  method: PaymentMethod = 'cash',
): Promise<SaleRecord> {
  return buildSaleRecord(envelopeFor(registration, seq, id, createdAt), cartOf(2), { method });
}

/** The sale as `getSale` returns it right after it was recorded, so a refund can be built from it. */
function saleView(record: SaleRecord): Sale {
  return {
    id: record.id,
    kind: record.kind,
    receiptNumber: `${record.terminalCode}-${record.seq}`,
    seq: record.seq,
    terminalId: TERMINAL_ID,
    terminalCode: record.terminalCode,
    sessionId: record.sessionId,
    refundsSaleId: record.refundsSaleId,
    paymentMethod: record.payment.method,
    subtotalMillimes: record.subtotalMillimes,
    discountMillimes: record.discountMillimes,
    totalMillimes: record.totalMillimes,
    tenderedMillimes: record.payment.tenderedMillimes,
    changeMillimes: record.payment.changeMillimes,
    createdAt: record.createdAt,
    receivedAt: record.createdAt,
    lines: record.lines.map((line) => ({ ...line, refundedQty: 0, refundedMillimes: mm(0) })),
  };
}

/** A refund of one unit of the sale numbered `seq - 1`. */
export async function refundPayload(
  registration: OutboxMeta,
  seq: number,
  id: string,
  createdAt: string = isoAt(START),
): Promise<SaleRecord> {
  const sale = await salePayload(registration, Math.max(seq - 1, 1), uuid(80_000 + seq), createdAt);
  return buildRefundRecord(
    envelopeFor(registration, seq, id, createdAt),
    saleView(sale),
    [{ lineNo: 1, qty: 1 }],
    'cash',
  );
}

export function openPayload(
  registration: OutboxMeta,
  openedAt: string = isoAt(START),
  id: string = SESSION_ID,
): Promise<OpenSessionRecord> {
  return buildOpenSessionRecord({
    id,
    terminal: { terminalCode: registration.code, epoch: registration.epoch },
    actorUserId: CASHIER_ID,
    openedAt,
    openingFloatMillimes: mm(20_000),
  });
}

export function closePayload(
  registration: OutboxMeta,
  closedAt: string = isoAt(START),
  id: string = CLOSE_ID,
): Promise<CloseSessionRecord> {
  return buildCloseSessionRecord({
    id,
    sessionId: SESSION_ID,
    terminal: { terminalCode: registration.code, epoch: registration.epoch },
    actorUserId: CASHIER_ID,
    closedAt,
    closingCountedMillimes: mm(37_500),
    clientZReport: null,
  });
}

// Stored records, for the tests that fill a storage by hand instead of through an outbox.

/** The numbered branch of the record union, so a test can rewrite a field and still have a record. */
export type SaleOutboxRecord = Extract<OutboxRecord, { kind: 'sale' | 'refund' }>;
export type SessionOutboxRecord = Extract<OutboxRecord, { kind: 'session_open' }>;

/** A queued sale: ordinal `ordinal`, receipt number `seq`, pending since the clock started. */
export async function storedSale(
  registration: OutboxMeta,
  ordinal: number,
  seq: number,
  patch: OutboxRecordPatch = {},
): Promise<SaleOutboxRecord> {
  const payload = await salePayload(registration, seq, uuid(1_000 + ordinal));
  return {
    id: payload.id,
    kind: 'sale',
    ordinal,
    seq,
    terminalCode: registration.code,
    sessionId: payload.sessionId,
    payload,
    payloadHash: payload.payloadHash,
    createdAt: START,
    attempts: 0,
    nextAttemptAt: START,
    status: 'pending',
    lastError: null,
    result: null,
    ackedAt: null,
    ...patch,
  };
}

/** A queued session opening, which carries no receipt number. */
export async function storedOpen(
  registration: OutboxMeta,
  ordinal: number,
  patch: OutboxRecordPatch = {},
): Promise<SessionOutboxRecord> {
  const payload = await openPayload(registration, isoAt(START), uuid(2_000 + ordinal));
  return {
    id: payload.id,
    kind: 'session_open',
    ordinal,
    seq: null,
    terminalCode: registration.code,
    sessionId: payload.id,
    payload,
    payloadHash: payload.payloadHash,
    createdAt: START,
    attempts: 0,
    nextAttemptAt: START,
    status: 'pending',
    lastError: null,
    result: null,
    ackedAt: null,
    ...patch,
  };
}
