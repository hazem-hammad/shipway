/**
 * GitHub push webhook: `POST /api/webhooks/github`. Registered without session auth (see
 * `PUBLIC_API_PREFIXES` in `app.ts`) and verified instead via GitHub's HMAC signature
 * (`X-Hub-Signature-256`) computed over the *raw* request body.
 *
 * Fastify's default JSON content-type parser only hands handlers the already-parsed object, which
 * is useless here: the signature is computed over the exact bytes GitHub sent, and
 * `JSON.stringify(JSON.parse(body))` isn't guaranteed to round-trip byte-for-byte. So this plugin
 * registers its own `application/json` content-type parser that hands back the raw `Buffer`
 * instead; the handler verifies the signature against those raw bytes and only then `JSON.parse`s
 * them itself.
 *
 * That parser is scoped to *this* plugin only: `webhookRoutes` is registered in `app.ts` as a plain
 * async function (not wrapped in `fastify-plugin`, matching every other file under `./routes/`), so
 * Fastify gives it its own encapsulation context — `addContentTypeParser` calls made here don't leak
 * to sibling route plugins registered elsewhere, which keep the normal parsed-object behavior (see
 * `server/test/webhooks.test.ts`'s "does not leak its raw-body content-type parser" case).
 */
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { projects } from '../db/schema.js';
import { getSetting } from '../db/settings.js';
import { recordAudit } from '../services/audit.js';
import { verifyWebhookSignature, type GithubAppConfig } from '../services/github.js';

const GITHUB_APP_SETTING_KEY = 'github_app';

/** The `after` SHA GitHub sends on a push that deletes a branch — 40 zeros. */
const DELETED_BRANCH_SHA = '0'.repeat(40);

const pushPayloadSchema = z.object({
  ref: z.string(),
  after: z.string(),
  // `.min(1)`: defense in depth for Task 8's Git-URL project source, which stores `repo: ''` (the
  // `repo` column is NOT NULL). GitHub itself never sends an empty `full_name`, but without this the
  // match below (`eq(projects.repo, payload.repository.full_name)`) would happily match a repoUrl
  // project against a malformed/empty payload value.
  repository: z.object({ full_name: z.string().min(1) }),
  head_commit: z.object({ message: z.string() }).nullable().optional(),
});

/**
 * Registers `POST /api/webhooks/github`. Sits outside the global session guard in `buildApp`
 * (`/api/webhooks/` is a public prefix) — authenticity is established by the HMAC check below
 * instead of a session cookie.
 */
export async function webhookRoutes(app: FastifyInstance): Promise<void> {
  // Scoped raw-body parser — see the module doc comment above.
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_request, body, done) => {
    done(null, body);
  });

  app.post('/api/webhooks/github', async (request, reply) => {
    const githubAppCfg = getSetting<GithubAppConfig>(app.db, GITHUB_APP_SETTING_KEY);
    if (!githubAppCfg) {
      return reply.code(503).send({ error: 'github app not configured' });
    }

    const rawBody = request.body as Buffer;
    const sigHeader = request.headers['x-hub-signature-256'];
    const signatureValid = verifyWebhookSignature(
      githubAppCfg.webhookSecret,
      rawBody,
      typeof sigHeader === 'string' ? sigHeader : undefined,
    );
    if (!signatureValid) {
      return reply.code(401).send({ error: 'invalid signature' });
    }

    const event = request.headers['x-github-event'];
    if (event === 'ping') {
      return reply.code(200).send({ ok: true });
    }
    if (event !== 'push') {
      return reply.code(200).send({ ignored: true });
    }

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(rawBody.toString('utf8'));
    } catch {
      return reply.code(400).send({ error: 'invalid JSON payload' });
    }

    const payloadParsed = pushPayloadSchema.safeParse(parsedJson);
    if (!payloadParsed.success) {
      return reply.code(400).send({ error: 'invalid push payload' });
    }
    const payload = payloadParsed.data;

    // A push that deletes a branch carries this all-zero `after` SHA — there's nothing to deploy.
    if (payload.after === DELETED_BRANCH_SHA) {
      return reply.code(200).send({ ignored: true });
    }

    const candidates = app.db
      .select()
      .from(projects)
      .where(eq(projects.repo, payload.repository.full_name))
      .all();
    const matchingProjects = candidates.filter(
      (project) => project.autoDeploy && payload.ref === `refs/heads/${project.branch}`,
    );

    if (matchingProjects.length === 0) {
      return reply.code(200).send({ ignored: true });
    }

    const deployed = matchingProjects.map((project) => {
      const deploymentId = app.queue.enqueue({
        projectId: project.id,
        trigger: 'push',
        commitSha: payload.after,
        commitMessage: payload.head_commit?.message,
      });

      recordAudit(app.db, {
        actorId: null,
        actorName: 'github',
        action: 'deploy.trigger',
        targetType: 'project',
        targetName: project.slug,
        meta: { trigger: 'push', commitSha: payload.after, deploymentId },
      });

      return deploymentId;
    });

    return reply.code(200).send({ deployed });
  });
}
