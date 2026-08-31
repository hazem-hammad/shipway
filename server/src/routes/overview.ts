/**
 * Task 5's Home-dashboard summary: `GET /api/overview` → {user, projects, deployments,
 * servicesDown, recentProjects}. `servicesDown` reads every `SYSTEM_UNITS` unit's LIVE status via
 * `app.sysops.systemUnitStatus` (not `servicewatch.ts`'s cached in-memory diff state — this
 * intentionally reflects "right now", the same way `GET /api/server/stats` does) and reuses
 * `servicewatch.ts`'s `isDown` classification, so "down" means exactly the same thing here as it
 * does for the `service_down`/`service_recovered` bus events. In dev mode `DevSysOps.
 * systemUnitStatus` always reports `'unknown'` (see `sysops/dev.ts`) — which `isDown` doesn't count
 * as down — so `servicesDown` naturally comes back `[]` there, matching the spec's "in devMode all
 * 'unknown' -> empty".
 */
import { count, desc, eq, inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { deployments, projects, users } from '../db/schema.js';
import { accessibleProjectIds } from '../lib/projectaccess.js';
import { isDown } from '../services/servicewatch.js';
import { SERVICE_NAMES } from '../services/stats.js';
import { SYSTEM_UNITS } from '../sysops/types.js';

/** `recentProjects` shows at most this many, top by latest deployment then `createdAt`. */
const RECENT_PROJECTS_LIMIT = 5;

type ProjectRow = typeof projects.$inferSelect;
interface LastDeployment {
  id: number;
  status: (typeof deployments.$inferSelect)['status'];
  finishedAt: number | null;
}

/**
 * Registers `GET /api/overview` under the global session guard in `buildApp`.
 */
export async function overviewRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/overview', async (request, reply) => {
    const userId = request.session.get('userId');
    const user = userId === undefined ? undefined : app.db.select({ name: users.name }).from(users).where(eq(users.id, userId)).get();
    if (!user) {
      return reply.code(401).send({ error: 'unauthorized' });
    }

    // Every count and list below is scoped to the projects this user can actually open (see
    // `lib/projectaccess.ts`) — a Home dashboard that counted projects a member can't reach would
    // send them clicking at 404s. `null` is unscoped and counts everything, as before.
    const allowed = accessibleProjectIds(app.db, userId);
    const projectScope = allowed === null ? undefined : inArray(projects.id, allowed.size > 0 ? [...allowed] : [-1]);
    const deploymentScope = allowed === null ? undefined : inArray(deployments.projectId, allowed.size > 0 ? [...allowed] : [-1]);

    const projectsCount = app.db.select({ n: count() }).from(projects).where(projectScope).get()?.n ?? 0;
    const deploymentsCount = app.db.select({ n: count() }).from(deployments).where(deploymentScope).get()?.n ?? 0;

    const servicesDown: string[] = [];
    for (const unit of SYSTEM_UNITS) {
      const status = await app.sysops.systemUnitStatus(unit);
      if (isDown(status)) {
        servicesDown.push(SERVICE_NAMES[unit]);
      }
    }

    // "top 5 by latest deployment then createdAt": each project's most recent deployment id acts as
    // its recency key (ids are assigned in insertion/chronological order throughout this codebase —
    // see e.g. `routes/deployments.ts`'s global list, also ordered `desc(deployments.id)`); a
    // project with no deployment at all sorts after every project that has one, falling back to
    // `createdAt` both as that fallback ordering and as the tiebreak within it.
    const allProjects = app.db.select().from(projects).where(projectScope).all();
    const withLastDeployment: { project: ProjectRow; last: LastDeployment | null }[] = allProjects.map((project) => {
      const last =
        app.db
          .select({ id: deployments.id, status: deployments.status, finishedAt: deployments.finishedAt })
          .from(deployments)
          .where(eq(deployments.projectId, project.id))
          .orderBy(desc(deployments.id))
          .limit(1)
          .get() ?? null;
      return { project, last };
    });

    withLastDeployment.sort((a, b) => {
      if (a.last && b.last) return b.last.id - a.last.id;
      if (a.last) return -1;
      if (b.last) return 1;
      return b.project.createdAt - a.project.createdAt;
    });

    const recentProjects = withLastDeployment.slice(0, RECENT_PROJECTS_LIMIT).map(({ project, last }) => ({
      id: project.id,
      name: project.name,
      slug: project.slug,
      type: project.type,
      lastDeployment: last ? { status: last.status, finishedAt: last.finishedAt } : null,
    }));

    return {
      user: { name: user.name },
      projects: projectsCount,
      deployments: deploymentsCount,
      servicesDown,
      recentProjects,
    };
  });
}
