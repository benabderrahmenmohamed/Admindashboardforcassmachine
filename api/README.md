# api — the Symfony server

The café's backend, written against [`../contracts/openapi.yaml`](../contracts/openapi.yaml): the same
28 endpoints the REST adapter of the app already calls. The screens stay as they are — they are the
part that keeps working with no network — and this server replaces Supabase behind them.

## What it needs

- PHP 8.2 or newer with `pdo_pgsql`, `pgsql`, `intl`, `zip` and `sodium`
- Composer 2
- PostgreSQL 17

## How this machine is set up

Docker does not start here, so PostgreSQL runs from the binaries EnterpriseDB publishes, with no
installer and no Windows service:

| Thing | Where |
| --- | --- |
| PHP | `C:\xampp\php` (the extensions above were switched on in `php.ini`; the old file is kept as `php.ini.bak-20260925`) |
| Postgres programs | `C:\Users\shini\pgsql\bin` |
| Its data | `C:\Users\shini\pgdata` |
| Address | `127.0.0.1:5433`, user `postgres`, password `postgres` |
| Databases | `cafe` for development, `cafe_test` for the tests |

Start and stop the database:

```bash
C:/Users/shini/pgsql/bin/pg_ctl.exe -D C:/Users/shini/pgdata -o "-p 5433" -l C:/Users/shini/pgdata/server.log start
C:/Users/shini/pgsql/bin/pg_ctl.exe -D C:/Users/shini/pgdata stop
```

## Commands

```bash
composer install
php bin/console doctrine:migrations:migrate   # the schema
php bin/console app:seed-demo                 # the demo café, its members and its menu
php bin/phpunit                               # the tests
php -S 127.0.0.1:8000 -t public               # the server
```

## Two roles, on purpose

| Connection | Role | For |
| --- | --- | --- |
| `default` (`DATABASE_URL`) | `cafe_app` | every request; row-level security applies to it |
| `admin` (`DATABASE_ADMIN_URL`) | the owner | migrations and fixtures, nothing else |

A request tells the database who it is for with `set_config('app.user_id', …)`, and the policies do
the rest: a member reads their own café and no other, and nobody writes the ledger by hand — not even
this API, which records a sale by calling `record_sale`. `tests/Database/RowLevelSecurityTest.php`
holds those promises down.

## Where the schema comes from

`migrations/sql/0001_schema.sql` is the café's schema in one file, derived from the 16 Supabase
migrations by `migrations/sql/build_from_supabase.py`, which replays them in order and changes three
things: `auth.users` becomes `public.users`, `auth.uid()` becomes `private.current_user_id()` reading
`app.user_id`, and Supabase's three API roles become the single `cafe_app`. The key-value import of
the old app, the nightly demo reset and the Realtime publication are left behind. Run the script
again after changing anything under `supabase/migrations` if both backends must stay in step.

`DATABASE_URL` lives in `.env` for local work and is overridden by `.env.local` or a real environment
variable anywhere else. `.env.test` points at `cafe_test`, which the tests are free to empty.

## How the app reaches it

```bash
VITE_BACKEND=rest VITE_API_BASE_URL=http://127.0.0.1:8000 npm run dev
```

Nothing in the screens changes: the app reaches every backend through the same ports, and this one
answers the REST contract.
