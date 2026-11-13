/** What the Playwright configurations share: how Chromium is started, where a server keeps its data, who reports. */
import type { ReporterDescription } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** WebGL on SwiftShader, so a run needs no GPU; sound and a microphone without a device or a prompt. */
export const CHROMIUM_ARGS = [
  '--enable-unsafe-swiftshader',
  '--use-angle=swiftshader',
  '--autoplay-policy=no-user-gesture-required',
  '--use-fake-device-for-media-stream',
  '--use-fake-ui-for-media-stream',
];

/**
 * The data directory of the server a run starts: `TANDEM_E2E_DATA`, or a temporary one.
 *
 * A configuration file is loaded by the runner and again by every worker, and a worker inherits
 * the runner's environment. Only the runner finds the variable unset, so a run makes one
 * directory, and the process that made it removes it on its way out, when the server has stopped.
 */
export function dataDirectory(): string {
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
  return process.env.TANDEM_E2E_DATA;
}

/**
 * On CI every test has what it needs (a server that takes projects, `ffprobe`), so a test that
 * skips itself there is a failure nobody would otherwise see.
 */
export const REPORTERS: ReporterDescription[] | 'list' = process.env.CI
  ? [['github'], ['list'], ['./e2e/reporters/no-skips.ts']]
  : 'list';
