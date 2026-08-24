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
 */
import { execa } from 'execa';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

export interface GitOps {
  /**
   * Ensures `<projectDir>/repo` is a bare mirror of `url`, up to date, then resolves `branch`'s
   * tip strictly from `refs/heads/<branch>` (never falling back to a same-named tag or other
   * ref). Clones on first use; fetches (after updating the remote URL) on subsequent calls.
   * Throws a clear `Error` if `branch` doesn't exist or looks flag-like (starts with `-`).
   */
  fetchBranchTip(projectDir: string, url: string, branch: string): Promise<{ sha: string; message: string }>;
  /**
   * Exports the tree at `sha` from `<projectDir>/repo` into `releaseDir` (created if missing),
   * without `.git`. Throws if `sha` isn't a full 40-character hex object id.
   */
  exportRelease(projectDir: string, sha: string, releaseDir: string): Promise<void>;
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

/** Matches a full 40-character lowercase-hex git object sha. */
const SHA_RE = /^[0-9a-f]{40}$/;

/** Builds the real `GitOps`. `run` defaults to `execa`; tests may inject a stub. */
export function makeGitOps(run: typeof execa = execa): GitOps {
  return {
    async fetchBranchTip(projectDir, url, branch) {
      // Reject flag-like branch names up front — belt-and-suspenders on top of the
      // `refs/heads/` prefix below, which already stops them being interpreted as flags.
      if (branch.startsWith('-')) {
        throw new Error(`invalid branch name: "${branch}"`);
      }

      const repoDir = join(projectDir, 'repo');

      try {
        if (!existsSync(repoDir)) {
          await mkdir(projectDir, { recursive: true });
          await run('git', ['clone', '--mirror', url, repoDir]);
        } else {
          await run('git', ['-C', repoDir, 'remote', 'set-url', 'origin', url]);
          await run('git', ['-C', repoDir, 'fetch', 'origin', '--prune']);
        }
      } catch (err) {
        throw sanitizeError(err, url);
      }

      // `--verify refs/heads/<branch>` (rather than a bare `rev-parse <branch>`) is required:
      // plain `rev-parse <name>` disambiguates refs/tags/<name> BEFORE refs/heads/<name> (see
      // gitrevisions(7)), so a tag sharing the branch's name would silently win and resolve to
      // the wrong commit. Mirror clones keep branches under refs/heads/, same as any clone.
      let sha: string;
      try {
        const result = await run('git', ['-C', repoDir, 'rev-parse', '--verify', `refs/heads/${branch}`]);
        sha = result.stdout.trim();
      } catch {
        throw new Error(`branch "${branch}" not found at ${redactUrl(url)}`);
      }

      const messageResult = await run('git', ['-C', repoDir, 'log', '-1', '--format=%s', sha]);
      return { sha, message: messageResult.stdout.trim() };
    },

    async exportRelease(projectDir, sha, releaseDir) {
      if (!SHA_RE.test(sha)) {
        throw new Error(`invalid sha: "${sha}"`);
      }

      const repoDir = join(projectDir, 'repo');
      await mkdir(releaseDir, { recursive: true });
      await run('git', ['-C', repoDir, 'archive', sha]).pipe('tar', ['-x', '-C', releaseDir]);
    },
  };
}
