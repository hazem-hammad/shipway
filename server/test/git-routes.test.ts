import { describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildOwnerApp } from './helpers.js';
import type { GitOps } from '../src/services/git.js';

/** A `GitOps` whose only working method is `listRemoteBranches` — the one this route uses. */
function stubGitOps(listRemoteBranches: GitOps['listRemoteBranches']): GitOps {
  return {
    listRemoteBranches,
    fetchBranchTip: () => Promise.reject(new Error('fetchBranchTip must not be called by /api/git/branches')),
    exportRelease: () => Promise.reject(new Error('exportRelease must not be called by /api/git/branches')),
  };
}

async function buildApp(gitOps: GitOps): Promise<{ app: FastifyInstance; cookie: string }> {
  const { app, cookie } = await buildOwnerApp({ gitOps });
  return { app, cookie };
}

const URL_PATH = '/api/git/branches';
const REPO_URL = 'https://git.example.com/acme/app.git';

describe('GET /api/git/branches', () => {
  it('returns the remote branches and its default branch', async () => {
    const seen: string[] = [];
    const { app, cookie } = await buildApp(
      stubGitOps((url) => {
        seen.push(url);
        return Promise.resolve({ branches: ['develop', 'main'], defaultBranch: 'main' });
      }),
    );

    const res = await app.inject({ method: 'GET', url: `${URL_PATH}?url=${encodeURIComponent(REPO_URL)}`, headers: { cookie } });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ branches: ['develop', 'main'], defaultBranch: 'main' });
    expect(seen).toEqual([REPO_URL]);

    await app.close();
  });

  it('passes an abort signal so an unreachable remote cannot hold the request open forever', async () => {
    let signal: AbortSignal | undefined;
    const { app, cookie } = await buildApp(
      stubGitOps((_url, sig) => {
        signal = sig;
        return Promise.resolve({ branches: [], defaultBranch: null });
      }),
    );

    await app.inject({ method: 'GET', url: `${URL_PATH}?url=${encodeURIComponent(REPO_URL)}`, headers: { cookie } });

    expect(signal).toBeInstanceOf(AbortSignal);

    await app.close();
  });

  it('400s on a url that is not an http(s) git url', async () => {
    const { app, cookie } = await buildApp(
      stubGitOps(() => Promise.reject(new Error('listRemoteBranches must not be reached for a rejected url'))),
    );

    for (const url of ['git@github.com:acme/app.git', 'file:///etc', 'ftp://example.com/repo', '--upload-pack=x', '']) {
      const res = await app.inject({ method: 'GET', url: `${URL_PATH}?url=${encodeURIComponent(url)}`, headers: { cookie } });
      expect(res.statusCode, `expected 400 for ${url}`).toBe(400);
    }

    await app.close();
  });

  it('400s when the url is missing entirely', async () => {
    const { app, cookie } = await buildApp(stubGitOps(() => Promise.reject(new Error('must not be called'))));

    const res = await app.inject({ method: 'GET', url: URL_PATH, headers: { cookie } });

    expect(res.statusCode).toBe(400);

    await app.close();
  });

  it("502s with git's own message when the remote cannot be read", async () => {
    const { app, cookie } = await buildApp(stubGitOps(() => Promise.reject(new Error('fatal: repository not found'))));

    const res = await app.inject({ method: 'GET', url: `${URL_PATH}?url=${encodeURIComponent(REPO_URL)}`, headers: { cookie } });

    expect(res.statusCode).toBe(502);
    expect(res.json()).toMatchObject({ error: 'could not list branches', detail: 'fatal: repository not found' });

    await app.close();
  });

  it('requires a session', async () => {
    const { app } = await buildApp(stubGitOps(() => Promise.reject(new Error('must not be called unauthenticated'))));

    const res = await app.inject({ method: 'GET', url: `${URL_PATH}?url=${encodeURIComponent(REPO_URL)}` });

    expect(res.statusCode).toBe(401);

    await app.close();
  });
});
