import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { settings } from '../db/schema.js';
import { getSetting, setSetting } from '../db/settings.js';
import type { ShipwayDb } from '../db/index.js';

/** Prefix used to mask secrets in `GET`/`PUT` responses (see `maskToken`). */
const MASK_PREFIX = '•••';

/**
 * Whitelisted settings keys this route reads/writes. `github_app` is deliberately excluded — it's
 * written by the GitHub App setup flow (a later task) and is only surfaced here as a derived
 * `configured` boolean, never as raw key/value.
 */
const settingsUpdateSchema = z
  .object({
    base_domain: z.string().min(1),
    server_ip: z.string().min(1),
    acme_email: z.string().email(),
    cloudflare_token: z.string().min(1),
    cloudflare_zone_id: z.string().min(1),
    notify_webhook_url: z.string().min(1),
    notify_on_success: z.boolean(),
  })
  .partial();

interface SettingsResponse {
  base_domain: string | null;
  server_ip: string | null;
  acme_email: string | null;
  cloudflare_token: string | null;
  cloudflare_zone_id: string | null;
  notify_webhook_url: string | null;
  notify_on_success: boolean | null;
  github_app: { configured: boolean };
}

/** Masks a secret as "•••" followed by its last 4 characters. */
function maskToken(token: string): string {
  return `${MASK_PREFIX}${token.slice(-4)}`;
}

/** Builds the full `GET`/`PUT` response shape by reading every whitelisted key plus `github_app`. */
function buildSettingsResponse(db: ShipwayDb): SettingsResponse {
  const cloudflareToken = getSetting<string>(db, 'cloudflare_token');
  const githubAppRow = db.select({ key: settings.key }).from(settings).where(eq(settings.key, 'github_app')).get();

  return {
    base_domain: getSetting<string>(db, 'base_domain'),
    server_ip: getSetting<string>(db, 'server_ip'),
    acme_email: getSetting<string>(db, 'acme_email'),
    cloudflare_token: cloudflareToken ? maskToken(cloudflareToken) : null,
    cloudflare_zone_id: getSetting<string>(db, 'cloudflare_zone_id'),
    notify_webhook_url: getSetting<string>(db, 'notify_webhook_url'),
    notify_on_success: getSetting<boolean>(db, 'notify_on_success'),
    github_app: { configured: githubAppRow !== undefined },
  };
}

/**
 * Registers `GET`/`PUT /api/settings`. Both sit under the global session guard in `buildApp`.
 */
export async function settingsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/settings', async () => {
    return buildSettingsResponse(app.db);
  });

  app.put('/api/settings', async (request, reply) => {
    const parsed = settingsUpdateSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid request body' });
    }

    for (const [key, value] of Object.entries(parsed.data)) {
      // A masked value (e.g. a frontend echoing back the "•••1234" it got from GET) means "leave
      // this secret alone" rather than "set the secret to this literal masked string".
      if (typeof value === 'string' && value.startsWith(MASK_PREFIX)) {
        continue;
      }
      setSetting(app.db, key, value);
    }

    return buildSettingsResponse(app.db);
  });
}
