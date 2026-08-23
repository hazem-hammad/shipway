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
   * tip. Clones on first use; fetches (after updating the remote URL) on subsequent calls. Throws
   * a clear `Error` if `branch` doesn't exist.
   */
  fetchBranchTip(projectDir: string, url: string, branch: string): Promise<{ sha: string; message: string }>;
  /** Exports the tree at `sha` from `<projectDir>/repo` into `releaseDir` (created if missing), without `.git`. */
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

/** Builds the real `GitOps`. `run` defaults to `execa`; tests may inject a stub. */
export function makeGitOps(run: typeof execa = execa): GitOps {
  return {
    async fetchBranchTip(projectDir, url, branch) {
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

      let sha: string;
      try {
        const result = await run('git', ['-C', repoDir, 'rev-parse', branch]);
        sha = result.stdout.trim();
      } catch {
        throw new Error(`branch "${branch}" not found at ${redactUrl(url)}`);
      }

      const messageResult = await run('git', ['-C', repoDir, 'log', '-1', '--format=%s', sha]);
      return { sha, message: messageResult.stdout.trim() };
    },

    async exportRelease(projectDir, sha, releaseDir) {
      const repoDir = join(projectDir, 'repo');
      await mkdir(releaseDir, { recursive: true });
      await run('git', ['-C', repoDir, 'archive', sha]).pipe('tar', ['-x', '-C', releaseDir]);
    },
  };
}
