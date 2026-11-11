import { defineConfig } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * End-to-end tests drive the real editor, the real collaboration server and the real render engine
 * in Chromium. WebGL runs on SwiftShader so the suite works on machines (and CI) without a GPU.
 */
const dataDir = process.env.TANDEM_E2E_DATA ?? mkdtempSync(join(tmpdir(), 'tandem-e2e-'));
const EDITOR_PORT = 5273;
const SERVER_PORT = 8797;

export default defineConfig({
  testDir: 'e2e',
  timeout: 120_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  use: {
    baseURL: `http://localhost:${EDITOR_PORT}`,
    viewport: { width: 1440, height: 900 },
    acceptDownloads: true,
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
        DATA_DIR: dataDir,
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
