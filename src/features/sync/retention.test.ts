import { describe, expect, it } from 'vitest';
import {
  closePayload,
  isoAt,
  ITEM_ID,
  refundPayload,
  registration as registrationOf,
  START,
  storedOpen,
  storedOrder,
  storedSale,
  uuid,
  type SaleOutboxRecord,
  type SessionOutboxRecord,
} from './__tests__/fixtures';
import { prunable, RETENTION_MS } from './retention';
import type { OrderOutboxRecord, OutboxRecord, OutboxRecordPatch } from './types';

// The retention policy on its own: which records a device deletes, and which it keeps however old
// they are because a screen still reads them.

const DAY = 24 * 60 * 60 * 1000;
const NOW = START + 60 * DAY;
/** The latest ack a prune at NOW deletes: exactly a week before it. */
const OLD = NOW - RETENTION_MS;
const SESSION_A = uuid(7_001);
const SESSION_B = uuid(7_002);
const registration = registrationOf();

function acked(at: number): OutboxRecordPatch {
  return { status: 'acked', ackedAt: at };
}

const DISCARDED: OutboxRecordPatch = {
  status: 'discarded',
  discard: {
    reason: 'The caisse closed the table first',
    discardedBy: null,
    discardedByName: null,
    discardedAt: OLD,
  },
};

/** An order record that names a table, no item and no sale: the filler of these queues. */
function send(ordinal: number, patch: OutboxRecordPatch = {}): Promise<OrderOutboxRecord> {
  return storedOrder('order_send', ordinal, patch);
}

async function openIn(
  ordinal: number,
  sessionId: string,
  patch: OutboxRecordPatch = {},
): Promise<SessionOutboxRecord> {
  const record = await storedOpen(registration, ordinal, patch);
  return { ...record, id: sessionId, sessionId, payload: { ...record.payload, id: sessionId } };
}

async function saleIn(
  ordinal: number,
  sessionId: string,
  patch: OutboxRecordPatch = {},
): Promise<SaleOutboxRecord> {
  const record = await storedSale(registration, ordinal, ordinal, patch);
  return { ...record, sessionId, payload: { ...record.payload, sessionId } };
}

async function closeOf(
  ordinal: number,
  sessionId: string,
  patch: OutboxRecordPatch = {},
): Promise<OutboxRecord> {
  const built = await closePayload(registration, isoAt(START), uuid(4_000 + ordinal));
  const payload = { ...built, sessionId };
  return {
    id: payload.id,
    kind: 'session_close',
    ordinal,
    seq: null,
    terminalCode: registration.code,
    sessionId,
    payload,
    payloadHash: payload.payloadHash,
    createdAt: START,
    attempts: 0,
    nextAttemptAt: START,
    status: 'pending',
    lastError: null,
    result: null,
    ackedAt: null,
    discard: null,
    ...patch,
  };
}

async function refundIn(
  ordinal: number,
  sessionId: string,
  saleId: string,
  patch: OutboxRecordPatch = {},
): Promise<SaleOutboxRecord> {
  const built = await refundPayload(registration, ordinal, uuid(6_000 + ordinal));
  const payload = { ...built, sessionId, refundsSaleId: saleId };
  return {
    id: payload.id,
    kind: 'refund',
    ordinal,
    seq: ordinal,
    terminalCode: registration.code,
    sessionId,
    payload,
    payloadHash: payload.payloadHash,
    createdAt: START,
    attempts: 0,
    nextAttemptAt: START,
    status: 'pending',
    lastError: null,
    result: null,
    ackedAt: null,
    discard: null,
    ...patch,
  };
}

/** The add of item `itemId`: an added item's id is its add record's id. */
async function addOf(
  ordinal: number,
  itemId: string,
  patch: OutboxRecordPatch = {},
): Promise<OrderOutboxRecord> {
  const record = await storedOrder('order_item_add', ordinal, patch);
  return { ...record, id: itemId, payload: { ...record.payload, id: itemId } } as OrderOutboxRecord;
}

function idsOf(records: readonly OutboxRecord[]): string[] {
  return records.map((record) => record.id);
}

describe('prunable', () => {
  it('picks a record the server has had for a week, and not one it took a moment later', async () => {
    const expired = await send(1, acked(OLD));
    const records = [expired, await send(2, acked(OLD + 1)), await send(3, acked(NOW))];

    expect(prunable(records, NOW)).toEqual([expired.id]);
  });

  // Every record here was written at START, two months before NOW.
  it('never picks a record the server does not hold, however old it is', async () => {
    const records = [
      await storedOrder('order_item_add', 1),
      await send(2, { status: 'sending' }),
      await storedOrder('order_item_remove', 3, { status: 'conflict' }),
      await storedOrder('order_cancel', 4, DISCARDED),
      // Voided: the server answered, so it has an ack time, but the receipt number was spent.
      await saleIn(5, SESSION_A, { status: 'voided', ackedAt: START }),
      await send(6, acked(NOW)),
    ];

    expect(prunable(records, NOW)).toEqual([]);
  });

  it('keeps the last record the server took, so the device can still say when it last sent', async () => {
    const records = [
      await send(1, acked(OLD - 5_000)),
      await send(2, acked(OLD - 1_000)),
      // Acked in the same millisecond as the one before: the later record is the last.
      await send(3, acked(OLD - 1_000)),
    ];

    expect(prunable(records, NOW)).toEqual(idsOf(records.slice(0, 2)));
  });

  it('keeps every record of the session the till is still in', async () => {
    const closedLongAgo = [
      await openIn(1, SESSION_A, acked(OLD)),
      await saleIn(2, SESSION_A, acked(OLD)),
      await closeOf(3, SESSION_A, acked(OLD)),
    ];
    const stillOpen = [
      await openIn(4, SESSION_B, acked(OLD)),
      await saleIn(5, SESSION_B, acked(OLD)),
      await saleIn(6, SESSION_B, acked(OLD)),
    ];

    expect(prunable([...closedLongAgo, ...stillOpen, await send(7, acked(NOW))], NOW)).toEqual(
      idsOf(closedLongAgo),
    );
  });

  // A device registered in the middle of a session sells in it without ever having opened it.
  it('keeps the sales of a session this device took over from another one', async () => {
    const records = [
      await saleIn(1, SESSION_B, acked(OLD)),
      await saleIn(2, SESSION_B, acked(OLD)),
      await send(3, acked(NOW)),
    ];

    expect(prunable(records, NOW)).toEqual([]);
  });

  it('lets a session go once this device has closed it', async () => {
    const session = [
      await openIn(1, SESSION_A, acked(OLD)),
      await saleIn(2, SESSION_A, acked(OLD)),
      await closeOf(3, SESSION_A, acked(OLD)),
    ];

    expect(prunable([...session, await send(4, acked(NOW))], NOW)).toEqual(idsOf(session));
  });

  // A voided record never happened here, as `localSession` has it.
  it('neither closes a session nor starts one with a voided record', async () => {
    const session = [
      await openIn(1, SESSION_A, acked(OLD)),
      await saleIn(2, SESSION_A, acked(OLD)),
    ];
    const voided: OutboxRecordPatch = { status: 'voided', ackedAt: OLD };
    const later = await send(4, acked(NOW));

    // The close was refused and voided: the till is still in the session.
    expect(prunable([...session, await closeOf(3, SESSION_A, voided), later], NOW)).toEqual([]);
    // The next opening was refused and voided: the session before it is still the one it is in.
    expect(prunable([...session, await openIn(3, SESSION_B, voided), later], NOW)).toEqual([]);
  });

  it('keeps an add while a removal or a prepare of its item stays', async () => {
    const add = await addOf(1, ITEM_ID, acked(OLD));
    const later = await send(3, acked(NOW));
    // Removals and prepares name ITEM_ID.
    const waiting = await storedOrder('order_item_remove', 2);
    const discarded = await storedOrder('order_item_prepare', 2, DISCARDED);
    // A uuid read back from the server may not be spelled as the device wrote it.
    const shouted = {
      ...discarded,
      payload: { ...discarded.payload, itemId: ITEM_ID.toUpperCase() },
    } as OrderOutboxRecord;
    const sent = await storedOrder('order_item_remove', 2, acked(OLD));

    expect(prunable([add, waiting, later], NOW)).toEqual([]);
    expect(prunable([add, shouted, later], NOW)).toEqual([]);
    expect(prunable([add, sent, later], NOW)).toEqual([add.id, sent.id]);
  });

  it('keeps a sale while a refund of it stays', async () => {
    const sold = await saleIn(2, SESSION_A, acked(OLD));
    const sessionA = [
      await openIn(1, SESSION_A, acked(OLD)),
      sold,
      await closeOf(3, SESSION_A, acked(OLD)),
    ];
    const openB = await openIn(4, SESSION_B, acked(OLD));

    // The refund is still on its way, so the sale it takes back stays with it.
    const waiting = await refundIn(5, SESSION_B, sold.id);
    expect(prunable([...sessionA, openB, waiting, await send(6, acked(NOW))], NOW)).toEqual(
      idsOf([sessionA[0], sessionA[2]]),
    );

    // Once the refund goes, so does the sale.
    const sent = await refundIn(5, SESSION_B, sold.id, acked(OLD));
    const closeB = await closeOf(6, SESSION_B, acked(OLD));
    expect(prunable([...sessionA, openB, sent, closeB, await send(7, acked(NOW))], NOW)).toEqual(
      idsOf([...sessionA, openB, sent, closeB]),
    );
  });
});
