/**
 * `GET /api/git/branches` — the branch list for an arbitrary git URL, so New Project can offer the
 * same branch dropdown for a pasted Git URL that a GitHub App repo already gets (`/api/github/
 * branches`). Backed by `git ls-remote` via `app.gitOps`, so nothing is cloned and no project has
 * to exist yet.
 *
 * The URL comes from whoever is filling in the form, which means an authenticated team member can
 * point this at any http(s) address the server can reach and learn whether git answers there. That
 * is the same reach `POST /api/projects` already grants (a `repoUrl` project clones exactly this URL
 * on its first deploy), so this adds no new capability — but it is why the route sits behind the
 * session guard like everything else, and why `LS_REMOTE_TIMEOUT_MS` bounds every call.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

/** Mirrors `REPO_URL_RE` in `routes/projects.ts` — the same http(s) git URLs a project can use. */
const REPO_URL_RE = /^https?:\/\/\S+$/;

const branchesQuerySchema = z.object({
  url: z.string().max(500).regex(REPO_URL_RE),
});

/**
 * How long a single `ls-remote` gets. Long enough for a cold TLS handshake to a slow host, short
 * enough that a black-holed address doesn't hold a request (and a form) open indefinitely.
 */
const LS_REMOTE_TIMEOUT_MS = 15_000;

function toErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function gitRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/git/branches', async (request, reply) => {
    const parsed = branchesQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid request' });
    }

    try {
      return await app.gitOps.listRemoteBranches(parsed.data.url, AbortSignal.timeout(LS_REMOTE_TIMEOUT_MS));
    } catch (err) {
      // 502, not 500: the failure is the remote's (unreachable, private, not a git repo), and the
      // detail is what tells the user which of those it was. `listRemoteBranches` has already
      // stripped any credentials embedded in the URL out of the message.
      return reply.code(502).send({ error: 'could not list branches', detail: toErrorMessage(err) });
    }
  });
}
