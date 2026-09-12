# 6. The sales ledger is append-only

**Status:** Accepted. Landed in Phase 3 (`ecc42fe`); the audited demo-reset exception in Phase 5 (`2a9a438`).

## Context

The export kept its data in a key-value store that an edge function wrote with the service role. Any row could
be overwritten by anything holding that key, and nothing recorded that it had been. A register's value is that
its history is what happened; a table that can be edited has no such value.

## Decision

`public.sales` and `public.sale_lines` are written only by `record_sale`, and are never updated or deleted.
That is enforced in three layers, kept together in `20260911000008_rls_and_grants.sql` so they can be reviewed
in one place.

1. **Grants.** `anon` and `authenticated` are revoked from every table, then granted `select` back. The only
   plain client writes anywhere in the schema are `insert (name, color)` and `delete` on `categories` and
   `update (receipt_footer)` on `shop_settings`. Row-level security policies keep each shop's rows to its own
   members. Everything else goes through a `security definer` RPC, and `execute` is granted to `authenticated`
   on exactly ten functions.
2. **The service role loses its write privileges.** `insert`, `update`, `delete` and `truncate` are revoked
   from `service_role` on `sales`, `sale_lines`, `stock_movements` and `receipt_voids`. It keeps `select`,
   which tests and support use. A leaked service key can read the ledger; it cannot rewrite it. The old edge
   function's key could.
3. **Triggers, for the roles that keep their privileges** — the owner and superusers.
   `private.reject_ledger_change` backs `sales_append_only`, `sale_lines_append_only`,
   `stock_movements_append_only` and `receipt_voids_append_only` (row-level, before update or delete) and a
   `*_no_truncate` statement trigger on each. They raise `FORBIDDEN` (`PT403`) unless the transaction has
   first run `set local pos.ledger_maintenance = 'on'`. The switch grants nothing by itself — the API roles
   have no such privilege to unlock — and it does not stop a superuser, who can disable triggers. It guards
   against mistakes.

**A correction is a new document.** A refund is a `sales` row of kind `refund` with `refunds_sale_id` set,
negative quantities and a negative total, no discount and no change; `sales_kind_shape` and
`sale_lines_shape` enforce that shape at the table. `record_sale` takes
`pg_advisory_xact_lock(refunds_sale_id)` before summing earlier refunds per line, refuses more than is left,
and refuses a refund of a line's last units that does not pay exactly what remains. The original sale is never
touched: `SaleLineView.refundedQty` and `refundedMillimes` are computed from the refunds pointing at it. A
numbered record the server can never accept is voided rather than edited away (ADR 0004).

**Stock moves only through movements.** `products.stock` has exactly one writer, `private.move_stock`, which
inserts a `stock_movements` row in the same call; the movements table is append-only alongside the ledger. A
product's stock is the sum of its deltas, with reasons `opening`, `adjustment`, `sale`, `refund`. The product
form sends `stockDelta` — counted minus what was shown when the form opened — not a new total
(`toProductUpdateInput`), so a sale recorded while the form was open is not undone. Stock may go negative: a
sale that happened is never refused for stock. Products are archived (`archived_at`), never deleted, so sale
lines keep pointing at them. Closed sessions are final too, by `cash_sessions_closed_are_final`.

**The one exception is the nightly demo reset.** `private.reset_demo_shop`
(`20260911000009_demo_reset.sql`) refuses any shop not listed in `private.demo_shops`, turns
`pos.ledger_maintenance` on transaction-locally, removes the trading history of the shop's **closed** sessions,
deletes `adjustment` movements, recomputes `products.stock` from the movements that are left, turns the switch
off again before returning, and reports what it deleted. It keeps open sessions and everything in them, any
sale a kept refund points at, and the terminals' `last_seq`, so receipt numbering never repeats. It runs as
the database owner from `pg_cron`; `supabase/scripts/schedule_demo_reset.sql` schedules it at 03:00 UTC and
says it belongs on a demo project only.

**It is tested from both sides.** `supabase/tests/database/01_ledger.test.sql` asserts a cashier cannot update
or delete sales or sale lines or write stock directly. `src/adapters/supabase/security.test.ts` — "lets nobody
update or delete a sale or its lines, and the rows stay exactly as they were" — tries all four writes as the
cashier, the admin **and the service role**, then re-reads the rows and compares them.
`supabase/tests/database/03_demo_reset.test.sql` covers what the reset keeps, what it removes, and that the
same deletes are still refused outside it.

## Consequences

- The history is what happened. A wrong sale is corrected by a refund, and a record that can never be accepted
  by a void row carrying the payload, the error code, a reason and who wrote it.
- Cost: rows only accumulate. Nothing prunes `sales`, `sale_lines` or `stock_movements`, and there is no
  retention or archival scheme. A busy shop's ledger grows without bound.
- Cost: a demo shop needs an escape hatch, and that hatch is a privileged function plus a global setting. What
  keeps it safe is a table of allowed shops and a test file, not the privilege system.
- Every write path is a `security definer` RPC, so the API surface is those functions and the checks inside
  them. The order of the checks becomes part of the contract
  ([contracts/errors.md](../../contracts/errors.md), "Order of checks").
- Reading what is left of a line means summing the refunds that point at it on every read — `refundedOf` in
  the memory adapter, the equivalent in the Supabase one.
- A hosted project that still runs the original edge function keeps its service-role access until the function
  is deleted; nothing in this migration reaches it. It is listed under "Known issues" in the README and is
  step 7 of [docs/runbooks/kv-import.md](../runbooks/kv-import.md).

## Alternatives rejected

- **Update a sale in place, or soft-delete it with a `voided` flag.** A row that can be updated will be updated
  wrongly, and a flag does not record what the row used to say.
- **Audit triggers writing to a shadow table.** The shadow table is only as trustworthy as the privilege that
  writes it. Refusing the write is cheaper than reconstructing the truth from an audit log later.
- **Row-level security alone.** RLS does not apply to the table owner and is bypassed by the service role —
  which is precisely what the old edge function held. Grants plus triggers cover both.
- **Reset the demo shop with the service role.** It deliberately has no such privilege. The reset is a function
  the owner runs on a shop that has been listed for it.
- **Reset the demo shop completely, catalog and terminals included.** Lowering `last_seq` would make a register
  hand out receipt numbers it has already used.
