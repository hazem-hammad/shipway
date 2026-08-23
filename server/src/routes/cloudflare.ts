import type { FastifyInstance } from 'fastify';

/**
 * Registers `GET /api/cloudflare/verify`. Sits under the global session guard in `buildApp`.
 *
 * Delegates to `app.dns()`'s `verifyToken()`. `app.dns()` is `null` when Cloudflare isn't
 * configured yet (no `cloudflare_token`/`cloudflare_zone_id` settings) — that's a normal state
 * during setup, so it's reported as `{ ok: false }` rather than a 5xx. The setup wizard's "Test
 * connection" step (and any later re-check from Settings) both hit this same route.
 */
export async function cloudflareRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/cloudflare/verify', async () => {
    const dns = app.dns();
    if (!dns) {
      return { ok: false };
    }
    const ok = await dns.verifyToken();
    return { ok };
  });
}
