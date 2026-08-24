/**
 * Task 5's audit query API: `GET /api/audit` (any authenticated member) lists/filters
 * `audit_events` with keyset pagination plus per-category counts for the Audit-log page's tab
 * pills, and `GET`/`PUT /api/audit/config` (PUT admin+) reads/writes the Task 2 `audit_enabled`/
 * `audit_retention_days` settings via `services/audit.ts`'s existing get/set helpers.
 */
import { and, count, desc, eq, gte, like, lt, or, type SQL } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { auditEvents } from '../db/schema.js';
import { requireRole } from '../lib/authz.js';
import { getActor, getAuditEnabled, getAuditRetentionDays, recordAudit, setAuditEnabled, setAuditRetentionDays } from '../services/audit.js';

/**
 * Query-filterable categories for the Audit-log page's tab pills (spec §1's Audit log row: "Page
 * with category tabs (All, Deployments, Projects, Databases, Team, Settings)"). Each maps to one or
 * more action NAMESPACES — the token before the first `.` in every `action` string, e.g.
 * `'deploy.trigger'`'s namespace is `'deploy'`.
 *
 * Every namespace any `recordAudit` call site in the codebase currently emits must appear in
 * exactly one of these arrays: `auth`, `cron`, `database`, `deploy`, `github`, `notification`,
 * `project`, `service`, `settings`, `user`, `worker`, `audit` (this route's own `audit.config`).
 * `test/audit-routes.test.ts`'s `categoryForAction: completeness` suite hardcodes every
 * currently-emitted action string and asserts each resolves to a category here — an action whose
 * namespace isn't listed below would be silently unreachable by every non-'all' tab filter.
 */
export const AUDIT_CATEGORIES = ['deployments', 'projects', 'databases', 'team', 'settings'] as const;
export type AuditCategory = (typeof AUDIT_CATEGORIES)[number];

const CATEGORY_NAMESPACES: Record<AuditCategory, readonly string[]> = {
  deployments: ['deploy'],
  projects: ['project', 'worker', 'cron'],
  databases: ['database'],
  team: ['user'],
  settings: ['settings', 'github', 'notification', 'audit', 'auth', 'service'],
};

/** The namespace (token before the first `.`) of an audit `action` string. */
function actionNamespace(action: string): string {
  return action.split('.')[0] ?? action;
}

/** Resolves an action string to its tab category, or `null` if its namespace isn't in
 * `CATEGORY_NAMESPACES` (should be unreachable for anything `recordAudit` actually emits — see the
 * module doc comment above). */
export function categoryForAction(action: string): AuditCategory | null {
  const namespace = actionNamespace(action);
  for (const category of AUDIT_CATEGORIES) {
    if (CATEGORY_NAMESPACES[category].includes(namespace)) return category;
  }
  return null;
}

/** `LIKE`-pattern condition matching every action whose namespace belongs to `category`. */
function categoryCondition(category: AuditCategory): SQL | undefined {
  return or(...CATEGORY_NAMESPACES[category].map((namespace) => like(auditEvents.action, `${namespace}.%`)));
}

const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 100;

const listQuerySchema = z.object({
  category: z.enum(['all', ...AUDIT_CATEGORIES]).optional(),
  q: z.string().min(1).optional(),
  actorId: z.coerce.number().int().optional(),
  since: z.coerce.number().int().optional(),
  cursor: z.coerce.number().int().optional(),
  limit: z.coerce.number().int().positive().optional(),
});

const RETENTION_DAYS_ENUM = z.union([z.literal(30), z.literal(90), z.literal(365)]);
const configPutSchema = z.object({
  enabled: z.boolean().optional(),
  retentionDays: RETENTION_DAYS_ENUM.optional(),
});

interface AuditEventDto {
  id: number;
  actorId: number | null;
  actorName: string;
  action: string;
  targetType: string;
  targetName: string;
  meta: unknown;
  createdAt: number;
}

function toDto(row: typeof auditEvents.$inferSelect): AuditEventDto {
  return {
    id: row.id,
    actorId: row.actorId,
    actorName: row.actorName,
    action: row.action,
    targetType: row.targetType,
    targetName: row.targetName,
    meta: row.meta !== null ? (JSON.parse(row.meta) as unknown) : null,
    createdAt: row.createdAt,
  };
}

/**
 * Registers `GET /api/audit` and `GET`/`PUT /api/audit/config` under the global session guard in
 * `buildApp`.
 */
export async function auditRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/audit', async (request, reply) => {
    const parsed = listQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid query' });
    }
    const { category = 'all', q, actorId, since, cursor } = parsed.data;
    const limit = Math.min(parsed.data.limit ?? DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);

    // Filters shared by the event list AND the per-category counts (spec: counts are "computed with
    // the same non-category filters" — i.e. everything except `category` itself and `cursor`, which
    // only ever applies to the paged list, never the pill totals).
    const nonCategoryConditions: (SQL | undefined)[] = [
      q ? or(like(auditEvents.action, `%${q}%`), like(auditEvents.targetName, `%${q}%`), like(auditEvents.actorName, `%${q}%`)) : undefined,
      actorId !== undefined ? eq(auditEvents.actorId, actorId) : undefined,
      since !== undefined ? gte(auditEvents.createdAt, since) : undefined,
    ];

    const listConditions = [...nonCategoryConditions, category !== 'all' ? categoryCondition(category) : undefined, cursor !== undefined ? lt(auditEvents.id, cursor) : undefined];

    // Fetch one extra row to know whether another page follows, without a separate COUNT query.
    const rows = app.db
      .select()
      .from(auditEvents)
      .where(and(...listConditions))
      .orderBy(desc(auditEvents.id))
      .limit(limit + 1)
      .all();

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor = hasMore ? (page[page.length - 1]?.id ?? null) : null;

    const counts = { all: 0 } as Record<'all' | AuditCategory, number>;
    for (const c of ['all', ...AUDIT_CATEGORIES] as const) {
      const countConditions = [...nonCategoryConditions, c !== 'all' ? categoryCondition(c) : undefined];
      const row = app.db
        .select({ n: count() })
        .from(auditEvents)
        .where(and(...countConditions))
        .get();
      counts[c] = row?.n ?? 0;
    }

    return { events: page.map(toDto), nextCursor, counts };
  });

  app.get('/api/audit/config', async () => {
    return { enabled: getAuditEnabled(app.db), retentionDays: getAuditRetentionDays(app.db) };
  });

  app.put('/api/audit/config', async (request, reply) => {
    if (!requireRole(request, reply, 'admin')) return;

    const parsed = configPutSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid request body' });
    }

    const changedKeys: string[] = [];
    if (parsed.data.enabled !== undefined) {
      setAuditEnabled(app.db, parsed.data.enabled);
      changedKeys.push('enabled');
    }
    if (parsed.data.retentionDays !== undefined) {
      setAuditRetentionDays(app.db, parsed.data.retentionDays);
      changedKeys.push('retentionDays');
    }

    if (changedKeys.length > 0) {
      // meta carries the changed KEYS only (mirrors settings.update's convention) — there's no
      // secret value here, but staying consistent keeps every settings-shaped audit row uniform.
      const actor = getActor(app.db, request.session.get('userId'));
      recordAudit(app.db, { ...actor, action: 'audit.config', targetType: 'settings', targetName: 'audit_config', meta: { keys: changedKeys } });
    }

    return { enabled: getAuditEnabled(app.db), retentionDays: getAuditRetentionDays(app.db) };
  });
}
