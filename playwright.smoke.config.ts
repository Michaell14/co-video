import { defineConfig } from '@playwright/test';
import { CHROMIUM_ARGS, REPORTERS, dataDirectory } from './e2e/run';

/**
 * The production build in a browser: what `pnpm build` wrote, served by the built server the way a
 * deployment serves it. The editor is under `/app/`, its code is bundled and hashed, the service
 * worker is registered and the pages carry their Content-Security-Policy. None of that is true of
 * the dev server the rest of the suite runs on.
 *
 * `pnpm test:smoke` builds first. The server is always started here, never reused: the test is
 * about the build that was just made.
 */
const PORT = Number(process.env.TANDEM_SMOKE_PORT ?? 8798);

export default defineConfig({
  testDir: 'e2e/smoke',
  outputDir: 'test-results/smoke',
  timeout: 180_000,
  expect: { timeout: 20_000 },
  workers: 1,
  retries: 0,
  reporter: REPORTERS,
  use: {
    baseURL: `http://localhost:${PORT}`,
    viewport: { width: 1440, height: 900 },
    acceptDownloads: true,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    launchOptions: { args: CHROMIUM_ARGS },
  },
  webServer: {
    command: 'node apps/server/dist/server.js',
    env: { PORT: String(PORT), DATA_DIR: dataDirectory(), HOST: '127.0.0.1' },
    url: `http://localhost:${PORT}/api/health`,
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
