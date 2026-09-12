# 1. Feature folders over the generated page-and-context layout

**Status:** Accepted. Landed in Phase 2 (`1758053`, "structure, ports and adapters, integer money").

## Context

The Figma Make export (`d3cdb2c`, measured in [docs/baseline.md](../baseline.md)) put a screen in one file
under `src/app/pages/`: `POS.tsx` was 648 lines and 21.9 KB, `Products.tsx` 424, `Categories.tsx` 266,
`Settings.tsx` 252, `Login.tsx` 171. `src/app/contexts/AuthContext.tsx` (139 lines) held the session, the
role and the calls that fetched data. `src/app/routes.tsx` wired them together.

Each page fetched its own data, did its own money arithmetic in floats, and built its own dialogs. Of 65
files under `src/`, 37 were unreachable from `src/main.tsx`. There were no tests, no `tsconfig.json` and no
ESLint, so nothing said what belonged where. A file that size has no seam to test through: to check that a
cart adds up, you had to render the POS screen and a backend with it.

## Decision

Group by feature, and keep the parts of a feature that need no DOM out of its components.

```
src/features/<feature>/
  components/   React: screens, dialogs, cards
  hooks/        TanStack Query hooks and other React state
  types.ts      the port types this feature uses
  *.ts          the feature's rules: plain modules, no React
src/ports/      the interfaces the UI may call (ADR 0003)
src/adapters/   the implementations: memory, supabase, rest
src/lib/        cross-feature helpers: money, errors, payloadHash, env, query, backend
src/routes/     router.tsx, ProtectedRoute, the two layouts
src/components/ui/  shared shadcn/ui components
```

The ten features are `auth`, `categories`, `dashboard`, `pos`, `products`, `sales`, `sessions`, `settings`,
`sync` and `terminal`. The rules of a feature sit at its root as ordinary modules and are unit-tested
directly: `src/features/pos/cart.ts`, `gate.ts`, `queue.ts`, `recording.ts`, `selling.ts`,
`src/features/sales/records.ts`, `src/features/sessions/zReport.ts`, `src/features/sync/outbox.ts`. Each one
says in its header that it runs without a DOM.

Routing moved out of the features: `src/routes/router.tsx` composes the routes and wraps them in
`ProtectedRoute`, which is where `allow={['admin']}` and `allow={['cashier']}` live.

## Consequences

- A screen's rules are testable without rendering it. `cart.test.ts`, `gate.test.ts`, `queue.test.ts`,
  `zReport.test.ts` and `outbox.test.ts` run in the node environment.
- The POS is now eighteen source modules under `src/features/pos` where it was one file. That is more files
  to open and more imports to follow, and the cost is real for a small change.
- Features import each other: `src/features/pos/queue.ts` pulls from `@/features/sessions/zReport` and
  `@/features/sync/types`. Nothing enforces a dependency direction between features — the only boundaries
  ESLint checks are ports/adapters and the purity of `src/lib/money.ts` and `src/features/pos/cart.ts`
  (ADR 0003). Feature coupling is a review question, not a build error.
- `src/features/*/types.ts` is mostly a re-export of port types. It is a second thin layer to keep in step
  with `src/ports`.
- `src/components/ui` stays global, so a feature folder is not self-contained: it owns its screens, not the
  buttons in them.

## Alternatives rejected

- **Keep pages and contexts.** The export's own shape is what made it untestable: `AuthContext` mixed session,
  role and data access, `POS.tsx` did cart arithmetic and reached the backend, and there was nowhere to put a
  second backend. Phases 3 to 5 each added a concern (a ledger, a queue, a third adapter) that would have
  landed inside those same files.
- **Layer folders (`components/`, `hooks/`, `pages/`, `services/`).** A change to selling would touch four
  folders, and nothing in the tree says which files belong to one another.
- **A package per feature, in an npm workspace.** One app, one build, one deployment. The tooling would buy
  nothing today, and the boundaries it enforces are already enforced by lint where they matter.
- **Feature folders with no ports layer.** Rejected for the reasons in ADR 0003: without ports there is no
  credential-free demo, no contract suite and no place for a second backend.
