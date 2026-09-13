# 5. Records are queued on the device before any network call

**Status:** Accepted. Landed in Phase 4 (`8c57cf9`, "sell with no network, drain exactly once"); one queue
per device, order records and discarding in v3 Phase 4 (`5b44149`); retention in `45322ff`.

## Context

Phase 3 sent a record and waited: the register called the port, and the cashier waited for the answer before
seeing a receipt. It held one unsent record in local storage under `pos.pendingRecord`, and this device's
terminal registration under `pos.terminal`. A shop whose connection drops for ten minutes could not sell for
ten minutes, and a second record could not be written while the first was stuck.

## Decision

**Queue first, then network.** `useRegister.write` in `src/features/pos/hooks/useRegister.ts` appends the
record to the outbox, shows the receipt with `recordedMessage`, invalidates the terminal query, and calls
`runtime.drain()` without awaiting it. `drain` is documented as asking for a pass without waiting for it:
nothing on a screen ever waits for the server.

**Every record has an ordinal.** `OutboxRecord` carries `ordinal` (drain order across sales, refunds, session
opens and closes, and the five order kinds of the café model), `status`, `attempts`, `nextAttemptAt`,
`lastError`, `result`, `ackedAt`, and the payload exactly as it was written and hashed.

**Drain in ordinal order, stopping at the first record that cannot go.** `pass()` takes
`storage.firstUnfinished()` — the lowest ordinal that is pending, sending or in conflict — and loops. Nothing
may reach the ledger out of order, because a later record carries a later receipt number (ADR 0004).

**One drainer at a time.** `drain()` collapses concurrent calls within the tab, then runs the pass under
`deps.lock.runExclusive(DRAIN_LOCK_NAME, pass)`, one name for the whole device (see What was revised).
`createWebLocksDrainLock` uses `navigator.locks.request(name, { ifAvailable: true })`: a tab that finds the
lock held returns `busy` and skips this pass rather than queueing behind it, and every tab keeps its own
triggers so draining continues if that tab closes. Under the lock, `resetSending()` puts back anything a pass
that died left marked `sending`.

**What a failure does is decided by its class** (`errorClass`, [contracts/errors.md](../../contracts/errors.md)):

- **retriable** — the record stays `pending`, one attempt is counted, and it waits
  `backoffDelay(attempts, random)` = `min(500 ms × 2^attempts + jitter under 250 ms, 60 s)`. There is no
  attempt limit: "A register must not give up on a real sale."
- **auth** — the queue pauses. The record and its attempt count are untouched, so a wrong password costs
  nothing; the pass resumes when there is a session again.
- **conflict** — the record becomes `conflict` and the queue stops there (`{ state: 'blocked', recordId }`).
  Later records stay pending behind it until a person retries it, voids it (a numbered record, admin only) or
  discards it with a reason (an order record only — see What was revised).

**Reconnecting brings a waiting retry forward.** `schedule.onOnline` calls `outbox.wakeNow()`, which sets
`nextAttemptAt = now` on every pending record still waiting, then drains. Attempt counts are left as they are,
so a record that fails again waits as long as it had earned.

The other triggers are app start, every `DRAIN_INTERVAL_MS` (30 s), every change the outbox makes — an append,
a retry, a resolved void, a discard, a prune — and a timer for the earliest `retryAt`.

**Storage** is IndexedDB for a backend with a server behind it and memory for the demo, whose data starts empty
on every reload anyway (`createOutboxStorage`).

### What was revised

**The registration moved out of local storage and into the outbox meta.** Phase 3's two keys became
`OutboxMeta` — `terminalId`, `code`, `epoch`, `lastSeq`, `nextOrdinal`, `registeredAt` — stored beside the
records in the same store. The reason is the one in ADR 0004: the receipt number is allocated inside the very
transaction that stores the record, through `appendIfUnchanged`, and a counter in a different store could hand
the same number out twice.

`migrateLegacyTerminal` in `src/features/terminal/terminalStore.ts` moves an existing Phase 3 device over
once: the registration becomes the meta row, the one unsent record becomes the first record of the queue with
its original id, hash and receipt number, and `lastSeq` is raised to that number — Phase 3 committed a number
only after the server answered, so the record holds a number the counter has not reached. A record without a
registration is dropped, because its terminal and epoch are unknown. Both keys are then removed;
`clearOfflineState` removes them too, as `LEGACY_STORAGE_KEYS`.

**One queue per device, not per terminal (café model).** A waiter's phone writes order records and is never
registered, so the meta row became `OutboxMeta { nextOrdinal, terminal: TerminalMeta | null }` and the drain
lock is the one name `DRAIN_LOCK_NAME = 'outbox'`. Sales, refunds and session records still need the
registration; order records do not.

**An order record may be given up on; a ledger record never.** The outbox gained `discard(id, { reason,
discardedBy, discardedByName })`, which refuses anything but an order record in conflict and a blank reason,
and moves the record to `discarded`: out of the queue's way, kept on the device in its dead-letter list, with
who gave up on it by name, because a phone has no staff list to look an account up in. A sale, a refund or a
session record is only ever retried or voided. The screens draw the queue's order records over the server's
reads (ADR 0007), so a tap shows on the table at once and a queued table payment keeps its rows from being
charged twice.

**Records the server has had for a week are deleted.** Every tap of a busy café is a record and every screen
reads the whole queue on each change, so a queue that only grew would slow a cheap phone down within weeks.
`prunable` in `src/features/sync/retention.ts` picks the records acked at least `RETENTION_MS` (7 days) ago,
and keeps these however old they are: the last record acked, so the sync chip can still say when the device
last sent; every record of the session the till is still in, which its own Z-report is counted from; and a
record a kept one is described by — the add of an item a removal or prepare names, the sale a refund takes
back. Nothing that is not acked is ever deleted: pending, sending and conflicting records are data only the
device has, a voided one is a spent receipt number, a discarded one is the dead-letter list. `storage.prune`
reads and deletes in one transaction and refuses to delete anything but an acked record whatever it is asked;
the counters stay, so no ordinal or receipt number is reused. The runtime prunes once at start and every
`PRUNE_INTERVAL_MS` (an hour); a failed prune is logged and retried the next hour, and never changes the
queue's state.

## Consequences

- A cashier sells with no network and the receipt number is correct immediately.
- The register shows its own truth rather than the server's, so screens have to say where a record stands:
  `SyncChip`, `SyncBadge`, `OfflineBanner`, the Conflicts screen, and `recordErrorMessage`, which turns a code
  into a sentence a cashier can act on.
- Everything about a session also has to work offline. `src/features/pos/queue.ts` rebuilds the session
  (`localSession`), whether this device opened or closed it (`openedHere`, `closedHere`) and its Z-report
  documents (`sessionDocuments`) from the device's own records, skipping voided and conflicting ones.
- Cost: a conflict stops the whole queue for that device. `posGate` returns `blocked` and the register refuses
  to sell, because the next receipt would queue behind a record that can never be recorded.
- Cost: retrying without a limit means a record for a shop that no longer exists retries forever. The demo
  works around it by clearing the device's state at boot (`clearOfflineState` in `src/lib/backend.ts`) rather
  than replaying records into a shop that is gone.
- Web Locks and Web Crypto need a secure context; `posGate` returns `insecure` and the register will not sell
  over plain http, which is why the container publishes to `127.0.0.1:8080`.

## Alternatives rejected

- **Wait for the server on each sale (Phase 3).** The register stops working whenever the connection does, and
  a shop cannot take cash.
- **Drain in parallel, or out of order.** The server would refuse everything behind the first gap, and the
  ledger's order would become the network's order.
- **Skip a conflicting record and keep sending.** Later records carry later numbers; accepting them leaves a
  gap that nothing explains (ADR 0004). The queue stops instead, and a person decides.
- **A retry limit, or a dead-letter queue for every kind of record.** A dropped sale is money the shop cannot
  account for, and retriable failures are, by definition, ones that can succeed later. The dead-letter list
  the café model added is for order records only, and only a person puts a record there, with a reason.
- **`BroadcastChannel` or a hand-rolled leader election instead of Web Locks.** A Web Lock is released when the
  tab dies; an elected leader that crashes holds the queue until something notices.
- **Service worker background sync.** Not available in every browser the shop may use, and the register is open
  while it sells — the page itself is the thing that needs to drain.
