# 9. The server is Symfony over the same Postgres schema

**Status:** Accepted. Built in `api/` across six phases on the `symfony` branch: the schema and its guard,
signing in and the menu, the room, the money, then the app's own suites run against it.

## Context

The app was written against ports (ADR 0003) with three adapters behind them: the in-memory one the demo and
most tests run on, a Supabase one, and a REST one written against
[`contracts/openapi.yaml`](../../contracts/openapi.yaml) for a service that did not exist yet. Supabase was
doing three jobs at once — Postgres, an HTTP API generated from the schema, and sign-in — and the REST
adapter's tests proved the adapter against a fake of the contract rather than against a server.

The question was what to write that service in, and how much of what Supabase was doing should move into it.
The answer matters most where the money is: receipt numbering with no gaps, an append-only ledger, refunds
bounded by what is left on a line, and row-level security that keeps one café out of another's rows. All of
that is in the database already, in SQL, with pgTAP tests over it.

## Decision

**Symfony 7 with Doctrine DBAL, over the same schema, unchanged.** `api/migrations/sql/0001_schema.sql` is
the sixteen Supabase migrations replayed in order by a script that makes exactly three substitutions:
`auth.users` becomes `public.users` (this server hashes the passwords), `auth.uid()` becomes
`private.current_user_id()` reading a `app.user_id` setting, and Supabase's three API roles become one role,
`cafe_app`. Every table, policy, trigger and function is otherwise the same text. What was left behind is
what belonged to Supabase: the key-value import of the old app, the nightly demo reset and the Realtime
publication.

**The rules stay in the database; the server carries records to them.** A controller does not check a role,
recompute a total or decide whether a record is a replay. It hands the payload to `record_sale`,
`order_item_add`, `open_session` — as the device wrote it, because the payload hash was taken over those keys
— and turns what comes back into the contract's status. Row-level security does the rest: every request runs
on a connection told who it is for, and reads only that café's rows.

**Two connections, on purpose.** Requests use `cafe_app`, which the policies apply to and which cannot write
the ledger by hand. Migrations and fixtures use the owner. A request path that could bypass the policies
would make them decoration.

**Doctrine's ORM is not used for the café.** There are no entities and no repositories: the schema is the
authority and the queries are SQL. Each read is one query that shapes the contract's JSON in Postgres, so a
board or a receipt arrives whole instead of as rows a controller stitches back together.

**Polling replaces Realtime.** Supabase pushed the names of the changed tables down a websocket; this server
holds no connections. `private.shop_changes` is stamped by triggers and `GET /open-orders?since=` answers the
names since a cursor — which is what that endpoint in the contract always was, and what the REST adapter
already did.

**The proof is the app's own suites.** The port contract suite (60 tests) and the three-device Playwright
spec run against the running server, unchanged, next to the Supabase runs of the same files.

## Consequences

- The app gained a backend it owns end to end: one process, one database, no vendor in the request path.
- The two backends stay interchangeable because they run the same schema and the same tests. A café can be
  moved from Supabase to this server by pointing it at a dump.
- Every timestamp on the wire is rendered in one place, because Postgres writes `+00:00` where every client
  of this contract writes `Z`.
- Cost: a PHP server and a Postgres are two things to run where Supabase was one, and sign-in, tokens and
  CORS are now this codebase's to get right.
- Cost: live updates are a poll. A screen learns what changed within a couple of seconds instead of
  immediately, and the server answers a small query per device per poll.
- Cost: the schema now has two homes — `supabase/migrations` and the file generated from it. The generator
  is committed and has to be re-run when they must stay in step.

## Alternatives rejected

- **Doctrine entities and a service layer.** The rules would have to be written a second time in PHP, and
  the second copy would be the one that drifts. The functions and the policies are already tested by pgTAP
  and are what the Supabase backend uses.
- **A thin proxy in front of PostgREST.** That keeps the generated API this was meant to replace, and adds a
  hop.
- **Symfony's security voters for roles.** A café's roles are rows in `profiles`, read by the policies on
  every statement. Checking them again in PHP would be a second opinion on the same question, and the two
  would drift.
- **A new schema written for Doctrine.** Everything the money depends on would be rewritten, and the pgTAP
  suite that holds it would be thrown away with it.
