import type { FastifyInstance } from 'fastify';
import { getSetting } from '../db/settings.js';
import { isBlankCredential } from '../services/cloudflare.js';

/**
 * `GET /api/cloudflare/verify`'s response shape (plan Task 1 / spec §3 "Cloudflare verify"). `ok`
 * is `true` only after a real, successful Cloudflare API round-trip. `reason` always says why:
 * `'not_configured'` when no usable token/zone id is stored, `'invalid_token'` when Cloudflare's
 * API itself said the token is invalid/inactive, `'error'` for anything else (network failure,
 * unexpected response) with a sanitized `message`, and `'ok'` on success. The token is never
 * echoed back in `message` — see `sanitizeErrorMessage`.
 */
export interface CloudflareVerifyResult {
  ok: boolean;
  reason: 'ok' | 'not_configured' | 'invalid_token' | 'error';
  message?: string;
}

const MAX_MESSAGE_LENGTH = 200;

/**
 * Turns a thrown error into a short, display-safe message. `CloudflareDnsClient`'s own errors
 * never include the token (see `services/cloudflare.ts`), but this redacts it defensively anyway
 * — a second line of defense so a secret can never leak into an API response or the UI even if a
 * future error path (or an unexpected fetch implementation) embeds it.
 */
function sanitizeErrorMessage(err: unknown, token: string | null): string {
  const raw = err instanceof Error ? err.message : String(err);
  const trimmedToken = token?.trim();
  const redacted = trimmedToken ? raw.split(trimmedToken).join('[redacted]') : raw;
  return redacted.length > MAX_MESSAGE_LENGTH ? `${redacted.slice(0, MAX_MESSAGE_LENGTH)}…` : redacted;
}

/**
 * Registers `GET /api/cloudflare/verify`. Sits under the global session guard in `buildApp`.
 *
 * Checks the STORED settings first, independent of dev mode: a missing, empty, or
 * whitespace-only `cloudflare_token`/`cloudflare_zone_id` is reported as `not_configured` without
 * ever calling `app.dns()` — this is what makes the route honest in dev mode too, since
 * `app.dns()` always returns a (possibly unconfigured) `FakeDnsClient` there rather than `null`.
 * Only once real credentials are on file does this delegate to `app.dns()`'s `verifyToken()`,
 * mapping its boolean result to `'ok'`/`'invalid_token'` and any thrown error to `'error'`. The
 * setup wizard's "Test connection" step (and any later re-check from Settings) both hit this same
 * route.
 */
export async function cloudflareRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/cloudflare/verify', async (): Promise<CloudflareVerifyResult> => {
    const token = getSetting<string>(app.db, 'cloudflare_token');
    const zoneId = getSetting<string>(app.db, 'cloudflare_zone_id');

    if (isBlankCredential(token) || isBlankCredential(zoneId)) {
      return { ok: false, reason: 'not_configured' };
    }

    const dns = app.dns();
    if (!dns) {
      // Defensive: settings say configured but dns() disagrees (e.g. a test double that ignores
      // settings). Never claim success without a real client to actually ask.
      return { ok: false, reason: 'not_configured' };
    }

    try {
      const ok = await dns.verifyToken();
      return ok ? { ok: true, reason: 'ok' } : { ok: false, reason: 'invalid_token' };
    } catch (err) {
      return { ok: false, reason: 'error', message: sanitizeErrorMessage(err, token) };
    }
  });
}
