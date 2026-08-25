/**
 * Marks a rejection as *caused by* an in-flight `AbortSignal` firing (a deploy cancel), as opposed
 * to a genuine, unrelated failure that merely happens to land while that same signal is aborted.
 *
 * The distinction matters at `deploy/pipeline.ts`'s post-activate catch: once `activate` has run,
 * code may already be live, so `restartRuntime`/`restartWorkers`/the health check all run for real
 * — and any of them can fail on their own merits (a broken systemd unit in the new release, a
 * genuinely unhealthy app) completely independent of whether a user happens to have clicked Cancel
 * around the same moment. Checking the ambient `signal.aborted` flag at the outer catch can't tell
 * these apart (the flag is `true` either way once a cancel has been requested) and would mislabel a
 * real infrastructure failure as a benign, calmly-notified cancellation. Every place that spawns an
 * abortable child process on the deploy pipeline's behalf (`services/git.ts`, `sysops/real.ts`'s
 * `unitAction`/`reloadPhpFpm`) throws `AbortedError` specifically — and only — when it can attribute
 * the failure to *this* operation's own `cancelSignal` firing (checked immediately after the call
 * that was passed the signal, not generically later), so callers can classify by catching this type
 * rather than reading the flag.
 */
export class AbortedError extends Error {
  constructor(message = 'operation canceled') {
    super(message);
    this.name = 'AbortedError';
  }
}
