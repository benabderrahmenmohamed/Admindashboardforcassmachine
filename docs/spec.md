# pos-admin-dashboard — specification (v3, café model)

The brief this codebase is built against. Where the code and this document disagree, this document
wins and the code is wrong.

`pos-admin-dashboard` is a React 18 + Vite + TypeScript app for a Tunisian café with four faces: an
admin dashboard (menu, prices, availability, tables, terminals, reports), a waiter app (tables and
orders, mobile-first), a caisse screen (pay tables, cash sessions) and a kitchen screen (tickets). It
was exported from Figma Make; data lived as JSON in a KV table behind an edge function.

Three properties most portfolio POS apps lack:

1. **Offline-first.** Waiters keep taking orders and terminals keep selling when the network drops;
   every event queues locally and reaches the backend exactly once, in order.
2. **Money done right for TND.** Integers in millimes (3 decimals), no floats anywhere; cash sessions
   with a Z-report; per-terminal gapless receipt numbers; an append-only sales ledger where a refund
   is a new document, never an edit.
3. **Backend-swappable by design.** UI talks only to ports; adapters exist for in-memory (tests,
   credential-free demo), Supabase (demo now), and REST (Spring Boot later, contract-first).

Permissions: read, edit, create, delete, run npm, Docker, the Supabase CLI locally, and commit. Do
not push — the owner pushes manually. Never run migrations or scripts against the remote Supabase
project: write them under `supabase/migrations/` and `scripts/`, verify on local Supabase.

## Domain — one codebase, four roles

- **Roles**: `admin`, `cashier`, `waiter`, `kitchen`. One React app, routes by role: `/admin/*`,
  `/serveur` (mobile-first, installable), `/caisse`, `/kitchen`. A user can hold several roles (the
  owner is admin + cashier).
- **Menu**: `products` with `price_millimes`, `category_id`, `is_available` (on the menu right now /
  sold out — a daily toggle for admin and waiters), `track_stock` + `stock_qty` (optional; most café
  items are untracked).
- **Tables**: `dining_tables(id, shop_id, name, sort_order, is_active)`, managed by the admin. Waiter
  and caisse see a table grid with state: free / open with running total / has unsent items / all
  sent.
- **Open orders are working state, not the ledger.** `open_orders(id, shop_id, table_id, status
  'open'|'closed'|'cancelled', opened_at, closed_at)` is created lazily by the server when the first
  item lands on a free table — there is no "open order" event, so two devices adding to the same
  table never race on creation. `open_order_items(id, order_id, product_id, name_snapshot,
  unit_price_millimes (snapshot at add), qty, note, added_by, added_at, sent_at, prepared_at,
  removed_at, removed_by, removed_reason, paid_sale_id)`. Any waiter can act on any table. Adding is
  an insert; removing stamps `removed_at` and keeps the row — the admin gets a report of items
  removed after being sent, per waiter, because that is the classic waiter fraud.
- **Kitchen**: "send" stamps `sent_at` on the table's unsent items; one send = one ticket. The
  kitchen screen lists sent, unprepared items grouped by table and ticket, live, and marks them
  prepared. Removing an already-sent item shows on the kitchen screen as a void. Ticket printing
  (ESC/POS) is roadmap.
- **Payment** happens at the table (waiter) or at the counter (cashier). A terminal is any device
  registered by the admin to take payment; each terminal has its own receipt sequence and its own
  cash session. Paying a table is one `record_sale` for a set of that order's active, unpaid items;
  items are paid whole; the order closes when no unpaid item remains, so a table can pay in parts.
  Splitting one item between payers is roadmap. A line discount / offered item ("offert") exists only
  at payment, needs a reason, and is allowed for cashier and admin.
- **Devices**: every device has a `device_id` (`localStorage`); order events carry it. Only a
  registered terminal with an open session can record sales or refunds.

## Money

- Domain type `Millimes` (branded integer). Every price, discount, total, tender and change is
  `Millimes`. Never a float, never a string with a comma.
- One module `src/lib/money.ts`: `mm()`, `add`, `sub`, `mulQty`, `pct(amount, basisPoints)`,
  `allocate(amount, weights)` (largest-remainder, sums exactly), `formatTND`, `parseTND`. Rounding:
  half away from zero to the millime, applied once inside `pct`; `allocate` never rounds away a
  millime. Documented in an ADR.
- Display via `Intl.NumberFormat('fr-TN', { style: 'currency', currency: 'TND' })` — three fraction
  digits (`12,500 DT`). Price inputs take dinars with up to 3 decimals, accept `.` or `,`, and go
  through `parseTND` → millimes.
- Database columns are `*_millimes bigint`. No VAT, no currency setting: TND only.

## Ledger

- `sales` and `sale_lines` rows are immutable. No UPDATE or DELETE policy for any role — enforced by
  RLS, not convention. Direct INSERT is denied: the only write path is the `record_sale` RPC.
- `sales.kind ∈ {'sale','refund'}`. A refund is a new row with negative line quantities and amounts,
  each line pointing at an original line via `refunds_sale_line_id`. Cumulative refunded qty per
  original line ≤ sold qty; cumulative refunded amount ≤ that line's net.
- Every sale line of a `sale` references an `open_order_item_id`. The server checks the item belongs
  to the table's open order, is active and unpaid, and matches product, qty and unit price → else
  `ORDER_CHANGED` (somebody added or removed something meanwhile; the terminal refreshes the table
  and pays again).
- A cart-level discount is allocated across lines at sale time with `allocate` (largest remainder),
  so every line has `allocated_discount_millimes` and `net_millimes = qty·unit − line_discount −
  allocated_discount`, and the line sum equals the sale total exactly. Partial refunds take the
  proportional share of a line's net, remainder on the last unit refunded.
- Payment: `{ method: 'cash' | 'card', tendered_millimes, change_millimes }`. Card is an external
  TPE; we only record it. Change only exists for cash.
- Cash sessions (`cash_sessions`): `terminal_id, opened_by, opened_at, opening_float_millimes,
  closed_at, closed_by, closing_counted_millimes, client_expected_cash_millimes,
  expected_cash_millimes`. A sale requires an open session on its terminal; a terminal has at most one
  open session. Open and close are outbox records, so a shift can start offline. The Z-report is
  computed locally at close for display and print, and recomputed by the server on accept: sales
  count, refund count, gross, refunds, net, totals by payment method, expected cash = opening float +
  cash sales − cash refunds, counted cash, variance. A difference between client and server expected
  cash is shown on the session as a discrepancy; it is not a queue conflict, because every sale of
  the session was acked before the close by construction.
- **Receipt numbering**: per terminal, `"{terminal_code}-{seq}"`, allocated by the terminal (single
  writer), gapless, on sales and refunds only. `seq` is assigned in the same IndexedDB transaction
  that writes the outbox record. The server enforces `seq = terminals.last_seq + 1` on accept; a gap
  or duplicate is a conflict surfaced to a human, never silently repaired.
- **Single-writer guarantee**: a terminal page takes a Web Lock (`navigator.locks.request('terminal:'
  + code, { ifAvailable: true }, …)`) on mount and refuses to sell if it cannot hold it. On terminal
  (re)registration the client adopts `last_seq` from the server.
- **Stock**: `stock_movements(product_id, qty_delta, reason 'sale'|'refund'|'adjustment', sale_id,
  created_by, created_at)` is append-only, written by `record_sale` only for `track_stock` products;
  `products.stock_qty` is a maintained cache; manual adjustment is an admin RPC. Stock never blocks a
  sale and may go negative (shown with a warning).
- Client `created_at` is stored but untrusted; the server records `received_at`. Reports group by
  session, never by wall clock.

## Offline outbox

- Menu, tables and the device's relevant open orders are cached locally (TanStack Query +
  `persistQueryClient` on an `idb-keyval` persister). The app shell is precached with
  `vite-plugin-pwa` so a phone that reloads while offline still opens the app.
- Every mutation is an outbox record written to IndexedDB before any network call. Kinds:
  `order_item_add`, `order_item_remove`, `order_send`, `order_item_prepare`, `order_cancel`, `sale`,
  `refund`, `session_open`, `session_close`. Record: `{ ordinal, id, kind, seq?, terminal_code?,
  device_id, payload, payload_hash, created_at, attempts, next_attempt_at, status, last_error }`.
  `ordinal` is a local monotonic counter (drain order); `seq` exists only on sale/refund. `id` is
  `crypto.randomUUID()`; `payload_hash` is SHA-256 (`crypto.subtle`) of the canonical JSON payload.
- **Status machine**: `pending → sending → acked`; `sending → pending` on retriable failure (network,
  5xx, 429); `sending → conflict` on `IDEMPOTENCY_CONFLICT`, `SEQUENCE_GAP`, `SESSION_CLOSED`,
  `SESSION_ALREADY_OPEN`, `ORDER_CHANGED`, `ORDER_CLOSED`, `ITEM_NOT_FOUND`, `VALIDATION_ERROR`,
  `FORBIDDEN`. From `conflict`: ledger kinds (`sale`, `refund`, `session_*`) can only go back to
  `pending` after review; order kinds can also be discarded with a reason into a local dead-letter
  list reported to the admin — a stale item on a table the caisse already closed must not block a
  waiter's phone forever, but a sale must never be dropped.
- **Drain**: one queue per device, strictly in `ordinal` order, one request in flight, stop on the
  first record that does not ack, and the UI says so loudly. Triggers: app start, `online` event,
  every 30 s, after each local write. Backoff `min(500 ms · 2^attempts + jitter, 60 s)`, unlimited
  attempts for retriable errors.
- `src/features/sync/outbox.ts` is pure: it receives `{ storage, transport, clock, random }` so it
  runs against fakes in tests. React only subscribes to it.
- Views merge server rows with pending local records and flag them `pending`: a waiter sees the item
  on the table the instant they tap it; a terminal shows the receipt immediately with its
  terminal-allocated number.
- **Live updates**: `RealtimePort.subscribe(shopId, handler)` invalidates the affected queries.
  Supabase adapter = Realtime channel on `open_orders`, `open_order_items`, `dining_tables`,
  `products`; memory adapter = in-process emitter; rest adapter = polling `?since=<cursor>`.
- UI: a persistent sync chip (pending · last ack · conflicts) in every layout, an offline banner, and
  a Conflicts screen with the review / retry / discard actions above.

## Write contracts — transactional Supabase RPCs now, Spring `@Transactional` services later

Every RPC takes `p jsonb` with a client `id` and `payload_hash`; same id + same hash → `status
'replayed'` with the original result; same id + different hash → `IDEMPOTENCY_CONFLICT`. All are
`SECURITY DEFINER` with explicit shop and role checks (`auth.uid()` → profile → `shop_id`, roles), so
no role holds direct write policies. They raise with `message = <CODE>` and JSON `detail`; the
Supabase adapter maps that to `AppError.code`; the outbox decides retriable vs conflict from `code`
only. Codes live in `contracts/errors.md`.

```
order_item_add(p)     p = { id, table_id, product_id, qty, note, added_at }
  → find the table's open order or create it; snapshot name and price; insert item.
  A closed order means the table is free again, so a late add (a waiter's offline event
  arriving after the caisse paid the table) opens a new order with that item: the caisse
  sees an unpaid item rather than losing it. TABLE_INACTIVE / FORBIDDEN otherwise.
order_item_remove(p)  p = { id, item_id, reason }
  → stamp removed_at; ITEM_NOT_FOUND if unknown; ORDER_CHANGED if already paid;
    ORDER_CLOSED if its order is no longer open.
order_send(p)         p = { id, table_id, sent_at }   → stamp sent_at on unsent active items;
    ORDER_CLOSED if the table has no open order.
order_item_prepare(p) p = { id, item_id }             → stamp prepared_at (kitchen, admin).
order_cancel(p)       p = { id, table_id, reason }    → cancel the open order; ORDER_CHANGED if any
    item is paid (cashier, admin).

record_sale(p) → { sale_id, receipt_number, status }
p = { id, kind, terminal_code, seq, session_id, table_id?,
      lines: [{ open_order_item_id?, product_id, qty, unit_price_millimes, line_discount_millimes,
                line_discount_reason?, allocated_discount_millimes, net_millimes,
                refunds_sale_line_id? }],
      cart_discount_millimes, total_millimes,
      payment: { method, tendered_millimes, change_millimes },
      refunds_sale_id?, created_at, payload_hash }
In one transaction:
1. Idempotency check as above.
2. p.session_id open and in the caller's shop; terminal in that shop; caller may sell → else
   FORBIDDEN / SESSION_CLOSED.
3. Lock the terminal row; require p.seq = last_seq + 1 → else SEQUENCE_GAP with { expected_seq }.
4. For a sale: every line's open_order_item_id is active, unpaid, on the table's open order, and
   matches product / qty / unit price → else ORDER_CHANGED. Recompute every net and the total;
   sum(allocated) = cart discount. For a refund: every line references a line of refunds_sale_id;
   cumulative qty and amount per original line stay within limits → else VALIDATION_ERROR with
   details. Refunds need cashier or admin.
5. Insert sale + lines; mark items paid_sale_id; close the order if no unpaid active item remains;
   insert stock_movements for tracked products; update stock_qty; set last_seq = p.seq; return
   'created'.

open_session(p)  p = { id, terminal_code, opening_float_millimes, opened_at }
  → SESSION_ALREADY_OPEN if the terminal has an open session with another id.
close_session(p) p = { id, closed_at, closing_counted_millimes, client_expected_cash_millimes }
  → SESSION_CLOSED if not open; compute and store the server Z-report, keep the client figure
    alongside.
adjust_stock(p)  p = { id, product_id, qty_delta, reason }   (admin)
```

## Ports and adapters

- `src/ports/`: `AuthPort`, `CatalogPort` (products, categories, availability, stock adjustment),
  `OrdersPort` (tables, open orders, item add/remove, send, prepare, cancel), `SalesPort`
  (`recordSale`, `listSales`, `getSale`), `SessionsPort` (`open`, `close`, `current`, `zReport`),
  `SettingsPort` (shop profile, receipt header/footer, terminals), `RealtimePort`. Ports are
  TypeScript interfaces plus Zod schemas for every DTO; they know nothing about Supabase.
- `src/adapters/memory/` — reference implementation, used by unit and page tests and by
  `VITE_BACKEND=memory` for a credential-free demo. Has a fault-injection flag.
- `src/adapters/supabase/` — production for now. One client in `src/adapters/supabase/client.ts`.
- `src/adapters/rest/` — same ports against `contracts/openapi.yaml`; types generated with
  `openapi-typescript`; tested with MSW.
- Composition root `src/lib/backend.ts` picks the adapter from `VITE_BACKEND`
  (`memory | supabase | rest`). Components import ports and hooks only, never an adapter.
- Contract tests: `src/ports/__contracts__/*.contract.ts` export `describeSalesPortContract`,
  `describeOrdersPortContract` and friends — one suite, run against memory always, against rest via
  MSW always, against Supabase when `CONTRACT_BACKEND=supabase` (local stack).

## Phases

**Phase 0 — understand first.** Read the export, map every network call and today's table mode,
report how money is stored and what exists, run install/dev/build, record `docs/baseline.md`.

**Phase 1 — hygiene.** Env vars, dependency removal, ESLint and Prettier, `typecheck`, package
rename, this spec at `docs/spec.md`, a real README.

**Phase 2 — structure and ports.** Feature folders, ports, memory adapter, Supabase adapter wrapping
the existing edge function with table mode behind `OrdersPort`, `money.ts` with `allocate`, TanStack
Query, Zod forms, the payment cart in `src/features/caisse/cart.ts`, a slim auth context with role
guards, currency picker and tax rate removed.

**Phase 3 — data model, migration and ledger.** The tables above with RLS and RPCs; the KV → tables
migration with a dry run and a rejects file; local stack and seed; the Supabase adapter on tables and
RPCs and the edge function deleted; the four role screens; realtime. The contract run against local
Supabase proves shop isolation, role limits, ledger immutability, lazy order creation under two
devices, partial payment, a late add after payment, `ORDER_CHANGED` on a stale line, replay,
`SEQUENCE_GAP`, a second session open, and refund limits.

**Phase 4 — offline outbox.** Persisted caches, PWA shell, the outbox with the status machine above,
drain loop, Web Lock, sync chip, offline banner, Conflicts screen with discard-with-reason for order
kinds only, and the unit tests named in the brief.

**Phase 5 — quality and delivery.** Vitest and Testing Library, `contracts/openapi.yaml` and the REST
adapter with MSW, two Playwright specs (memory single-device; local Supabase with waiter, kitchen and
caisse in one context), GitHub Actions, Docker and nginx, deploy config, and the two demo strategies.

**Phase 6 — portfolio polish.** README with the four faces and a Mermaid diagram, ADRs 0001-0008,
Lighthouse pass including touch targets on `/serveur`.

## Rules

- Work phase by phase; commit each phase with a conventional-commit message.
- `npm run lint && npm run typecheck && npm test && npm run build` must pass before every commit.
- No dependency without saying why. Expected: `@tanstack/react-query`,
  `@tanstack/react-query-persist-client`, `@tanstack/query-async-storage-persister`, `idb-keyval`,
  `zod`, `react-hook-form`, `@hookform/resolvers`, `vite-plugin-pwa`; dev: `vitest`,
  `@testing-library/react`, `jsdom`, `fake-indexeddb`, `msw`, `@playwright/test`,
  `openapi-typescript`, ESLint/Prettier packages. Anything else: ask first. Prefer removing over
  adding.
- Never commit secrets. Never run migrations or scripts remotely.
- UI behaviour stays identical through Phase 2 except the Settings removals. Phases 3-4 add exactly
  the features specified and nothing else. `/serveur` is the one screen that gets a mobile-first
  layout.
- Every error is a typed `AppError` with a `code`. Retriable vs conflict is decided from `code`,
  never from message text. No silent `catch`.
- If part of this plan is a bad idea, say so and propose better.
