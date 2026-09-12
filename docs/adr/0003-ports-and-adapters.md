# 3. The UI reaches a backend only through ports

**Status:** Accepted. Ports and the memory and Supabase adapters landed in Phase 2 (`1758053`); the error
contract and the shared contract suite in Phase 3 (`ecc42fe`); the REST adapter in Phase 5 (`2a9a438`).

## Context

The export called Supabase from inside its pages — an edge function over a key-value store, reached with the
project's client. Three things followed from that: a page could not be tested without a network, there was no
way to show the app to anyone without credentials, and there was nowhere to put the Spring Boot service the
project is meant to move to.

## Decision

**Ports.** `src/ports` holds `AuthPort`, `CatalogPort`, `SalesPort`, `SessionsPort`, `SettingsPort` and
`TerminalsPort`, gathered as `Backend` in `src/ports/index.ts`. Their types are Zod schemas, so an adapter
parses what it returns rather than asserting it.

**One error vocabulary.** Every failure crossing a port is an `AppError` carrying one of the fourteen codes in
`src/lib/errors.ts`, documented in [contracts/errors.md](../../contracts/errors.md). Callers decide from the
code alone, never the message. `errorClass` maps each code to `retriable`, `auth` or `conflict`, which is
exactly what the outbox acts on (ADR 0005).

**Three adapters.**

| Adapter                 | What is behind it                                                       |
| ----------------------- | ----------------------------------------------------------------------- |
| `src/adapters/memory`   | The reference implementation: the credential-free demo and most tests.  |
| `src/adapters/supabase` | Tables with row-level security and `security definer` RPCs.             |
| `src/adapters/rest`     | The HTTP API of [contracts/openapi.yaml](../../contracts/openapi.yaml). |

**Composition root.** `src/lib/backend.ts` is the only module that names an adapter. It reads `backendKind()`
from `VITE_BACKEND` and `await import()`s one, so a build downloads only the backend it runs on.
`src/lib/backend-context.tsx` hands the result to the tree and features reach it through `useBackend`.

**One contract suite for all three.** `src/ports/__contracts__` exports `describeBackendContract(makeFixture)`,
which runs the auth, catalog, terminals, sessions and sales suites. Each adapter runs it unchanged —
`src/adapters/memory/contract.test.ts`, `src/adapters/supabase/contract.test.ts`,
`src/adapters/rest/contract.test.ts`. The suite builds its records with the register's own builders
(`buildSaleRecord`, `buildRefundRecord`, `buildOpenSessionRecord`), so it sends the payloads the app actually
writes. Its header states the rule: the database defines the semantics, and each adapter must pass the suite
unchanged.

**Lint enforces the arrangement.** `eslint.config.js`:

- Everything under `src/` except `src/adapters/**` and `src/lib/backend.ts` may not import `@/adapters/**`,
  `@supabase/*`, or `supabaseEnv` from `@/lib/env`. `no-restricted-syntax` adds what static import rules miss:
  `import()` of an adapter, and `import.meta.glob`.
- `src/app`, `src/components`, `src/features` and `src/routes` have `fetch`, `XMLHttpRequest`, `WebSocket` and
  `EventSource` as restricted globals: screens make no requests of their own.
- Adapters never import each other; what they share lives in `src/lib` or `src/ports`.
- `src/lib/money.ts` and `src/features/pos/cart.ts` additionally may not import React, the router, TanStack,
  the backend modules or `@/lib/env`, and may not call `new Date()`, `Date.now`, `Math.random`,
  `crypto.randomUUID` or `crypto.getRandomValues`, or touch `localStorage`, `sessionStorage` or `indexedDB`.

### What was revised

**The memory adapter gained real checks.** In Phase 2 it had `authorize(store, ['admin'])`, which read the
role off the signed-in session — enough for a demo to behave plausibly. Phase 3 replaced it with
`requireProfile(context, allowed)` in `src/adapters/memory/support.ts`, which reads role and shop from
`store.profiles` exactly as `private.require_profile()` does, and raises `FORBIDDEN` for an account with no
profile rather than letting it through. `src/adapters/memory/ledger.ts` went further and named its helpers
after the database's: `terminalFor` for `private.lock_terminal`, `requireEpoch`, `requireMember`,
`requireNextSeq`, `sessionView` for `private.session_json`, `zReportOf` for `private.compute_z_report`.

It had to change because the same suite now runs against both: the memory backend has to refuse what the
database refuses, with the same code and the same `details` keys. That is what makes it a reference
implementation instead of a stub.

## Consequences

- Three implementations of every behaviour. A new port method is three adapters plus a case in the suite.
- The credential-free demo and the Playwright offline spec are possible at all, because the memory backend is
  a real backend with faults and connectivity (`createFaultInjector`, `defaultConnectivity`).
- Cost: the contract suite is the slowest part of the test run, and two of its three runs need something
  outside the process — a local Supabase stack (`CONTRACT_BACKEND=supabase`) or MSW. CI runs the Supabase one
  only on pull requests to `main`.
- Cost: the boundaries are lint, not types. A file with an eslint-disable can still import an adapter.
- The REST adapter is proven against `src/adapters/rest/fakeApi.ts` — MSW serving the OpenAPI shapes over the
  memory ledger — not against a real service. As its own test header says, what that proves is the adapter and
  the wire format: paths, bearer token, snake_case out and camelCase in, 201 against 200, and every error code
  read back from the envelope.

## Alternatives rejected

- **Call Supabase from hooks and mock it in tests.** A mock drifts from the database and cannot be run against
  it; a credential-free demo would then be a second mock, drifting separately.
- **One `ApiClient` interface instead of six ports.** Sales, sessions and the catalog have different shapes
  and different callers. Six small ports keep a test fixture small.
- **A folder convention with no lint rules.** A single `import { supabase }` in a component silently undoes the
  arrangement; Phase 2 added the rules for that reason.
- **Generated clients as the port type.** The port types are what the UI wants to work with.
  `src/adapters/rest/api.types.ts` is generated from the OpenAPI document and stays inside the adapter, behind
  `keysToCamel` and a port schema.
