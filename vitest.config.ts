import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

/**
 * Two projects, because the suite has two kinds of test:
 *
 * - `node`: the ports, the adapters and every domain module. They touch no DOM, so they run in the
 *   node environment, where a missing browser API is a real failure rather than a jsdom fallback.
 * - `jsdom`: the screens (`*.test.tsx`), rendered with Testing Library against the in-memory
 *   backend. `VITE_BACKEND=memory` makes `createBackend()` — the app's own composition root —
 *   build that backend, so the tests reach it the way the app does instead of importing an adapter.
 *
 * The include patterns name `src` on purpose: nothing outside it is a Vitest suite, and Playwright
 * specs under `e2e/` must not be collected here.
 */

/** Mirrors the alias in vite.config.ts and the `paths` in tsconfig.json. */
const alias = { '@': '/src' };

export default defineConfig({
  resolve: { alias },
  test: {
    projects: [
      {
        resolve: { alias },
        test: {
          name: 'node',
          environment: 'node',
          include: ['src/**/*.test.ts'],
          // Runs before the jsdom project rather than beside it: spinning up a DOM per screen file
          // is heavy, and the node suite has property tests that measure themselves against the
          // default 5 s timeout. One group after the other keeps both honest on a busy machine.
          sequence: { groupOrder: 0 },
        },
      },
      {
        // JSX is the only thing the screens need from Vite here; the app's CSS never loads.
        plugins: [react()],
        resolve: { alias },
        test: {
          name: 'jsdom',
          environment: 'jsdom',
          include: ['src/**/*.test.tsx'],
          setupFiles: ['src/test/setup.ts'],
          env: { VITE_BACKEND: 'memory' },
          sequence: { groupOrder: 1 },
        },
      },
    ],
  },
});
