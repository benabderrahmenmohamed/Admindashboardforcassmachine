# 5. Records are queued on the device before any network call

**Status:** Accepted. Landed in Phase 4 (`8c57cf9`, "sell with no network, drain exactly once").

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
opens and closes), `status`, `attempts`, `nextAttemptAt`, `lastError`, `result`, `ackedAt`, and the payload
exactly as it was written and hashed.

**Drain in ordinal order, stopping at the first record that cannot go.** `pass()` takes
`storage.firstUnfinished()` — the lowest ordinal that is pending, sending or in conflict — and loops. Nothing
may reach the ledger out of order, because a later record carries a later receipt number (ADR 0004).

**One drainer at a time.** `drain()` collapses concurrent calls within the tab, then runs the pass under
`deps.lock.runExclusive('outbox:' + meta.code, pass)`. `createWebLocksDrainLock` uses
`navigator.locks.request(name, { ifAvailable: true })`: a tab that finds the lock held returns `busy` and
skips this pass rather than queueing behind it, and every tab keeps its own triggers so draining continues if
that tab closes. Under the lock, `resetSending()` puts back anything a pass that died left marked `sending`.

**What a failure does is decided by its class** (`errorClass`, [contracts/errors.md](../../contracts/errors.md)):

- **retriable** — the record stays `pending`, one attempt is counted, and it waits
  `backoffDelay(attempts, random)` = `min(500 ms × 2^attempts + jitter under 250 ms, 60 s)`. There is no
  attempt limit: "A register must not give up on a real sale."
- **auth** — the queue pauses. The record and its attempt count are untouched, so a wrong password costs
  nothing; the pass resumes when there is a session again.
- **conflict** — the record becomes `conflict` and the queue stops there (`{ state: 'blocked', recordId }`).
  Later records stay pending behind it until a person retries or voids it.

**Reconnecting brings a waiting retry forward.** `schedule.onOnline` calls `outbox.wakeNow()`, which sets
`nextAttemptAt = now` on every pending record still waiting, then drains. Attempt counts are left as they are,
so a record that fails again waits as long as it had earned.

The other triggers are app start, every `DRAIN_INTERVAL_MS` (30 s), every change the outbox makes — an append,
a retry, a resolved void — and a timer for the earliest `retryAt`.

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
- **A retry limit, or a dead-letter queue.** A dropped sale is money the shop cannot account for. Retriable
  failures are, by definition, ones that can succeed later.
- **`BroadcastChannel` or a hand-rolled leader election instead of Web Locks.** A Web Lock is released when the
  tab dies; an elected leader that crashes holds the queue until something notices.
- **Service worker background sync.** Not available in every browser the shop may use, and the register is open
  while it sells — the page itself is the thing that needs to drain.
