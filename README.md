# POS Admin Dashboard

Point-of-sale screen and back-office dashboard for a cash register in a Tunisian shop. Cashiers sell from the POS screen; admins manage products, categories and register settings.

> **Status:** this codebase started as a Figma Make export and is being restructured into an offline-first register with integer money (millimes) and a swappable backend. The UI now talks to the backend only through ports, and money is exact to the millime. The Supabase backend is still the original edge function — see [Known issues](#known-issues).

## Screenshots

| Login                    | Dashboard                | POS                      |
| ------------------------ | ------------------------ | ------------------------ |
| _Screenshot placeholder_ | _Screenshot placeholder_ | _Screenshot placeholder_ |

## Features

- Email and password login with two roles: **admin** (dashboard) and **cashier** (POS only).
- Products: create, edit, delete and search by name, category or barcode, with price, stock, barcode and image URL. Prices are entered in dinars with up to three decimals and stored as integer millimes.
- Categories with colour labels.
- POS: product grid with category filter and search, barcode entry, cart, cash or card checkout, stock decremented on payment.
- Settings: the receipt footer.
- Every amount is shown in Tunisian dinars with three decimals, for example `12,500 DT`.
- A credential-free demo backend that runs entirely in the browser.

## Stack

- React 18, TypeScript, Vite 6
- Tailwind CSS 4 and [shadcn/ui](https://ui.shadcn.com/) components on Radix UI, lucide-react icons, sonner toasts
- React Router 7, TanStack Query, react-hook-form with Zod
- Ports and adapters: an in-memory backend for tests and the demo, and a Supabase backend (Supabase Auth plus the legacy edge function for data)
- ESLint (typescript-eslint, react-hooks), Prettier, Vitest

## Getting started

You need Node.js 22.13+ (22.x), 24.x or 26+.

### Demo, no credentials

```bash
npm install
npm run dev:demo
```

Open http://localhost:5173 and use one of the demo accounts on the login page. Everything lives in the browser and resets when you reload.

### Against Supabase

Set up a project as described in [Backend setup](#backend-setup), then:

```bash
cp .env.example .env
```

Fill in `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` in `.env`, then start the dev server:

```bash
npm run dev
```

## Environment variables

| Variable                 | Required        | Description                                                                               |
| ------------------------ | --------------- | ----------------------------------------------------------------------------------------- |
| `VITE_BACKEND`           | No              | Backend adapter: `memory` or `supabase` (default). `rest` is not available yet.           |
| `VITE_SUPABASE_URL`      | With `supabase` | Supabase project URL, for example `https://<project-ref>.supabase.co`.                    |
| `VITE_SUPABASE_ANON_KEY` | With `supabase` | Supabase anon key. It is embedded in the browser bundle by design, so it is not a secret. |

Vite inlines these values at build time, so a change needs a rebuild. `.env.demo` sets `VITE_BACKEND=memory` for `npm run dev:demo`.

## Scripts

| Command             | What it does                                          |
| ------------------- | ----------------------------------------------------- |
| `npm run dev`       | Start the dev server with the backend from `.env`.    |
| `npm run dev:demo`  | Start the dev server with the in-memory demo backend. |
| `npm run build`     | Build for production into `dist/`.                    |
| `npm run preview`   | Serve the production build locally.                   |
| `npm run lint`      | Run ESLint (no warnings allowed) and Prettier check.  |
| `npm run format`    | Format the codebase with Prettier.                    |
| `npm run typecheck` | Type-check with `tsc --noEmit`.                       |
| `npm test`          | Run the Vitest suite.                                 |

## Backend setup

The app needs two things in the Supabase project:

1. The key-value table the edge function stores data in. Only the function, which uses the service role, may touch it:

   ```sql
   create table public.kv_store_81f0b18a (key text primary key, value jsonb not null);
   alter table public.kv_store_81f0b18a enable row level security;
   revoke all on table public.kv_store_81f0b18a from anon, authenticated;
   ```

2. The edge function from `supabase/functions/server/`, deployed under the name `make-server-81f0b18a`, because its routes are prefixed with that name. Either paste `index.tsx` and `kv_store.tsx` into that function in the Supabase dashboard, or add this to `supabase/config.toml` and run `supabase functions deploy make-server-81f0b18a`:

   ```toml
   [functions.make-server-81f0b18a]
   entrypoint = "./functions/server/index.tsx"
   ```

   Do not run `supabase functions deploy server`: it creates a second function and leaves the old one live.

The key-value store keeps prices in dinars. The Supabase adapter converts them to and from millimes exactly, as decimal text, and rejects a stored price it cannot read instead of guessing.

## Roles

A user's role comes from `app_metadata.role`, which only the service role can write: `admin` is an admin and anything else is a cashier. The app ignores `user_metadata`, which users can edit themselves. There is no self-service sign-up in the app.

Promote an admin by user id, after confirming who the account belongs to. Never decide from `raw_user_meta_data`: earlier versions of the app let anyone set a role there.

```sql
-- Find the account
select id, email, created_at, last_sign_in_at from auth.users order by created_at;

-- Promote; check that exactly one row comes back
update auth.users
set raw_app_meta_data = coalesce(raw_app_meta_data, '{}'::jsonb) || '{"role": "admin"}'::jsonb
where id = '<user-id>'
returning id, email, raw_app_meta_data;

-- Demote
update auth.users set raw_app_meta_data = raw_app_meta_data - 'role' where id = '<user-id>';
```

The server applies a role change on the next request; the web app shows it after the user logs out and back in.

### Rolling out the role fix to an existing project

Earlier versions of the edge function trusted `user_metadata.role` and let sign-ups pick their own role. Apply the fix in this order so that real admins keep access and the hole does not stay open:

1. Check that row-level security is on for the key-value table (`select relrowsecurity from pg_class where oid = 'public.kv_store_81f0b18a'::regclass;`). If it is off, run the `alter table` and `revoke` statements from [Backend setup](#backend-setup).
2. Promote the real admins by id. The old function ignores `app_metadata`, so nothing changes yet.
3. Deploy the edge function to `make-server-81f0b18a`.
4. Check that a worker who has set `user_metadata.role` to `admin` gets `403` from `PUT /make-server-81f0b18a/settings`.
5. Find stored prices this version cannot read, and correct them to dinars with at most three decimals. The app reads prices exactly and never rounds, so while one product's price is unreadable the product list does not load, on the POS either. This query lists them:

   ```sql
   select key, value->>'name' as name, value->'price' as price
   from public.kv_store_81f0b18a
   where key like 'product:%'
     and coalesce(value->>'price', '') !~ '^(\d{1,10}([.,]\d{1,3})?|[.,]\d{1,3})$';
   ```

6. Deploy the web app, then have admins log out and back in.
7. Remove the untrusted copies: `update auth.users set raw_user_meta_data = raw_user_meta_data - 'role' where raw_user_meta_data ? 'role';`
8. Delete the `admin@pos.com` and `worker@pos.com` test accounts that earlier versions advertised on the login page, or reset their passwords. Never promote them.

## Known issues

These go away as the app moves off the edge function onto tables with row-level security:

- **The edge function bypasses row-level security.** It runs with the service role key, so any database access rule can be sidestepped through it until the function is deleted from the Supabase project.
- **The function still accepts sign-ups.** Its `/signup` route creates cashier accounts for anyone who calls it directly, and cashiers can record sales.
- **Order endpoints trust the caller.** Item prices and quantities come from the request, so any signed-in user can change order totals and stock.
- **Read endpoints are public.** Products, categories, settings and orders can be fetched with the anon key alone.
- **Recording a sale is two requests.** If the second fails, the order stays open in the key-value store.
- **Legacy categories are matched by name.** Saving a product whose stored category name no longer exists clears its category.

## Credits

UI components come from [shadcn/ui](https://ui.shadcn.com/), used under the [MIT license](https://github.com/shadcn-ui/ui/blob/main/LICENSE.md).
