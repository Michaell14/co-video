import { defineConfig } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * End-to-end tests drive the real editor, the real collaboration server and the real render engine
 * in Chromium. WebGL runs on SwiftShader so the suite works on machines (and CI) without a GPU.
 */

// The server's data directory. This file is loaded by the runner and again by every worker, which
// inherits the runner's environment: only the runner finds the variable unset, so a run makes one
// directory, and the process that made it removes it when the servers have been stopped.
if (!process.env.TANDEM_E2E_DATA) {
  const made = mkdtempSync(join(tmpdir(), 'tandem-e2e-'));
  process.env.TANDEM_E2E_DATA = made;
  process.on('exit', () => {
    try {
      rmSync(made, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      // A directory that is still in use must not turn a finished run into a failed one.
    }
  });
}
// Other ports give a run its own pair of servers beside ones that are already up, for example to
// test a changed server while a dev server keeps running.
const EDITOR_PORT = Number(process.env.TANDEM_E2E_EDITOR_PORT ?? 5273);
const SERVER_PORT = Number(process.env.TANDEM_E2E_SERVER_PORT ?? 8797);

export default defineConfig({
  testDir: 'e2e',
  // The production build has its own configuration: playwright.smoke.config.ts.
  testIgnore: 'smoke/**',
  timeout: 120_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  // On CI every test has what it needs (a server that takes projects, ffprobe), so a test that
  // skips itself there is a failure nobody would otherwise see.
  reporter: process.env.CI ? [['github'], ['list'], ['./e2e/reporters/no-skips.ts']] : 'list',
  use: {
    baseURL: `http://localhost:${EDITOR_PORT}`,
    viewport: { width: 1440, height: 900 },
    acceptDownloads: true,
    // Kept for the attempts that failed only, the first attempt of a flaky test included.
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    launchOptions: {
      args: [
        '--enable-unsafe-swiftshader',
        '--use-angle=swiftshader',
        '--autoplay-policy=no-user-gesture-required',
        '--use-fake-device-for-media-stream',
        '--use-fake-ui-for-media-stream',
      ],
    },
  },
  webServer: [
    {
      command: 'pnpm --filter @tandem/server exec tsx src/index.ts',
      // The suite creates far more projects from one address than a person would in an hour.
      env: {
        PORT: String(SERVER_PORT),
        DATA_DIR: process.env.TANDEM_E2E_DATA,
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
