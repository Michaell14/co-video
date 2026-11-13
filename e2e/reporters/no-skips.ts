import type { FullResult, Reporter, TestCase, TestResult } from '@playwright/test/reporter';

/**
 * Turns a run in which a test skipped itself into a failed run.
 *
 * Tests skip when what they need is not there: a collaboration server that takes new projects,
 * `ffprobe`. That is right on a contributor's machine and wrong where everything is provided: a
 * server that stopped answering half way through the suite would otherwise show as a green run
 * with fewer tests in it.
 */
export default class NoSkips implements Reporter {
  private readonly skipped = new Map<TestCase, string>();

  onTestEnd(test: TestCase, result: TestResult): void {
    if (result.status !== 'skipped') return;
    const why = test.annotations.find((a) => a.type === 'skip' || a.type === 'fixme')?.description;
    this.skipped.set(test, why ?? 'no reason given');
  }

  async onEnd(result: FullResult): Promise<{ status: FullResult['status'] } | undefined> {
    // A run that was stopped leaves the tests it never reached as skipped: that is not what this is about.
    if (!this.skipped.size || result.status === 'interrupted') return undefined;
    console.error(`\n${this.skipped.size} skipped, and nothing may skip in this run:`);
    for (const [test, why] of this.skipped) {
      console.error(`  ${test.titlePath().slice(2).join(' › ')}  (${why})`);
    }
    return { status: 'failed' };
  }

  // The lines above come once, at the end; the reporters that show progress keep the terminal.
  printsToStdio(): boolean {
    return false;
  }
}
