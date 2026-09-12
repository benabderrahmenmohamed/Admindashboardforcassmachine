import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end run of the demo: `VITE_BACKEND=memory`, so there are no credentials, no server and
 * nothing to reset between runs — the backend lives in the tab and starts empty with it.
 */
const PORT = 5174;
const BASE_URL = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: './e2e',
  // One register at a time: each test drives a device that numbers receipts, and the specs read the
  // sync chip while a drain pass is running, which a shared machine under load would make flaky.
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  // One retry, so a first failure always leaves a trace behind to read.
  retries: 1,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [['list'], ['html', { outputFolder: 'playwright-report', open: 'never' }]],
  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'off',
  },
  projects: [
    {
      // The Chrome that is already on the machine: `npx playwright install` downloads nothing.
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], channel: 'chrome' },
    },
  ],
  webServer: {
    command: `npm run dev:demo -- --port ${PORT} --strictPort`,
    url: BASE_URL,
    // .env.demo sets it too; named here so the run is right whatever the shell holds.
    env: { VITE_BACKEND: 'memory' },
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
