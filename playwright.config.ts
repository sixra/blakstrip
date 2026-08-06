import process from 'node:process';
import { defineConfig, devices } from '@playwright/test';

// E2E against the real production build (strict CSP + PWA), Chromium only.
export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  // One retry, not two: a test that only passes on the third attempt is flaky, and
  // for a suite whose job is proving redaction that deserves to be seen, not
  // averaged away. The html reporter records which runs were retried.
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  // The export path rasterizes, re-parses and re-rasters the document, so it is
  // the slowest assertion in the suite by a wide margin. Set the budget once here
  // rather than sprinkling magic numbers on individual expects.
  timeout: 60_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL: 'http://localhost:4321',
    trace: 'on-first-retry',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'pnpm build && pnpm preview',
    url: 'http://localhost:4321',
    // Never silently reuse a server: anything already on 4321 (a stray `astro
    // dev`, an older preview) would let the whole suite pass against a build that
    // was never made, including the pre-push hook. Opt in explicitly when
    // iterating locally with PW_REUSE_SERVER=1.
    reuseExistingServer: process.env.PW_REUSE_SERVER === '1',
    timeout: 180_000,
  },
});
