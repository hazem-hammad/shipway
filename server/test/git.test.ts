import { describe, expect, it } from 'vitest';
import { execa } from 'execa';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { makeGitOps } from '../src/services/git.js';

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
}

/** Creates a real git repo at `dir` with an initial commit of `index.html`. Returns its sha. */
async function makeFixtureRepo(dir: string, content: string): Promise<string> {
  await execa('git', ['init', '-b', 'main'], { cwd: dir });
  await execa('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  await execa('git', ['config', 'user.name', 'Test'], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'index.html'), content);
  await execa('git', ['add', 'index.html'], { cwd: dir });
  await execa('git', ['commit', '-m', 'first commit'], { cwd: dir });
  const { stdout } = await execa('git', ['rev-parse', 'HEAD'], { cwd: dir });
  return stdout.trim();
}

async function addCommit(dir: string, content: string, message: string): Promise<string> {
  fs.writeFileSync(path.join(dir, 'index.html'), content);
  await execa('git', ['commit', '-am', message], { cwd: dir });
  const { stdout } = await execa('git', ['rev-parse', 'HEAD'], { cwd: dir });
  return stdout.trim();
}

function fileUrl(dir: string): string {
  return `file://${dir}`;
}

describe('makeGitOps (real git integration)', () => {
  it('fetchBranchTip clones a bare mirror on first call and returns the branch tip sha + message', async () => {
    const fixtureDir = tmpDir('shipway-git-fixture');
    const sha = await makeFixtureRepo(fixtureDir, '<h1>v1</h1>\n');
    const projectDir = tmpDir('shipway-git-project');
    const gitOps = makeGitOps();

    const result = await gitOps.fetchBranchTip(projectDir, fileUrl(fixtureDir), 'main');

    expect(result).toEqual({ sha, message: 'first commit' });
    const repoDir = path.join(projectDir, 'repo');
    expect(fs.existsSync(repoDir)).toBe(true);
    expect(fs.existsSync(path.join(repoDir, 'HEAD'))).toBe(true);
    // A bare mirror has no working tree / .git subdirectory.
    expect(fs.existsSync(path.join(repoDir, '.git'))).toBe(false);
  });

  it('second fetchBranchTip reuses the existing mirror and returns the new tip', async () => {
    const fixtureDir = tmpDir('shipway-git-fixture');
    const firstSha = await makeFixtureRepo(fixtureDir, '<h1>v1</h1>\n');
    const projectDir = tmpDir('shipway-git-project');
    const gitOps = makeGitOps();
    const repoDir = path.join(projectDir, 'repo');

    const first = await gitOps.fetchBranchTip(projectDir, fileUrl(fixtureDir), 'main');
    expect(first.sha).toBe(firstSha);
    const statAfterFirst = fs.statSync(repoDir);

    const secondSha = await addCommit(fixtureDir, '<h1>v2</h1>\n', 'second commit');
    const second = await gitOps.fetchBranchTip(projectDir, fileUrl(fixtureDir), 'main');

    expect(second.sha).toBe(secondSha);
    expect(second.sha).not.toBe(first.sha);
    expect(second.message).toBe('second commit');
    // The mirror directory itself was not recreated (same inode across both calls).
    const statAfterSecond = fs.statSync(repoDir);
    expect(statAfterSecond.ino).toBe(statAfterFirst.ino);
    expect(statAfterSecond.birthtimeMs).toBe(statAfterFirst.birthtimeMs);
  });

  it('fetchBranchTip throws a clear error for an unknown branch', async () => {
    const fixtureDir = tmpDir('shipway-git-fixture');
    await makeFixtureRepo(fixtureDir, '<h1>v1</h1>\n');
    const projectDir = tmpDir('shipway-git-project');
    const gitOps = makeGitOps();

    await expect(gitOps.fetchBranchTip(projectDir, fileUrl(fixtureDir), 'does-not-exist')).rejects.toThrow(
      /does-not-exist/,
    );
  });

  it('fetchBranchTip resolves the branch tip, not a same-named tag pointing at an older commit', async () => {
    const fixtureDir = tmpDir('shipway-git-fixture');
    const olderSha = await makeFixtureRepo(fixtureDir, '<h1>v1</h1>\n');
    // A tag named "main" — same simple name as the branch — pointing at the older commit.
    // `git rev-parse` alone disambiguates refs/tags/* before refs/heads/*, so a naive
    // `rev-parse main` would resolve to this tag instead of the branch tip.
    await execa('git', ['tag', 'main', olderSha], { cwd: fixtureDir });
    const branchSha = await addCommit(fixtureDir, '<h1>v2</h1>\n', 'second commit');
    const projectDir = tmpDir('shipway-git-project');
    const gitOps = makeGitOps();

    const result = await gitOps.fetchBranchTip(projectDir, fileUrl(fixtureDir), 'main');

    expect(result.sha).toBe(branchSha);
    expect(result.sha).not.toBe(olderSha);
    expect(result.message).toBe('second commit');
  });

  it.each(['-x', '--help'])('fetchBranchTip rejects a flag-like branch name %s', async (branch) => {
    const fixtureDir = tmpDir('shipway-git-fixture');
    await makeFixtureRepo(fixtureDir, '<h1>v1</h1>\n');
    const projectDir = tmpDir('shipway-git-project');
    const gitOps = makeGitOps();

    await expect(gitOps.fetchBranchTip(projectDir, fileUrl(fixtureDir), branch)).rejects.toThrow(
      /invalid branch name/,
    );
  });

  it('fetchBranchTip redacts credentials from thrown error messages', async () => {
    const url = 'https://x-access-token:super-secret-token@example.com/acme/repo.git';
    const stubRun = (async (file: string, args: readonly string[] = []) => {
      throw new Error(`Command failed: ${file} ${args.join(' ')}`);
    }) as unknown as typeof execa;
    const gitOps = makeGitOps(stubRun);
    const projectDir = tmpDir('shipway-git-project');

    await expect(gitOps.fetchBranchTip(projectDir, url, 'main')).rejects.toThrow(/\*\*\*@example\.com/);
    await expect(gitOps.fetchBranchTip(projectDir, url, 'main')).rejects.not.toThrow(/super-secret-token/);
  });

  it('fetchBranchTip passes the signal through as cancelSignal and surfaces a clear canceled error when aborted mid-clone', async () => {
    // A stub `run` that never settles on its own — only the `cancelSignal` it was given (execa's
    // real behavior on abort) rejects it — simulating a slow/unreachable remote, the root cause
    // this fix targets. The raw rejection message is deliberately confusing/generic (the way a real
    // execa/DOMException abort error can be) to prove `fetchBranchTip` replaces it with a clear one.
    const stubRun = ((_file: string, _args: readonly string[] = [], opts?: { cancelSignal?: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        opts?.cancelSignal?.addEventListener(
          'abort',
          () => {
            reject(new Error('This operation was aborted'));
          },
          { once: true },
        );
      })) as unknown as typeof execa;
    const gitOps = makeGitOps(stubRun);
    const projectDir = tmpDir('shipway-git-project');
    const controller = new AbortController();

    const promise = gitOps.fetchBranchTip(projectDir, 'https://example.com/acme/repo.git', 'main', controller.signal);
    setTimeout(() => {
      controller.abort();
    }, 20);

    const start = Date.now();
    await expect(promise).rejects.toThrow(/canceled/);
    expect(Date.now() - start).toBeLessThan(1000);
  });

  it('exportRelease produces the working tree without .git', async () => {
    const fixtureDir = tmpDir('shipway-git-fixture');
    await makeFixtureRepo(fixtureDir, '<h1>v1</h1>\n');
    const projectDir = tmpDir('shipway-git-project');
    const gitOps = makeGitOps();
    const { sha } = await gitOps.fetchBranchTip(projectDir, fileUrl(fixtureDir), 'main');

    const releaseDir = path.join(tmpDir('shipway-git-release'), 'release-1');
    await gitOps.exportRelease(projectDir, sha, releaseDir);

    expect(fs.readFileSync(path.join(releaseDir, 'index.html'), 'utf8')).toBe('<h1>v1</h1>\n');
    expect(fs.existsSync(path.join(releaseDir, '.git'))).toBe(false);
  });

  it('exportRelease of an older sha yields the older content', async () => {
    const fixtureDir = tmpDir('shipway-git-fixture');
    const firstSha = await makeFixtureRepo(fixtureDir, '<h1>v1</h1>\n');
    const projectDir = tmpDir('shipway-git-project');
    const gitOps = makeGitOps();

    await gitOps.fetchBranchTip(projectDir, fileUrl(fixtureDir), 'main');
    await addCommit(fixtureDir, '<h1>v2</h1>\n', 'second commit');
    await gitOps.fetchBranchTip(projectDir, fileUrl(fixtureDir), 'main');

    const releaseDir = path.join(tmpDir('shipway-git-release'), 'release-old');
    await gitOps.exportRelease(projectDir, firstSha, releaseDir);

    expect(fs.readFileSync(path.join(releaseDir, 'index.html'), 'utf8')).toBe('<h1>v1</h1>\n');
  });

  it.each(['-x', 'not-a-sha', 'abc123'])('exportRelease rejects an invalid sha %s without spawning git', async (sha) => {
    const projectDir = tmpDir('shipway-git-project');
    const gitOps = makeGitOps();
    const releaseDir = path.join(tmpDir('shipway-git-release'), 'release-bad');

    await expect(gitOps.exportRelease(projectDir, sha, releaseDir)).rejects.toThrow(/invalid sha/);
  });
});
