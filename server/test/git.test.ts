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

  it('runs `git archive` with buffer:false — buffering the tar stream killed the whole process on a large repo', async () => {
    // Regression test for a hard crash, not a slow path: execa buffers and UTF-8-decodes a
    // subprocess's stdout by default even when it is piped onward, so a 364MB `git archive` stream
    // built a string past V8's internal array limit and aborted the entire Shipway process with
    // "Fatal JavaScript invalid size error" (SIGILL) — taking the dashboard and every concurrent
    // deploy down, rather than failing the one deploy. Asserted at the options level because
    // reproducing it for real needs a repo far too large for a fixture.
    const calls: { file: string; args: string[]; opts: Record<string, unknown> }[] = [];
    const fakeRun = ((file: string, args: string[], opts: Record<string, unknown>) => {
      calls.push({ file, args, opts });
      // Minimal stand-in for execa's return value: only `.pipe()` is used on the archive call.
      return { pipe: () => Promise.resolve({ stdout: '' }) };
    }) as unknown as typeof execa;

    const gitOps = makeGitOps(fakeRun);
    const releaseDir = path.join(tmpDir('shipway-git-release'), 'release-opts');
    await gitOps.exportRelease('/tmp/does-not-matter', 'a'.repeat(40), releaseDir);

    const archive = calls.find((c) => c.args.includes('archive'));
    expect(archive, 'git archive should have been spawned').toBeDefined();
    expect(archive?.opts.buffer).toBe(false);
  });
});

describe('makeGitOps.listRemoteBranches', () => {
  it('lists a remote\'s branches and the branch HEAD points at, without cloning', async () => {
    const fixtureDir = tmpDir('shipway-git-fixture');
    await makeFixtureRepo(fixtureDir, '<h1>v1</h1>\n');
    await execa('git', ['branch', 'develop'], { cwd: fixtureDir });
    await execa('git', ['branch', 'feature/nested-name'], { cwd: fixtureDir });
    const gitOps = makeGitOps();

    const result = await gitOps.listRemoteBranches(fileUrl(fixtureDir));

    expect(result.defaultBranch).toBe('main');
    expect(result.branches).toEqual(['develop', 'feature/nested-name', 'main']);
    // Nothing was written anywhere: ls-remote is the whole implementation.
    expect(fs.existsSync(path.join(fixtureDir, 'repo'))).toBe(false);
  });

  it('reports a repo with no branches as empty rather than failing', async () => {
    const emptyDir = tmpDir('shipway-git-empty');
    await execa('git', ['init', '-b', 'main', '--bare'], { cwd: emptyDir });
    const gitOps = makeGitOps();

    const result = await gitOps.listRemoteBranches(fileUrl(emptyDir));

    expect(result.branches).toEqual([]);
  });

  it('fails with a clear error for a url that is not a git repository', async () => {
    const notARepo = tmpDir('shipway-git-not-a-repo');
    const gitOps = makeGitOps();

    await expect(gitOps.listRemoteBranches(fileUrl(notARepo))).rejects.toThrow();
  });

  it('rejects a flag-like url instead of handing it to git as an option', async () => {
    const gitOps = makeGitOps();

    await expect(gitOps.listRemoteBranches('--upload-pack=touch /tmp/pwned')).rejects.toThrow(/invalid repository url/);
  });

  it('strips credentials embedded in the url out of the error text', async () => {
    const url = 'https://user:s3cr3t-token@git.invalid/acme/app.git';
    const failingRun = (() => Promise.reject(new Error(`fatal: could not read from ${url}`))) as unknown as typeof execa;
    const gitOps = makeGitOps(failingRun);

    await expect(gitOps.listRemoteBranches(url)).rejects.toThrow(/\/\/\*\*\*@git\.invalid/);
    await expect(gitOps.listRemoteBranches(url)).rejects.not.toThrow(/s3cr3t-token/);
  });

  it('disables git\'s terminal prompt so a private url cannot block on a username prompt', async () => {
    const calls: { args: string[]; opts: Record<string, unknown> }[] = [];
    const fakeRun = ((_file: string, args: string[], opts: Record<string, unknown>) => {
      calls.push({ args, opts });
      return Promise.resolve({ stdout: '' });
    }) as unknown as typeof execa;

    await makeGitOps(fakeRun).listRemoteBranches('https://git.example.com/acme/app.git');

    const env = calls[0]?.opts.env as Record<string, string> | undefined;
    expect(calls[0]?.args).toContain('ls-remote');
    expect(env?.GIT_TERMINAL_PROMPT).toBe('0');
  });

  it('reports a canceled listing as a cancellation, not a git failure', async () => {
    const controller = new AbortController();
    const hangingRun = ((_file: string, _args: string[], opts: { cancelSignal?: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        opts.cancelSignal?.addEventListener('abort', () => {
          reject(new Error('some raw execa cancellation error'));
        });
      })) as unknown as typeof execa;

    const pending = makeGitOps(hangingRun).listRemoteBranches('https://git.example.com/acme/app.git', controller.signal);
    controller.abort();

    await expect(pending).rejects.toThrow(/canceled/);
  });
});
