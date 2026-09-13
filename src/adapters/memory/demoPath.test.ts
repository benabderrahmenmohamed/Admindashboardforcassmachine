import { describe, expect, it } from 'vitest';
import { addItem, emptyCart, type CartProduct } from '@/features/caisse/cart';
import { posGate } from '@/features/pos/gate';
import {
  isNumbered,
  localSession,
  queueState,
  sessionDocuments,
  syncStatus,
  type NumberedRecord,
} from '@/features/pos/queue';
import { canVoid, receiptOf, syncStatusMessage } from '@/features/pos/recording';
import { mergeSales } from '@/features/sales/components/salesList';
import { buildRefundRecord, buildSaleRecord } from '@/features/sales/records';
import { localZReport } from '@/features/sessions/components/zReportView';
import { buildCloseSessionRecord, buildOpenSessionRecord } from '@/features/sessions/records';
import { sameZReport } from '@/features/sessions/zReport';
import { syncChipView } from '@/features/sync/components/syncView';
import { createInProcessDrainLock } from '@/features/sync/locks';
import { createMemoryOutboxStorage } from '@/features/sync/memoryStorage';
import { createOutbox } from '@/features/sync/outbox';
import { createOutboxRuntime, type SyncSchedule } from '@/features/sync/runtime';
import { createPortTransport } from '@/features/sync/transport';
import type { OutboxRecord, TerminalMeta } from '@/features/sync/types';
import { registerTerminal } from '@/features/terminal/terminalStore';
import { mm, type Millimes } from '@/lib/money';
import type { CashSession } from '@/ports';
import { createMemoryBackend } from './index';

/*
 * Phase 4's demo path, end to end through the pieces the app wires together: this backend with its
 * own connectivity, the device's outbox and its runtime, and what the register reads off both. An
 * admin registers T1, a cashier opens a session, sells and refunds with the network off, the queue
 * drains once it is back, and the close is counted here before the server answers with its own.
 *
 * It sits beside the backend rather than beside the queue because only an adapter may name an
 * adapter (eslint's no-restricted-imports), which is also where ledger.test.ts walks the same demo
 * one layer down. Nothing here renders: what is exercised is the seam between the queue, the
 * backend and the screens' own reading of both.
 */

const START = Date.UTC(2026, 8, 12, 9, 0, 0);
/** The seeded water bottle: 0,850 DT. */
const WATER: CartProduct = {
  id: '55555555-5555-4555-8555-555555555501',
  name: 'Eau minérale 1,5 L',
  priceMillimes: mm(850),
};

/** The whole device: a backend whose network the test switches, and the queue on top of it. */
function demoDevice() {
  const network = { online: true };
  const clock = { current: START, now: () => clock.current };
  const backend = createMemoryBackend({ connectivity: () => network.online });
  const storage = createMemoryOutboxStorage();
  const timers: (() => void)[] = [];
  const online: (() => void)[] = [];
  // No real timer anywhere: the test fires the triggers the runtime asks for.
  const schedule: SyncSchedule = {
    every: () => () => undefined,
    after: (_ms, run) => {
      timers.push(run);
      return () => undefined;
    },
    onOnline: (run) => {
      online.push(run);
      return () => undefined;
    },
  };
  const outbox = createOutbox({
    storage,
    transport: createPortTransport(backend),
    clock,
    random: () => 0,
    lock: createInProcessDrainLock(),
    canSend: () => true,
  });
  const runtime = createOutboxRuntime({ outbox, storage, schedule, clock });

  return {
    backend,
    network,
    clock,
    runtime,
    records: () => runtime.snapshot().records,
    /** The registration as the outbox holds it: the terminal half of the device's queue. */
    meta: async (): Promise<TerminalMeta> => {
      const terminal = (await storage.readMeta())?.terminal;
      return terminal ?? expect.unreachable('This device should be registered by now');
    },
    /** The network comes back and the wait the failures earned is over: every trigger fires. */
    reconnect: async () => {
      network.online = true;
      clock.current += 60_000;
      online.forEach((run) => run());
      timers.splice(0).forEach((run) => run());
      await runtime.sync();
      await runtime.refresh();
    },
  };
}

function cartOf(units: number) {
  return addItem(emptyCart, WATER, units);
}

/** A sale or a refund as the register wrote it: the kinds that carry a receipt number. */
async function numbered(append: Promise<OutboxRecord>): Promise<NumberedRecord> {
  const record = await append;
  return isNumbered(record) ? record : expect.unreachable('A sale is written as a numbered record');
}

/**
 * The register's own reading of the queue: what the POS would put on screen right now. `session` is
 * the server's answer as the current-session query holds it, and undefined while it has none —
 * which is what a device that went offline before asking has.
 */
function gateOf(
  meta: TerminalMeta,
  records: readonly OutboxRecord[],
  session: CashSession | null | undefined,
) {
  return posGate({
    secureContext: true,
    terminal: meta,
    lock: 'held',
    records,
    session,
    sessionError: null,
  });
}

describe('the demo path', () => {
  it('registers T1, sells and refunds offline, drains on reconnect and closes on both reports', async () => {
    const device = demoDevice();
    const { backend } = device;

    // Settings, as the admin: this device becomes T1 and the registration lands in the outbox meta.
    const [adminAccount, cashierAccount] = backend.demoAccounts;
    await backend.auth.signIn({ email: adminAccount.email, password: adminAccount.password });
    const registration = await backend.terminals.register('T1');
    await registerTerminal(device.runtime.storage, registration, device.clock.now());
    await backend.auth.signOut();
    const meta = await device.meta();
    expect(meta).toMatchObject({ code: 'T1', lastSeq: 0 });
    await expect(device.runtime.storage.readMeta()).resolves.toMatchObject({ nextOrdinal: 1 });

    // The POS, as the cashier: a session opened while the network is still there.
    const cashier = await backend.auth.signIn({
      email: cashierAccount.email,
      password: cashierAccount.password,
    });
    device.runtime.start();
    await device.runtime.outbox.appendSessionOpen(({ meta: current }) =>
      buildOpenSessionRecord({
        id: crypto.randomUUID(),
        terminal: { terminalCode: current.code, epoch: current.epoch },
        actorUserId: cashier.id,
        openedAt: new Date(device.clock.now()).toISOString(),
        openingFloatMillimes: mm(50_000),
      }),
    );
    await device.runtime.sync();
    expect(device.records().map((record) => record.status)).toEqual(['acked']);
    const session = localSession(meta, device.records());
    expect(session).not.toBeNull();

    // The network goes: from here nothing reaches the server, and nothing on screen waits for it.
    device.network.online = false;

    const sale = await numbered(
      device.runtime.outbox.appendSale('sale', ({ seq, meta: current }) =>
        buildSaleRecord(
          {
            id: crypto.randomUUID(),
            seq,
            sessionId: session?.id ?? '',
            createdAt: new Date(device.clock.now()).toISOString(),
            terminal: { terminalCode: current.code, epoch: current.epoch },
            tableId: null,
          },
          cartOf(2),
          { method: 'cash', tenderedMillimes: mm(2_000) },
        ),
      ),
    );
    // The receipt is on the device the moment the record is: number, lines, payment and all.
    expect(receiptOf(sale)).toBe('T1-1');
    expect(sale.payload.totalMillimes).toBe(1_700);
    await device.runtime.sync();

    const offline = device.records();
    const queued = offline.find((record) => record.id === sale.id);
    expect(queued).toMatchObject({ status: 'pending', lastError: { code: 'NETWORK_ERROR' } });
    expect(syncStatus(queued ?? sale)).toBe('pending');
    expect(syncStatusMessage(queued ?? sale)).toContain('goes out on its own');
    // Selling carries on: only a conflict stops the register, and there is none.
    expect(gateOf(meta, offline, session).kind).toBe('open');
    expect(queueState(offline).blocked).toBeNull();
    // The sales sheet lists it from this device's own copy, with nothing from the server.
    const offlineRows = mergeSales(meta, [], offline);
    expect(offlineRows).toHaveLength(1);
    expect(offlineRows[0]).toMatchObject({ syncStatus: 'pending' });
    expect(offlineRows[0].sale.receiptNumber).toBe('T1-1');
    // And the chip says how much is waiting.
    const { summary, state } = device.runtime.snapshot();
    expect(syncChipView(summary, state, device.clock.now())).toMatchObject({
      tone: 'pending',
      label: '1 to send',
    });

    // A refund of a sale the server has never heard of, also offline. It is built against the row
    // the sheet shows, which for an unsent sale is this device's own copy of it.
    const refund = await numbered(
      device.runtime.outbox.appendSale('refund', ({ seq, meta: current }) =>
        buildRefundRecord(
          {
            id: crypto.randomUUID(),
            seq,
            sessionId: sale.sessionId,
            createdAt: new Date(device.clock.now()).toISOString(),
            terminal: { terminalCode: current.code, epoch: current.epoch },
            tableId: null,
          },
          offlineRows[0].sale,
          [{ lineNo: 1, qty: 1 }],
          'cash',
        ),
      ),
    );
    expect(receiptOf(refund)).toBe('T1-2');
    await device.runtime.sync();
    expect(device.records().filter((record) => record.status === 'pending')).toHaveLength(2);

    // The network comes back: the queue empties itself, in the order it was written.
    await device.reconnect();
    const drained = device.records();
    expect(drained.map((record) => record.status)).toEqual(['acked', 'acked', 'acked']);
    expect(drained.map((record) => record.result?.receiptNumber)).toEqual([
      undefined,
      'T1-1',
      'T1-2',
    ]);
    const onServer = await backend.sales.listSales({ terminalId: registration.terminalId });
    expect(onServer.map((row) => row.receiptNumber)).toEqual(['T1-2', 'T1-1']);
    // Nothing is listed twice once the server holds it, and the refund took its units back once.
    const merged = mergeSales(meta, onServer, drained);
    expect(merged.map((row) => row.sale.receiptNumber)).toEqual(['T1-2', 'T1-1']);
    expect(merged.every((row) => row.syncStatus === 'synced')).toBe(true);
    expect(merged[1].sale.lines[0]).toMatchObject({ qty: 2, refundedQty: 1 });

    // Closing: this device counts the session from its own records before the server answers.
    const counted: Millimes = mm(50_000 + 1_700 - 850);
    expect(sessionDocuments(drained, sale.sessionId)).toHaveLength(2);
    const clientZReport = session && localZReport(session, drained, counted);
    expect(clientZReport).toMatchObject({ salesCount: 1, refundsCount: 1, varianceMillimes: 0 });
    const close = await device.runtime.outbox.appendSessionClose(({ meta: current }) =>
      buildCloseSessionRecord({
        id: crypto.randomUUID(),
        sessionId: sale.sessionId,
        terminal: { terminalCode: current.code, epoch: current.epoch },
        actorUserId: cashier.id,
        closedAt: new Date(device.clock.now()).toISOString(),
        closingCountedMillimes: counted,
        clientZReport: clientZReport ?? null,
      }),
    );
    // The session is over here as soon as the close is written, however long it takes to arrive.
    await device.runtime.refresh();
    expect(gateOf(meta, device.records(), session).kind).toBe('closed');

    await device.runtime.sync();
    const closed = device.records().find((record) => record.id === close.id);
    expect(closed?.status).toBe('acked');
    // The server's report arrives on the record, and it agrees with the one shown all along.
    const serverZReport = closed?.result?.zReport;
    expect(serverZReport).toBeDefined();
    expect(serverZReport && clientZReport && sameZReport(serverZReport, clientZReport)).toBe(true);
    await expect(backend.sessions.current(registration.terminalId)).resolves.toBeNull();
    device.runtime.stop();
  });

  it('stops the register at a record the server refused, and lets it go again once it is voided', async () => {
    const device = demoDevice();
    const { backend } = device;
    const [adminAccount] = backend.demoAccounts;
    // Voiding is the admin's alone, and the admin is who is signed in here.
    const admin = await backend.auth.signIn({
      email: adminAccount.email,
      password: adminAccount.password,
    });
    expect(admin.roles).toContain('admin');
    const registration = await backend.terminals.register('T1');
    await registerTerminal(device.runtime.storage, registration, device.clock.now());
    const meta = await device.meta();
    device.runtime.start();

    // A sale in a session that does not exist: the server refuses it, and will refuse it again.
    const sale = await numbered(
      device.runtime.outbox.appendSale('sale', ({ seq, meta: current }) =>
        buildSaleRecord(
          {
            id: crypto.randomUUID(),
            seq,
            sessionId: crypto.randomUUID(),
            createdAt: new Date(device.clock.now()).toISOString(),
            terminal: { terminalCode: current.code, epoch: current.epoch },
            tableId: null,
          },
          cartOf(1),
          { method: 'card' },
        ),
      ),
    );
    await device.runtime.sync();

    const blocked = device.records().find((record) => record.id === sale.id);
    if (!blocked || !isNumbered(blocked) || !blocked.lastError) {
      return expect.unreachable(
        'The refused sale should be in the queue, numbered, with its error',
      );
    }
    expect(blocked.status).toBe('conflict');
    expect(canVoid(blocked)).toBe(true);
    expect(device.runtime.snapshot().state).toMatchObject({ kind: 'blocked', recordId: sale.id });
    // The register stops: the receipts behind this one could never be recorded in order.
    expect(gateOf(meta, device.records(), null).kind).toBe('blocked');

    // The admin voids the receipt on the server, then tells the queue what the server said.
    const result = await backend.sales.voidReceipt({
      record: blocked.payload,
      errorCode: blocked.lastError.code,
      reason: 'The session was never opened',
    });
    await device.runtime.outbox.resolveVoid(sale.id, {
      status: result.status,
      receiptNumber: result.receiptNumber,
    });
    await device.runtime.sync();

    expect(device.records().map((record) => record.status)).toEqual(['voided']);
    expect(device.runtime.snapshot().state).toMatchObject({ kind: 'idle' });
    // Nothing blocks the queue any more, so the register is only waiting for a session again.
    const current = await backend.sessions.current(registration.terminalId);
    expect(gateOf(meta, device.records(), current).kind).toBe('closed');
    device.runtime.stop();
  });
});
