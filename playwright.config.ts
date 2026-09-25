import { defineConfig, devices, type PlaywrightTestConfig } from '@playwright/test';

/**
 * Two end-to-end specs, each against its own dev server:
 *
 * - `memory`: the credential-free demo on one device (`VITE_BACKEND=memory`). No credentials, no
 *   server and nothing to reset between runs: the backend lives in the tab and starts empty with it.
 *   It always runs.
 * - `supabase` and `rest`: the waiter's phone, the kitchen screen and the counter as three devices
 *   against a server — the same spec either way (`cafe-live.spec.ts`), because which server it is
 *   is not the spec's business. `E2E_BACKEND=supabase` runs it on a local Supabase stack, with
 *   `SUPABASE_URL` and `SUPABASE_ANON_KEY` read from `supabase status` — the same variables the
 *   contract suite reads. `E2E_BACKEND=rest` runs it on the Symfony service in api/, at
 *   `API_BASE_URL`, http://127.0.0.1:8000 unless it is set.
 */
const MEMORY_PORT = 5174;
const SUPABASE_PORT = 5175;
const REST_PORT = 5176;

type Project = NonNullable<PlaywrightTestConfig['projects']>[number];
type WebServer = Extract<
  NonNullable<PlaywrightTestConfig['webServer']>,
  readonly unknown[]
>[number];

// The Chrome that is already on the machine: `npx playwright install` downloads nothing.
const chrome = { ...devices['Desktop Chrome'], channel: 'chrome' } as const;

const projects: Project[] = [
  {
    name: 'memory',
    testMatch: 'cafe-memory.spec.ts',
    use: { ...chrome, baseURL: `http://localhost:${MEMORY_PORT}` },
  },
];
const webServer: WebServer[] = [
  {
    command: `npm run dev:demo -- --port ${MEMORY_PORT} --strictPort`,
    url: `http://localhost:${MEMORY_PORT}`,
    // .env.demo sets it too; named here so the run is right whatever the shell holds.
    env: { VITE_BACKEND: 'memory' },
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
];

if (process.env.E2E_BACKEND === 'supabase') {
  const url = process.env.SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    throw new Error(
      'E2E_BACKEND=supabase needs SUPABASE_URL and SUPABASE_ANON_KEY of the local stack (supabase status).',
    );
  }
  projects.push({
    name: 'supabase',
    testMatch: 'cafe-live.spec.ts',
    use: { ...chrome, baseURL: `http://localhost:${SUPABASE_PORT}` },
  });
  webServer.push({
    // The default mode, so `.env` is read too; the variables here win over it.
    command: `npm run dev -- --port ${SUPABASE_PORT} --strictPort`,
    url: `http://localhost:${SUPABASE_PORT}`,
    env: { VITE_BACKEND: 'supabase', VITE_SUPABASE_URL: url, VITE_SUPABASE_ANON_KEY: anonKey },
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    stdout: 'pipe',
    stderr: 'pipe',
  });
}

if (process.env.E2E_BACKEND === 'rest') {
  const baseUrl = process.env.API_BASE_URL ?? 'http://127.0.0.1:8000';
  projects.push({
    name: 'rest',
    testMatch: 'cafe-live.spec.ts',
    use: { ...chrome, baseURL: `http://localhost:${REST_PORT}` },
  });
  webServer.push({
    // The default mode, so `.env` is read too; the variables here win over it.
    command: `npm run dev -- --port ${REST_PORT} --strictPort`,
    url: `http://localhost:${REST_PORT}`,
    env: { VITE_BACKEND: 'rest', VITE_API_BASE_URL: baseUrl },
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    stdout: 'pipe',
    stderr: 'pipe',
  });
}

export default defineConfig({
  testDir: './e2e',
  // One device at a time: the specs read the sync chip while a drain pass is running, which a shared
  // machine under load would make flaky.
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  // One retry, so a first failure always leaves a trace behind to read.
  retries: 1,
  timeout: 120_000,
  expect: { timeout: 10_000 },
  reporter: [['list'], ['html', { outputFolder: 'playwright-report', open: 'never' }]],
  use: {
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'off',
  },
  projects,
  webServer,
});
