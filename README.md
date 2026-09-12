# POS Admin Dashboard

Point-of-sale screen and back-office dashboard for a cash register in a Tunisian shop. Cashiers sell from the POS screen; admins manage products, categories, register settings and the terminals.

> **Status:** this codebase started as a Figma Make export and is being restructured into an offline-first register. Money is exact to the millime, the UI talks to the backend only through ports, and sales go into an append-only ledger with per-terminal receipt numbers, cash sessions and Z-reports. Recording still needs the network in this version; the offline outbox comes next — see [Known issues](#known-issues).

## Screenshots

| Login                    | Dashboard                | POS                      |
| ------------------------ | ------------------------ | ------------------------ |
| _Screenshot placeholder_ | _Screenshot placeholder_ | _Screenshot placeholder_ |

## Features

- Email and password login with two roles per shop: **admin** (dashboard) and **cashier** (POS only). There is no self-service sign-up.
- Products: create, edit, archive and search by name, category or barcode. Prices are entered in dinars with up to three decimals and stored as integer millimes. Stock only changes through recorded movements (opening stock, adjustments, sales, refunds).
- Categories with colour labels.
- Terminals: an admin registers each device as a terminal (`T1`, `T2`, …) in Settings.
- Cash sessions: the cashier opens a session with an opening float, sells, and closes it with the counted cash. Closing shows the Z-report: sales, refunds, net, totals per payment method, expected cash and the variance.
- Receipts numbered per terminal without gaps (`T1-1`, `T1-2`, …). A lost answer is retried with the same record, so it never costs a number and never records twice.
- Refunds are new documents that point at the sale, per line and quantity, never above what is left. Sales and their lines can never be edited or deleted.
- Every amount is shown in Tunisian dinars with three decimals, for example `12,500 DT`.
- A credential-free demo backend that runs entirely in the browser.

## Stack

- React 18, TypeScript, Vite 6
- Tailwind CSS 4 and [shadcn/ui](https://ui.shadcn.com/) components on Radix UI, lucide-react icons, sonner toasts
- React Router 7, TanStack Query, react-hook-form with Zod
- Ports and adapters: an in-memory backend for tests and the demo, and a Supabase backend over tables with row-level security and transactional RPCs
- Supabase CLI for the local stack, pgTAP for database tests
- ESLint (typescript-eslint, react-hooks), Prettier, Vitest

## Getting started

You need Node.js 22.13+ (22.x), 24.x or 26+.

### Demo, no credentials

```bash
npm install
npm run dev:demo
```

Open http://localhost:5173. The backend lives in the browser and starts empty again on every reload.

1. **Continue as Admin**, open **Settings** and register this device as terminal `T1`. Log out.
2. **Continue as Cashier**, open a session with an opening float, sell, refund from **Sales**, and close the session to see the Z-report.

A reload empties the backend but keeps this device's terminal registration, which lives in local storage. Repeat step 1 to register `T1` again before selling; otherwise the POS offers to open a session and the backend refuses it, because it no longer knows this terminal.

### Local Supabase

Needs Docker.

```bash
npm run db:start
npm run db:reset
```

`db:reset` applies `supabase/migrations/` and loads `supabase/seed.sql`: a demo shop with a dozen products, and a second shop the isolation tests use. Copy the API URL and anon key printed by `npx supabase status` into `.env`:

```bash
cp .env.example .env
npm run dev
```

| Account                    | Password             | Role                |
| -------------------------- | -------------------- | ------------------- |
| `admin@demo.local`         | `demo-admin-2026`    | admin, demo shop    |
| `cashier@demo.local`       | `demo-cashier-2026`  | cashier, demo shop  |
| `other-admin@demo.local`   | `other-admin-2026`   | admin, other shop   |
| `other-cashier@demo.local` | `other-cashier-2026` | cashier, other shop |

These accounts exist only in the local database.

### A hosted Supabase project

Never run migrations against a hosted project from a script in this repo. To move a project that still runs the original edge function, follow [docs/runbooks/kv-import.md](docs/runbooks/kv-import.md): apply the schema, create the shop and its members, dry-run the import and review the rejects, import, deploy, then delete the edge function.

## Environment variables

| Variable                 | Required        | Description                                                                               |
| ------------------------ | --------------- | ----------------------------------------------------------------------------------------- |
| `VITE_BACKEND`           | No              | Backend adapter: `memory` or `supabase` (default). `rest` is not available yet.           |
| `VITE_SUPABASE_URL`      | With `supabase` | Supabase project URL, for example `https://<project-ref>.supabase.co`.                    |
| `VITE_SUPABASE_ANON_KEY` | With `supabase` | Supabase anon key. It is embedded in the browser bundle by design, so it is not a secret. |

Vite inlines these values at build time, so a change needs a rebuild. `.env.demo` sets `VITE_BACKEND=memory` for `npm run dev:demo`.

The contract and security tests against the local stack read these from the environment, never from `.env`:

| Variable                    | Description                                                                                        |
| --------------------------- | -------------------------------------------------------------------------------------------------- |
| `CONTRACT_BACKEND`          | Set to `supabase` to run the Supabase contract and security tests.                                 |
| `SUPABASE_URL`              | Local API URL from `npx supabase status`.                                                          |
| `SUPABASE_ANON_KEY`         | Local anon key.                                                                                    |
| `SUPABASE_SERVICE_ROLE_KEY` | Local service role key: re-reads rows and tries the writes nobody may make, in the security tests. |

## Scripts

| Command             | What it does                                                                  |
| ------------------- | ----------------------------------------------------------------------------- |
| `npm run dev`       | Start the dev server with the backend from `.env`.                            |
| `npm run dev:demo`  | Start the dev server with the in-memory demo backend.                         |
| `npm run build`     | Build for production into `dist/`.                                            |
| `npm run preview`   | Serve the production build locally.                                           |
| `npm run lint`      | Run ESLint (no warnings allowed) and Prettier check.                          |
| `npm run format`    | Format the codebase with Prettier.                                            |
| `npm run typecheck` | Type-check with `tsc --noEmit`.                                               |
| `npm test`          | Run the Vitest suite, including the contract suite on the memory backend.     |
| `npm run db:start`  | Start the local Supabase stack (Docker).                                      |
| `npm run db:stop`   | Stop it.                                                                      |
| `npm run db:reset`  | Re-create the local database from the migrations and the seed.                |
| `npm run db:test`   | Run the pgTAP tests in `supabase/tests/database`.                             |
| `npm run db:types`  | Regenerate `src/adapters/supabase/database.types.ts` from the local database. |

## Database

The schema lives in `supabase/migrations/`:

- **Shops and profiles.** Every member belongs to one shop with the role `admin` or `cashier`. Row-level security keeps each shop's rows to its own members.
- **Catalog.** Categories, products (archived rather than deleted) and append-only `stock_movements`; a product's stock is the sum of its movements.
- **Terminals and cash sessions.** A terminal keeps `last_seq` and a registration `epoch`; a terminal has at most one open session, and a closed session cannot change.
- **Sales ledger.** `sales` and `sale_lines` accept writes only through `record_sale`; nobody, including the service role, can update or delete them. Refunds are rows of kind `refund` with negative lines. `receipt_voids` lets an admin give up on a numbered record that can never be accepted, without leaving a gap.
- **Legacy import.** `migration.kv_import` reads the original key-value store, with a dry run and a list of rejects.

Every RPC raises the typed errors of [contracts/errors.md](contracts/errors.md); the app decides what to do from the code alone. RPC parameters and results use snake_case keys, and the adapter converts them to the camelCase of the ports.

## Roles

A member's role and shop come from `public.profiles`, never from token metadata. Add a member once their account exists, after confirming who owns it:

```sql
insert into public.profiles (user_id, shop_id, role, display_name)
select u.id, '<shop-id>', 'cashier', '<name>' from auth.users u where u.id = '<user-id>'
returning user_id;
```

A role change applies to the member's next request; the app shows it after they log out and back in.

## Known issues

- **Recording needs the network.** A sale, refund or session change is sent immediately. If the answer is lost, the register keeps the record and retries it unchanged, but it cannot sell offline yet. The offline outbox is the next step.
- **A hosted project may still run the original edge function.** Its code is gone from this repo, but a deployed copy keeps its service role access, which bypasses row-level security, until you delete it ([runbook](docs/runbooks/kv-import.md), step 7).

## Credits

UI components come from [shadcn/ui](https://ui.shadcn.com/), used under the [MIT license](https://github.com/shadcn-ui/ui/blob/main/LICENSE.md).
