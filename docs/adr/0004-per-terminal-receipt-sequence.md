# 4. Receipts are numbered per terminal, without gaps

**Status:** Accepted. Landed in Phase 3 (`ecc42fe`); the allocation moved into the outbox's own transaction in
Phase 4 (`8c57cf9`).

## Context

A register's receipts have to be numbered so that a missing number is a question someone can answer. The
numbering must hold while the device is offline, while a device is replaced, and while a record the server
refuses is sitting in the queue.

## Decision

`public.terminals` (`20260911000005_terminals_and_sessions.sql`) keeps two counters per terminal: `last_seq`,
"the last receipt number used by this terminal, across sales, refunds and voided receipts", and `epoch`,
"bumped by every registration". A receipt number is `code || '-' || seq`, for example `T1-7`.

**The device allocates, inside the transaction that queues the record.** `append` in
`src/features/sync/outbox.ts` reads the meta row, takes `seq = meta.lastSeq + 1`, builds the record with that
number, and calls `storage.appendIfUnchanged({ lastSeq, nextOrdinal }, record, next)`: one transaction that
stores the record and the new counters, or changes nothing. If another context allocated in between it retries
with fresh numbers, up to `APPEND_ATTEMPTS` (5), then fails with "Could not reserve the next receipt number."
So no number is used twice and none is skipped on the device.

The counters live in the outbox's meta store beside the records for exactly that reason.
`src/features/terminal/terminalStore.ts` states it: "a counter kept anywhere else could hand the same number
out twice."

**The server enforces `seq = last_seq + 1`.** `record_sale` locks the terminal row first with
`private.lock_terminal` (`select … for update`), so concurrent and retried requests for one terminal run one
at a time and each sees the committed result of the last. Step 6 raises `SEQUENCE_GAP` with
`{ expected_seq, received_seq }` unless the number is the next one; step 8 sets `last_seq = seq`. The unique
key `(terminal_id, seq)` on `sales` — and the same on `receipt_voids` — is the backstop.

**The registration epoch fences a device that was replaced.** `register_terminal` inserts the terminal or, on
conflict, bumps `epoch`, and returns the counter and epoch for the new device to adopt. Every record carries
its `epoch`, and `private.require_epoch` raises `TERMINAL_SUPERSEDED` with `{ terminal_code, current_epoch }`
at step 4 — before the session and before the numbering — so a device that was superseded stops rather than
fights over numbers. On the device, `assertCanRegister` refuses to register while records are still
unfinished, and `registerTerminal` never lowers `lastSeq` for the same terminal row.

**A record that can never be accepted is voided, not skipped.** `void_receipt` is admin-only and audited: it
writes a `receipt_voids` row holding the whole payload, its hash, the error code and a required reason, then
moves `last_seq` to that number. Every receipt number is in `sales` or in `receipt_voids`, never both and
never neither, as the table comment says.

`canVoid` in `src/features/pos/recording.ts` offers it only for a numbered record in conflict whose error is
in `REFUSALS` — `FORBIDDEN`, `NOT_FOUND`, `VALIDATION_ERROR`, `IDEMPOTENCY_CONFLICT`, `SEQUENCE_GAP`,
`SESSION_CLOSED`, `SESSION_ALREADY_OPEN`, `TERMINAL_SUPERSEDED`. Retriable errors, auth errors, `CONFIG_ERROR`
and `UNKNOWN` are deliberately absent: they may hide a record that did arrive. If one did,
`void_receipt` answers `recorded` for the same id and hash, `replayed` if it was already voided, and
`IDEMPOTENCY_CONFLICT` for a different payload under that id.

## Consequences

- Numbering is gapless, and every number resolves to either a document or a void row with a reason and a
  person's name on it.
- Every write for a terminal serialises on that terminal's row lock, so two tabs of one register cannot write
  in parallel. `src/features/pos/hooks/useTerminalLock.ts` holds the Web Lock `terminal:<code>` while the
  register is on screen and `posGate` shows `locked`, so the second tab hears about it immediately instead of
  failing at the server.
- Cost: one refused record stops that device's queue until a person retries or voids it — listed under "Known
  issues" in the README. It is the price of the numbering: a later record carries a later number and cannot be
  accepted ahead of the one in front of it.
- Cost: clearing a blocked queue needs an admin, because `void_receipt` calls
  `private.require_profile(array['admin'])`. A cashier alone cannot get the register selling again.
- A device that loses its local state loses its counter. `recordErrorMessage` splits the two `SEQUENCE_GAP`
  cases because they need different actions: behind the server, register again and adopt its numbering; ahead
  of the server, an admin has to look, since registering never moves this device's numbering back.
- `receipt_voids` also feeds the Z-report: `private.compute_z_report` reports `voids_count` for the session.

## Alternatives rejected

- **A Postgres sequence or `bigserial`.** Sequences do not roll back, so a failed transaction leaves a gap that
  nothing explains — the exact failure this numbering exists to rule out. A device cannot draw from one
  offline either.
- **Let the server assign the number on arrival.** A receipt printed offline would have no number to print, and
  the numbering would follow the order records reach the server rather than the order the register sold in.
- **One sequence for the whole shop.** Two terminals selling offline would have to agree on the next number
  without talking to each other.
- **Skip a number that can never be accepted and carry on.** A gap with no row behind it is indistinguishable
  from a deleted sale.
- **Number receipts by UUID or timestamp, so nothing can collide.** A receipt number is read aloud, written on
  paper and searched for; `T1-7` is the requirement.
