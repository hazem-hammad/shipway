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
});
