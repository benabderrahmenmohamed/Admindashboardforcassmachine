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
php bin/phpunit                               # the tests
php -S 127.0.0.1:8000 -t public               # the server
```

`DATABASE_URL` lives in `.env` for local work and is overridden by `.env.local` or a real environment
variable anywhere else. `.env.test` points at `cafe_test`, which the tests are free to empty.

## How the app reaches it

```bash
VITE_BACKEND=rest VITE_API_BASE_URL=http://127.0.0.1:8000 npm run dev
```

Nothing in the screens changes: the app reaches every backend through the same ports, and this one
answers the REST contract.
