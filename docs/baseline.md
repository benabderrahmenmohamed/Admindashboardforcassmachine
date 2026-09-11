# Baseline

Snapshot of the codebase as exported from Figma Make, before any refactoring. Later phases compare against these numbers.

Captured 2026-09-11 on commit `d3cdb2c` ("Add files from Figma Make") — Windows 11, Node 22.14.0, npm 11.1.0.

## Dependencies

| Metric                                     | Value                                                                                                                 |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| Direct `dependencies`                      | 55                                                                                                                    |
| Direct `devDependencies`                   | 4                                                                                                                     |
| `react` / `react-dom`                      | Not declared as dependencies — only optional `peerDependencies`; installed transitively as peers of Radix, cmdk, etc. |
| Packages added by `npm install`            | 293 (363 entries in the generated `package-lock.json`)                                                                |
| `node_modules` size                        | 188.2 MB                                                                                                              |
| Dependencies reachable from `src/main.tsx` | 14 of 55                                                                                                              |
| `npm audit`                                | 1 high (`vite` ≤ 6.4.2, dev-server advisories); 0 in production dependencies                                          |
| Deprecation warnings                       | `recharts@2.15.2`                                                                                                     |
| Lockfile committed                         | No                                                                                                                    |

## Build

`vite build` (Vite 6.3.5): succeeds in 13.0 s.

| Output                    | Raw           | Gzip      |
| ------------------------- | ------------- | --------- |
| `dist/assets/index-*.js`  | 634,212 B     | 183.92 kB |
| `dist/assets/index-*.css` | 94,025 B      | 15.20 kB  |
| `dist/index.html`         | 461 B         | 0.30 kB   |
| **`dist/` total**         | **728,698 B** |           |

Warnings: one chunk larger than 500 kB after minification. No errors.

`npm run dev`: Vite ready in 758 ms, no warnings; the Login page renders with no console errors.

## Source

| Metric                             | Value                                                                                                             |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `src/app/contexts/AuthContext.tsx` | 3,922 B, 139 lines                                                                                                |
| Largest file ever committed        | `src/app/pages/POS.tsx`, 21.9 KB                                                                                  |
| Files under `src/`                 | 65 — 28 reachable from `src/main.tsx`, 37 unreachable (36 shadcn/ui components and `figma/ImageWithFallback.tsx`) |
| Tests                              | None                                                                                                              |
| Lint / typecheck                   | None — no ESLint, no `tsconfig.json`, `typescript` not installed                                                  |
| `.gitignore`                       | None                                                                                                              |

## Lighthouse

Lighthouse 12.8.2 run through `npx` (not a project dependency), HeadlessChrome 152, against `vite preview` serving `dist/`. Only the unauthenticated Login page (`/`) can be measured: every other route needs a logged-in session against the remote Supabase project.

| Preset           | Performance | Accessibility | Best practices | SEO | FCP   | LCP   | TBT   | CLS |
| ---------------- | ----------- | ------------- | -------------- | --- | ----- | ----- | ----- | --- |
| Mobile (default) | 98          | 100           | 96             | 82  | 2.0 s | 2.0 s | 50 ms | 0   |
| Desktop          | 100         | 100           | 96             | 82  | 0.4 s | 0.5 s | 0 ms  | 0   |

Failing audits: `errors-in-console` (`/favicon.ico` returns 404), `meta-description`, `robots-txt`. Estimated unused JavaScript: 114 KiB. Total transfer size: 196 KiB.

## Reproduce

```bash
npm install
npm run build
npx vite preview --port 4173
npx lighthouse@12.8.2 http://localhost:4173/ --only-categories=performance,accessibility,best-practices,seo
npx lighthouse@12.8.2 http://localhost:4173/ --preset=desktop --only-categories=performance,accessibility,best-practices,seo
```
