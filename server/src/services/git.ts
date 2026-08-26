/**
 * Git mirror + release export for the deploy pipeline.
 *
 * Each project keeps a single bare mirror clone at `<projectDir>/repo`, created once via
 * `git clone --mirror` and refreshed thereafter via `git fetch origin --prune`. The remote URL is
 * re-set on every fetch (before fetching) so a rotated auth token takes effect immediately. Auth
 * is baked into the clone URL (an https token) — this module never inspects or stores it, and
 * strips it from any error text before throwing, since execa's own error messages otherwise echo
 * the full command line (including the URL) verbatim.
 *
 * `exportRelease` checks out a specific commit into a fresh release folder by streaming
 * `git archive <sha>` directly into `tar -x`, via execa's native process-to-process piping
 * (`subprocess.pipe()`) rather than a shell pipe string — so no `shell: true` and no intermediate
 * temp file.
 *
 * Every git/tar process spawned here takes the caller's optional `AbortSignal` as execa's
 * `cancelSignal`, so a canceled deploy stops a hung/slow remote immediately instead of waiting for
 * git itself to give up — this was the dominant cause of "cancel does nothing" (a `resolve`-stage
 * cancel used to reach nowhere near the actual git process). Every call also sets
 * `killDescendants: true` and a `forceKillAfterDelay` backstop (see `cancelableOpts` below) — a
 * plain single-process `cancelSignal` kill is not enough for `clone`/`fetch` over https: git spawns
 * a `git-remote-https` *grandchild* to own the actual network connection, and killing only the
 * direct child leaves that grandchild running as an orphan, still blocked on the unreachable
 * remote (confirmed against a real unreachable host during this fix's manual verification).
 */
import { execa } from 'execa';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { AbortedError } from '../lib/aborted-error.js';

export interface GitOps {
  /**
   * Ensures `<projectDir>/repo` is a bare mirror of `url`, up to date, then resolves `branch`'s
   * tip strictly from `refs/heads/<branch>` (never falling back to a same-named tag or other
   * ref). Clones on first use; fetches (after updating the remote URL) on subsequent calls.
   * Throws a clear `Error` if `branch` doesn't exist or looks flag-like (starts with `-`).
   *
   * `signal`, when given, is passed as `cancelSignal` to every underlying git process (clone,
   * remote set-url, fetch, rev-parse, log) — a slow or unreachable remote no longer blocks past
   * an abort. If `signal` is already (or becomes) aborted, the method rejects with a clear
   * cancellation error rather than a raw/confusing execa failure, so callers can classify it as a
   * canceled deploy instead of a failed one.
   */
  fetchBranchTip(projectDir: string, url: string, branch: string, signal?: AbortSignal): Promise<{ sha: string; message: string }>;
  /**
   * Exports the tree at `sha` from `<projectDir>/repo` into `releaseDir` (created if missing),
   * without `.git`. Throws if `sha` isn't a full 40-character hex object id.
   *
   * `signal`, when given, is passed as `cancelSignal` to both halves of the `git archive | tar`
   * pipe, and an abort mid-export rejects with a clear cancellation error (see `fetchBranchTip`).
   */
  exportRelease(projectDir: string, sha: string, releaseDir: string, signal?: AbortSignal): Promise<void>;
  /**
   * Lists the branches `url` advertises, plus the branch its `HEAD` points at, without cloning
   * anything — `git ls-remote`, so it's safe to call from a request handler while someone is still
   * filling in the New Project form. Credentials embedded in `url` are used (that's how a private
   * repo without a GitHub App is reachable at all) and stripped from any error text.
   *
   * `signal` is passed to git as `cancelSignal`; callers should always pass one with a timeout,
   * since an unreachable or slow remote is otherwise bounded only by git's own patience.
   */
  listRemoteBranches(url: string, signal?: AbortSignal): Promise<{ branches: string[]; defaultBranch: string | null }>;
}

/** Strips `user:token@` credentials from a URL so they never leak into thrown error text. */
function redactUrl(url: string): string {
  return url.replace(/\/\/[^@]+@/, '//***@');
}

/** Rewraps a caught error, replacing any verbatim occurrence of `url` (which may carry a token) with its redacted form. */
function sanitizeError(err: unknown, url: string): Error {
  const raw = err instanceof Error ? err.message : String(err);
  return new Error(raw.split(url).join(redactUrl(url)));
}

/**
 * A deliberately generic, typed error for a git command aborted via `cancelSignal`: execa's own
 * error for a canceled process (often the bare `AbortSignal.reason`, e.g. a DOMException) is not a
 * clear "this was canceled" message on its own, so callers that see `signal.aborted` after a git
 * command throws replace whatever execa raised with this instead. Using the shared `AbortedError`
 * (rather than a plain `Error`) lets a caller that wants to classify by cause rather than by the
 * ambient `signal.aborted` flag (see `deploy/pipeline.ts`'s `runPostActivate`) do so with
 * `instanceof AbortedError`.
 */
function canceledError(): AbortedError {
  return new AbortedError('git operation canceled');
}

/** SIGKILL escalation delay if the process group doesn't exit promptly after `cancelSignal`'s
 * SIGTERM — mirrors `runshell.ts`'s `forceKillAfterDelay`. */
const CANCEL_FORCE_KILL_DELAY_MS = 5000;

/**
 * The execa options every call in this module gets: `cancelSignal` so an abort reaches the
 * process at all, `killDescendants: true` so the whole process *group* is killed on cancel (not
 * just the direct child — see the module doc comment for why that matters), and
 * `forceKillAfterDelay` as a SIGKILL backstop.
 */
function cancelableOpts(signal: AbortSignal | undefined): { cancelSignal: AbortSignal | undefined; killDescendants: true; forceKillAfterDelay: number } {
  return { cancelSignal: signal, killDescendants: true, forceKillAfterDelay: CANCEL_FORCE_KILL_DELAY_MS };
}

/** Matches a full 40-character lowercase-hex git object sha. */
const SHA_RE = /^[0-9a-f]{40}$/;

/** Builds the real `GitOps`. `run` defaults to `execa`; tests may inject a stub. */
export function makeGitOps(run: typeof execa = execa): GitOps {
  return {
    async fetchBranchTip(projectDir, url, branch, signal) {
      // Reject flag-like branch names up front — belt-and-suspenders on top of the
      // `refs/heads/` prefix below, which already stops them being interpreted as flags.
      if (branch.startsWith('-')) {
        throw new Error(`invalid branch name: "${branch}"`);
      }

      const repoDir = join(projectDir, 'repo');

      try {
        if (!existsSync(repoDir)) {
          await mkdir(projectDir, { recursive: true });
          await run('git', ['clone', '--mirror', url, repoDir], cancelableOpts(signal));
        } else {
          await run('git', ['-C', repoDir, 'remote', 'set-url', 'origin', url], cancelableOpts(signal));
          await run('git', ['-C', repoDir, 'fetch', 'origin', '--prune'], cancelableOpts(signal));
        }
      } catch (err) {
        throw signal?.aborted ? canceledError() : sanitizeError(err, url);
      }

      // `--verify refs/heads/<branch>` (rather than a bare `rev-parse <branch>`) is required:
      // plain `rev-parse <name>` disambiguates refs/tags/<name> BEFORE refs/heads/<name> (see
      // gitrevisions(7)), so a tag sharing the branch's name would silently win and resolve to
      // the wrong commit. Mirror clones keep branches under refs/heads/, same as any clone.
      let sha: string;
      try {
        const result = await run('git', ['-C', repoDir, 'rev-parse', '--verify', `refs/heads/${branch}`], cancelableOpts(signal));
        sha = result.stdout.trim();
      } catch {
        throw signal?.aborted ? canceledError() : new Error(`branch "${branch}" not found at ${redactUrl(url)}`);
      }

      try {
        const messageResult = await run('git', ['-C', repoDir, 'log', '-1', '--format=%s', sha], cancelableOpts(signal));
        return { sha, message: messageResult.stdout.trim() };
      } catch (err) {
        throw signal?.aborted ? canceledError() : err;
      }
    },

    async listRemoteBranches(url, signal) {
      // A url starting with `-` would be read as a flag by git; `ls-remote` has no `--` separator
      // to hide behind, so reject it outright (the routes' url schema already excludes it).
      if (url.startsWith('-')) {
        throw new Error('invalid repository url');
      }

      let stdout: string;
      try {
        // `--symref` makes the remote also report what HEAD points at, which is the branch to
        // preselect. `GIT_TERMINAL_PROMPT=0` is what keeps this bounded: without it, a private repo
        // whose url carries no credentials makes git block forever on a username prompt that no
        // one is there to answer, and `cancelSignal` would be the only thing that ever ends it.
        const result = await run('git', ['ls-remote', '--symref', url, 'HEAD', 'refs/heads/*'], {
          ...cancelableOpts(signal),
          env: { GIT_TERMINAL_PROMPT: '0' },
        });
        stdout = result.stdout;
      } catch (err) {
        throw signal?.aborted ? canceledError() : sanitizeError(err, url);
      }

      const branches: string[] = [];
      let defaultBranch: string | null = null;
      for (const line of stdout.split('\n')) {
        const symref = /^ref:\s+refs\/heads\/(\S+)\s+HEAD$/.exec(line.trim());
        if (symref) {
          defaultBranch = symref[1] as string;
          continue;
        }
        const head = /^[0-9a-f]{40}\s+refs\/heads\/(.+)$/.exec(line.trim());
        if (head) {
          branches.push(head[1] as string);
        }
      }

      return { branches, defaultBranch };
    },

    async exportRelease(projectDir, sha, releaseDir, signal) {
      if (!SHA_RE.test(sha)) {
        throw new Error(`invalid sha: "${sha}"`);
      }

      const repoDir = join(projectDir, 'repo');
      await mkdir(releaseDir, { recursive: true });
      try {
        // `buffer: false` is load-bearing, not an optimization. execa buffers a subprocess's stdout
        // and decodes it as UTF-8 by default, even when that stdout is piped straight into another
        // process. `git archive` emits the whole repo as a binary tar stream — 364MB for a real
        // project seen in the wild — so buffering it built a string past V8's internal array limit
        // and killed the entire Shipway process with `Fatal JavaScript invalid size error`
        // (SIGILL/core dump, taking the dashboard and every other deploy down with it) instead of
        // failing the one deploy. Nothing reads this stdout: tar does, via the pipe.
        await run('git', ['-C', repoDir, 'archive', sha], { ...cancelableOpts(signal), buffer: false }).pipe(
          'tar',
          ['-x', '-C', releaseDir],
          cancelableOpts(signal),
        );
      } catch (err) {
        throw signal?.aborted ? canceledError() : err;
      }
    },
  };
}
