/**
 * Real `PipelineDeps['runShell']` implementation: runs `cmd` through `bash -c` via execa,
 * streaming combined stdout+stderr to `onOutput` line-by-line (partial, not-yet-newline-terminated
 * output is buffered and flushed once the process exits), with `opts.env` merged over the current
 * process environment.
 *
 * Never throws: `reject: false` makes execa resolve (rather than reject) on a non-zero exit *and*
 * on cancellation via `opts.signal` (wired to execa's `cancelSignal`, which sends `SIGTERM`).
 * `killDescendants: true` spawns the process in its own process group and kills the whole group on
 * termination, so an aborted `bash -c "some && pipeline"` can't leave orphaned children running.
 * `forceKillAfterDelay: 5000` escalates to `SIGKILL` if the group hasn't exited 5s after that
 * `SIGTERM` — a script that traps/ignores `SIGTERM` (or a wedged child) no longer hangs a cancel
 * indefinitely. Since a signal-killed process reports `exitCode: undefined` (no numeric exit code —
 * see execa's `ExecaResult` type), that case is mapped to a synthetic non-zero code so callers
 * always get a number, matching `PipelineDeps['runShell']`'s `{exitCode: number}` return type.
 */
import { execa } from 'execa';

type RunShell = (
  cmd: string,
  opts: { cwd: string; env: Record<string, string>; signal: AbortSignal; onOutput: (s: string) => void },
) => Promise<{ exitCode: number }>;

/** Synthetic exit code reported when the process was terminated by a signal (no real exit code). */
const SIGNAL_KILLED_EXIT_CODE = 1;

export function makeRunShell(): RunShell {
  return async (cmd, opts) => {
    let buffer = '';

    const onChunk = (chunk: Buffer): void => {
      buffer += chunk.toString('utf8');
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        opts.onOutput(line);
      }
    };

    const subprocess = execa('bash', ['-c', cmd], {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      cancelSignal: opts.signal,
      all: true,
      reject: false,
      killDescendants: true,
      forceKillAfterDelay: 5000,
    });

    subprocess.all?.on('data', onChunk);

    const result = await subprocess;

    if (buffer.length > 0) {
      opts.onOutput(buffer);
    }

    return { exitCode: result.exitCode ?? SIGNAL_KILLED_EXIT_CODE };
  };
}
