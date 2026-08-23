/**
 * GitHub App integration: token-cached installation auth, thin octokit wrappers for listing
 * installation repos/branches, timing-safe webhook signature verification, and the manifest-flow
 * conversion helper used by the `/api/setup/github/callback` route.
 *
 * `GitHubService`'s API methods are thin wrappers over octokit (typecheck-covered, not unit-tested
 * against the network — see `server/test/github.test.ts`). `verifyWebhookSignature` and `cloneUrl`
 * are pure functions and are fully unit-tested.
 */
import { createAppAuth } from '@octokit/auth-app';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { Octokit } from 'octokit';

/** The JSON shape stored at settings key `github_app`. */
export interface GithubAppConfig {
  appId: number;
  privateKey: string;
  webhookSecret: string;
  installationId?: number;
  slug?: string;
}

export interface GithubRepo {
  fullName: string;
  defaultBranch: string;
  private: boolean;
}

/** Refresh the cached installation token once fewer than this many ms remain until expiry. */
const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;

/** Hard cap on branches returned by `listBranches`, applied across paginated pages. */
const MAX_BRANCHES = 200;

const BRANCHES_PAGE_SIZE = 100;

interface CachedToken {
  token: string;
  expiresAt: number; // ms since epoch
}

/** Splits `owner/repo` into its parts. Throws on any other shape. */
function parseRepoFullName(repoFullName: string): { owner: string; repo: string } {
  const parts = repoFullName.split('/');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(`invalid repo full name: ${repoFullName}`);
  }
  return { owner: parts[0], repo: parts[1] };
}

/**
 * Wraps a single GitHub App's credentials. Two octokit auth modes are used internally:
 *  - app-level JWT auth (via `createAppAuth` with no `installationId`) for `/app/*` endpoints
 *    like listing installations;
 *  - installation-token auth (also via `createAppAuth`, `{type: 'installation'}`) for everything
 *    scoped to the installation (repos, branches).
 * The installation token is cached on the instance and refreshed once fewer than
 * `TOKEN_REFRESH_MARGIN_MS` remain until its expiry.
 */
export class GitHubService {
  private readonly auth: ReturnType<typeof createAppAuth>;
  private cachedToken: CachedToken | null = null;

  constructor(private readonly cfg: GithubAppConfig) {
    // `@octokit/auth-app`'s createAppAuth treats a *present-but-undefined* `installationId` key as
    // an error ("installationId is set to a falsy value") — distinct from omitting the key
    // entirely, which is how it's told "app-only, no installation yet" (the normal state before
    // `resolveInstallationId`/`resolve-installation` has run). So the key must only be included
    // when actually set, not passed through as `installationId: cfg.installationId`.
    this.auth = createAppAuth(
      cfg.installationId === undefined
        ? { appId: cfg.appId, privateKey: cfg.privateKey }
        : { appId: cfg.appId, privateKey: cfg.privateKey, installationId: cfg.installationId },
    );
  }

  /** Returns a cached installation access token, minting/refreshing one when needed. */
  async getInstallationToken(): Promise<string> {
    const now = Date.now();
    if (this.cachedToken && this.cachedToken.expiresAt - now > TOKEN_REFRESH_MARGIN_MS) {
      return this.cachedToken.token;
    }

    if (this.cfg.installationId === undefined) {
      throw new Error('github app has no installationId configured');
    }

    const authentication = await this.auth({ type: 'installation', installationId: this.cfg.installationId });
    this.cachedToken = { token: authentication.token, expiresAt: new Date(authentication.expiresAt).getTime() };
    return authentication.token;
  }

  /** An Octokit instance authenticated with the current (cached) installation token. */
  private async installationOctokit(): Promise<Octokit> {
    const token = await this.getInstallationToken();
    return new Octokit({ auth: token });
  }

  /** Lists every repository the installation can access, paginating `GET /installation/repositories`. */
  async listRepos(): Promise<GithubRepo[]> {
    const octokit = await this.installationOctokit();
    const repos = await octokit.paginate(octokit.rest.apps.listReposAccessibleToInstallation);
    return repos.map((repo) => ({
      fullName: repo.full_name,
      defaultBranch: repo.default_branch,
      private: repo.private,
    }));
  }

  /** Lists branch names for `owner/repo`, paginating up to `MAX_BRANCHES`. */
  async listBranches(repoFullName: string): Promise<string[]> {
    const { owner, repo } = parseRepoFullName(repoFullName);
    const octokit = await this.installationOctokit();

    const names: string[] = [];
    const iterator = octokit.paginate.iterator(octokit.rest.repos.listBranches, {
      owner,
      repo,
      per_page: BRANCHES_PAGE_SIZE,
    });
    for await (const { data: page } of iterator) {
      for (const branch of page) {
        names.push(branch.name);
        if (names.length >= MAX_BRANCHES) return names;
      }
    }
    return names;
  }

  /** Resolves the first (only, in practice) installation of this app via app-level JWT auth. */
  async resolveInstallationId(): Promise<number> {
    const appOctokit = new Octokit({
      authStrategy: createAppAuth,
      auth: { appId: this.cfg.appId, privateKey: this.cfg.privateKey },
    });
    const { data: installations } = await appOctokit.rest.apps.listInstallations();
    const first = installations[0];
    if (!first) {
      throw new Error('no installations found for this GitHub App');
    }
    return first.id;
  }
}

/**
 * Verifies a GitHub webhook's `X-Hub-Signature-256` header against `rawBody` using `secret`.
 * Timing-safe: only compares byte-for-byte when both sides decode to equal-length buffers,
 * returns `false` (never throws) on a missing header, a malformed prefix, or a length mismatch.
 */
export function verifyWebhookSignature(secret: string, rawBody: Buffer, sigHeader: string | undefined): boolean {
  const prefix = 'sha256=';
  if (!sigHeader || !sigHeader.startsWith(prefix)) {
    return false;
  }

  const expected = Buffer.from(createHmac('sha256', secret).update(rawBody).digest('hex'), 'hex');
  const actual = Buffer.from(sigHeader.slice(prefix.length), 'hex');

  if (expected.length !== actual.length) {
    return false;
  }
  return timingSafeEqual(expected, actual);
}

/** Builds an authenticated clone URL for `repoFullName` using an installation access token. */
export function cloneUrl(repoFullName: string, token: string): string {
  return `https://x-access-token:${token}@github.com/${repoFullName}.git`;
}

/** The subset of GitHub's manifest-conversion response `GitHubService`'s callers need. */
export interface ManifestConversion {
  appId: number;
  privateKey: string;
  webhookSecret: string;
  slug: string;
}

interface ManifestConversionResponseBody {
  id: number;
  pem: string;
  webhook_secret: string;
  slug: string;
}

/**
 * Exchanges a manifest-flow `code` for the newly created GitHub App's credentials via
 * `POST /app-manifests/{code}/conversions`. `fetchImpl` defaults to the global `fetch`; tests
 * inject a stub to assert the exact request and avoid the network.
 */
export async function exchangeManifestCode(code: string, fetchImpl: typeof fetch = fetch): Promise<ManifestConversion> {
  const response = await fetchImpl(`https://api.github.com/app-manifests/${code}/conversions`, {
    method: 'POST',
    headers: { Accept: 'application/vnd.github+json' },
  });
  if (!response.ok) {
    throw new Error(`GitHub manifest conversion failed with status ${String(response.status)}`);
  }

  const body = (await response.json()) as ManifestConversionResponseBody;
  return { appId: body.id, privateKey: body.pem, webhookSecret: body.webhook_secret, slug: body.slug };
}
