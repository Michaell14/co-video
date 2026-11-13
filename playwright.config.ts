import { defineConfig } from '@playwright/test';
import { CHROMIUM_ARGS, REPORTERS, dataDirectory } from './e2e/run';

/**
 * End-to-end tests drive the real editor, the real collaboration server and the real render engine
 * in Chromium. WebGL runs on SwiftShader so the suite works on machines (and CI) without a GPU.
 *
 * Other ports give a run its own pair of servers beside ones that are already up, for example to
 * test a changed server while a dev server keeps running.
 */
const EDITOR_PORT = Number(process.env.TANDEM_E2E_EDITOR_PORT ?? 5273);
const SERVER_PORT = Number(process.env.TANDEM_E2E_SERVER_PORT ?? 8797);

export default defineConfig({
  testDir: 'e2e',
  // The production build has a configuration of its own: playwright.smoke.config.ts.
  testIgnore: '**/smoke/**',
  timeout: 120_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: REPORTERS,
  use: {
    baseURL: `http://localhost:${EDITOR_PORT}`,
    viewport: { width: 1440, height: 900 },
    acceptDownloads: true,
    // Every attempt is recorded and the recording is kept only when the attempt failed, so the
    // first failure of a test that passes when retried leaves a trace too.
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    launchOptions: { args: CHROMIUM_ARGS },
  },
  webServer: [
    {
      command: 'pnpm --filter @tandem/server exec tsx src/index.ts',
      // The suite creates far more projects from one address than a person would in an hour.
      env: {
        PORT: String(SERVER_PORT),
        DATA_DIR: dataDirectory(),
        HOST: '127.0.0.1',
        MAX_CREATES_PER_HOUR: '100000',
      },
      url: `http://localhost:${SERVER_PORT}/api/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
    {
      command: `pnpm --filter @tandem/editor exec vite --port ${EDITOR_PORT} --strictPort`,
      env: { TANDEM_SERVER: `http://localhost:${SERVER_PORT}` },
      url: `http://localhost:${EDITOR_PORT}/lab.html`,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
  ],
});
