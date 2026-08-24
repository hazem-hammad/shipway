import { describe, expect, it } from 'vitest';
import { makeRunShell } from '../src/deploy/runshell.js';

describe('makeRunShell', () => {
  it('streams combined stdout+stderr line-by-line to onOutput', async () => {
    const runShell = makeRunShell();
    const lines: string[] = [];

    const result = await runShell('echo out-line; echo err-line 1>&2', {
      cwd: process.cwd(),
      env: {},
      signal: new AbortController().signal,
      onOutput: (line) => lines.push(line),
    });

    expect(result.exitCode).toBe(0);
    expect(lines).toContain('out-line');
    expect(lines).toContain('err-line');
  });

  it('returns a non-zero exitCode without throwing on a failing command', async () => {
    const runShell = makeRunShell();

    const result = await runShell('exit 7', {
      cwd: process.cwd(),
      env: {},
      signal: new AbortController().signal,
      onOutput: () => {
        // no-op
      },
    });

    expect(result.exitCode).toBe(7);
  });

  it('merges opts.env over process.env, visible to the child process', async () => {
    const runShell = makeRunShell();
    const lines: string[] = [];

    const result = await runShell('echo "$SHIPWAY_TEST_VAR"', {
      cwd: process.cwd(),
      env: { SHIPWAY_TEST_VAR: 'hello-from-test' },
      signal: new AbortController().signal,
      onOutput: (line) => lines.push(line),
    });

    expect(result.exitCode).toBe(0);
    expect(lines).toContain('hello-from-test');
  });

  it('flushes a final partial line (no trailing newline) on process exit', async () => {
    const runShell = makeRunShell();
    const lines: string[] = [];

    await runShell('printf "no-newline-at-end"', {
      cwd: process.cwd(),
      env: {},
      signal: new AbortController().signal,
      onOutput: (line) => lines.push(line),
    });

    expect(lines).toContain('no-newline-at-end');
  });

  it('aborting the signal kills the process quickly with a non-zero exit code', async () => {
    const runShell = makeRunShell();
    const controller = new AbortController();

    const promise = runShell('sleep 30', {
      cwd: process.cwd(),
      env: {},
      signal: controller.signal,
      onOutput: () => {
        // no-op
      },
    });

    setTimeout(() => {
      controller.abort();
    }, 50);

    const start = Date.now();
    const result = await promise;
    const elapsed = Date.now() - start;

    expect(result.exitCode).not.toBe(0);
    expect(elapsed).toBeLessThan(5000);
  }, 10000);

  // `killDescendants` sends the abort's SIGTERM to the whole process group: the `sleep` in the loop
  // below (which does NOT trap it) dies on that first SIGTERM, but the `trap '' TERM` shell keeps
  // looping past it regardless — an ignored-SIGTERM child that only `forceKillAfterDelay`'s SIGKILL
  // escalation (5s after the abort, see runshell.ts) can actually stop. If that escalation weren't
  // wired up, this loop — and the test — would hang until vitest's own timeout killed the worker.
  it('force-kills a child that ignores SIGTERM, roughly forceKillAfterDelay (5s) after the abort', async () => {
    const runShell = makeRunShell();
    const controller = new AbortController();

    const promise = runShell('trap "" TERM; while true; do sleep 0.2; done', {
      cwd: process.cwd(),
      env: {},
      signal: controller.signal,
      onOutput: () => {
        // no-op
      },
    });

    setTimeout(() => {
      controller.abort();
    }, 50);

    const start = Date.now();
    const result = await promise;
    const elapsed = Date.now() - start;

    expect(result.exitCode).not.toBe(0);
    // A plain SIGTERM alone would never kill this loop (it's trapped) — only the SIGKILL escalation
    // does, ~5s after the abort. Bounded loosely above and below to absorb scheduler jitter without
    // masking a regression (an escalation that never fires would blow well past the upper bound).
    expect(elapsed).toBeGreaterThan(4500);
    expect(elapsed).toBeLessThan(9000);
  }, 15000);
});
