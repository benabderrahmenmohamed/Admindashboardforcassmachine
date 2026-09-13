# 8. A terminal is a device that takes payment, not a person or a role

**Status:** Accepted. Terminals and their registration landed in the first plan's Phase 3 (`ecc42fe`); the
café model (v3 Phase 3, `65fc141`) made a terminal one kind of device among several, and v3 Phase 4
(`5b44149`) gave every device a queue whether or not it is one.

## Context

In the first plan there was one kind of device, the register. Registering a browser made it terminal `T1`,
and everything it wrote was a sale, a refund or a session change. A café has four faces on many devices —
waiters' phones, a screen at the pass, a counter, the back office — and only some of them take money.

Two things need a single owner. Receipt numbers are gapless per sequence, and a sequence needs one writer
(ADR 0004). A cash session is one drawer counted at the end of a shift, and its Z-report must add up to
that drawer. Either could have been attached to a person, to a role, or to a device.

## Decision

**A terminal is a device the admin registered to take payment.** `register_terminal(code)` is admin-only; it
inserts the shop's terminal under that code or bumps its `epoch`, and returns the counter and epoch for the
device to adopt. The device keeps the registration in its outbox meta (`OutboxMeta.terminal`), beside the
receipt counter it allocates from, because a counter kept anywhere else could hand a number out twice. Each
terminal has its own `last_seq`, its own receipt numbers (`C1-17`) and at most one open cash session. The
seed registers `C1`, the counter, and `S1`, a device that takes payment in the room.

**Roles decide what a person may do; registration decides what a device may write.** `record_sale`
requires the `cashier` or `admin` role (`private.require_profile(array['admin', 'cashier'])`) and a
registered terminal with an open session. A waiter's phone is not a terminal and never needs to be: order
records name no terminal. Roles are an array (`profiles.roles`), so a waiter who also takes payment at the
table holds `cashier` as well and carries a registered device, as the owner holds `['admin', 'cashier']` and
works the counter from the back office.

**One writer per terminal.** The counter takes the Web Lock `terminal:<code>` while it is on screen
(`useTerminalLock`) and will not sell without it — `posGate` answers `locked` — so a second tab cannot
number receipts beside the first. The server backs it with the terminal row lock and
`seq = last_seq + 1`.

**One queue per device, terminal or not.** Every device's records drain from one queue under the lock
`outbox` (ADR 0005). Sales, refunds and session records need the registration; order records do not.
Registering again changes the epoch, so it is refused while a sale, refund or session record is still
unsent (`assertCanRegister`), and not held up by an order record on its way to a table.

**Replacing a device fences the old one.** A new registration under the same code bumps `epoch`; every
ledger record carries the epoch it was written under, and `TERMINAL_SUPERSEDED` stops the old device before
it reaches the numbering.

## Consequences

- A shift is a drawer on a device. The Z-report counts one terminal's session, whoever worked it.
- Any device becomes a till by being registered and stops being one when another device takes its code;
  nobody's role changes.
- Cost: the registration and the counter live in the device's IndexedDB. Clearing site data loses them, and
  the device has to be registered again and adopt the server's numbering. The demo clears them on every
  reload on purpose.
- Cost: taking payment at the table takes a registered device and the cashier role. The waiter's face has
  no payment screen; a waiter who takes money opens the counter's face on the device they carry, and that
  face is laid out for a counter, not for a phone.
- Cost: two cashiers sharing one till share one session and one Z-report.

## Alternatives rejected

- **A sequence per person.** A person moves between devices, and two devices of one person working offline
  would allocate the same numbers.
- **A sequence per role, or per shop.** Two counters selling offline would have to agree on the next number
  without talking to each other.
- **Every device a terminal.** Phones and the kitchen screen would each carry a sequence nobody uses and a
  session nobody opens, and re-registering a phone would be refused while table records sat in its queue.
- **Let the waiter role sell.** The spec says payment happens at the table (waiter) or at the counter
  (cashier), and one reading is that the role sells. A sale moves money into a drawer somebody counts at the
  end of the shift, so selling stays with the role that answers for the drawer, and the person who takes
  payment at the table holds it too.
