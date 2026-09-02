/**
 * Folders: `/api/folders` CRUD, the grouping the Projects page files projects under.
 *
 * A folder is one product made of several Shipway projects — "brandspace" is a Nest backend, a
 * Next dashboard and a marketing site, three repos and three subdomains that the list had no way
 * of showing as related. See `db/schema.ts`'s `folders` for what a folder deliberately is not: it
 * is a label, never an access boundary.
 *
 * Reads are open to any signed-in user, with the same per-project scoping the Projects page itself
 * applies — a scoped member's folder counts describe the projects THEY can see, so a count can
 * never leak the existence of a project they were not granted (`lib/projectaccess.ts`). Writes are
 * admin+: a folder is instance-wide filing, and a member who can see three projects has no
 * business restructuring how everyone else's list is organised.
 *
 * Putting a project INTO a folder is not here — it is `folderId` on `PATCH /api/projects/:id`,
 * which is already guarded per project. So a member can file the projects they hold; only an admin
 * can invent or remove the folders themselves.
 */
import { eq, inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { folders, projects } from '../db/schema.js';
import { requireRole } from '../lib/authz.js';
import { accessibleProjectIds } from '../lib/projectaccess.js';
import { getActor, recordAudit } from '../services/audit.js';

const folderIdParamsSchema = z.object({ id: z.coerce.number().int() });

/** Long enough for "Brandspace — internal tooling", short enough that a card can render it. */
const MAX_NAME_LENGTH = 60;

const nameSchema = z.string().trim().min(1).max(MAX_NAME_LENGTH);
const createFolderSchema = z.object({ name: nameSchema });
const updateFolderSchema = z.object({ name: nameSchema });

export interface FolderSummary {
  id: number;
  name: string;
  slug: string;
  createdAt: number;
  /** How many projects THIS caller can see in the folder — not how many are in it. */
  projectCount: number;
}

/**
 * `"Brandspace Backend"` -> `"brandspace-backend"`. Anything that is not a letter, digit or hyphen
 * becomes a hyphen, runs collapse, and the ends are trimmed — the same shape `SLUG_RE` enforces on
 * project slugs, so a folder slug is always safe in a URL.
 *
 * A name of nothing but punctuation ("!!!") slugifies to an empty string, which is why the caller
 * falls back to a generated slug rather than trusting this to always produce one.
 */
export function slugifyFolderName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

/**
 * The first of `base`, `base-2`, `base-3`, … that no folder is using. Two folders can share a
 * display name (nothing stops "Internal" twice) but never a slug, because the slug is the URL.
 */
function uniqueFolderSlug(app: FastifyInstance, base: string): string {
  const taken = new Set(
    app.db
      .select({ slug: folders.slug })
      .from(folders)
      .all()
      .map((row) => row.slug),
  );
  if (!taken.has(base)) return base;
  for (let n = 2; ; n += 1) {
    const candidate = `${base}-${String(n)}`;
    if (!taken.has(candidate)) return candidate;
  }
}

export async function folderRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Every folder, with the number of projects the caller can see in each. Ordered by name so the
   * cards on the Projects page are in a stable, findable order rather than creation order.
   */
  app.get('/api/folders', async (request) => {
    const allowed = accessibleProjectIds(app.db, request.session.get('userId'));

    const counts = new Map<number, number>();
    for (const row of app.db.select({ id: projects.id, folderId: projects.folderId }).from(projects).all()) {
      if (row.folderId === null) continue;
      if (allowed !== null && !allowed.has(row.id)) continue;
      counts.set(row.folderId, (counts.get(row.folderId) ?? 0) + 1);
    }

    return app.db
      .select()
      .from(folders)
      .all()
      .map((folder): FolderSummary => ({ ...folder, projectCount: counts.get(folder.id) ?? 0 }))
      .sort((a, b) => a.name.localeCompare(b.name));
  });

  app.post('/api/folders', async (request, reply) => {
    if (!requireRole(request, reply, 'admin')) return;

    const parsed = createFolderSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'a folder name is required' });
    }
    const { name } = parsed.data;

    // `folder-<n>` for a name with nothing sluggable in it, so the URL identity always exists.
    const base = slugifyFolderName(name);
    const slug = uniqueFolderSlug(app, base === '' ? 'folder' : base);

    const created = app.db.insert(folders).values({ name, slug }).returning().get();

    const actor = getActor(app.db, request.session.get('userId'));
    recordAudit(app.db, { ...actor, action: 'folder.create', targetType: 'folder', targetName: created.name });

    return reply.code(201).send({ ...created, projectCount: 0 } satisfies FolderSummary);
  });

  /**
   * Renames a folder. The slug is deliberately NOT recomputed: it is the `?folder=` in every link
   * anyone has already shared or bookmarked, and a rename is a change of label, not of identity.
   */
  app.patch('/api/folders/:id', async (request, reply) => {
    if (!requireRole(request, reply, 'admin')) return;

    const params = folderIdParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(404).send({ error: 'folder not found' });
    }
    const parsed = updateFolderSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'a folder name is required' });
    }

    const existing = app.db.select().from(folders).where(eq(folders.id, params.data.id)).get();
    if (!existing) {
      return reply.code(404).send({ error: 'folder not found' });
    }

    app.db.update(folders).set({ name: parsed.data.name }).where(eq(folders.id, existing.id)).run();

    const actor = getActor(app.db, request.session.get('userId'));
    recordAudit(app.db, {
      ...actor,
      action: 'folder.update',
      targetType: 'folder',
      targetName: parsed.data.name,
      meta: { from: existing.name },
    });

    const count = app.db.select({ id: projects.id }).from(projects).where(eq(projects.folderId, existing.id)).all().length;
    return { ...existing, name: parsed.data.name, projectCount: count } satisfies FolderSummary;
  });

  /**
   * Deletes a folder. The projects inside it are emptied out to ungrouped, never deleted — the
   * column's `ON DELETE SET NULL` would do this on its own, but it is done explicitly first so the
   * behaviour is stated in the code rather than resting on a constraint two files away, and so the
   * audit entry can report how many projects were let go.
   */
  app.delete('/api/folders/:id', async (request, reply) => {
    if (!requireRole(request, reply, 'admin')) return;

    const params = folderIdParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(404).send({ error: 'folder not found' });
    }

    const existing = app.db.select().from(folders).where(eq(folders.id, params.data.id)).get();
    if (!existing) {
      return reply.code(404).send({ error: 'folder not found' });
    }

    const contained = app.db.select({ id: projects.id }).from(projects).where(eq(projects.folderId, existing.id)).all();
    if (contained.length > 0) {
      app.db
        .update(projects)
        .set({ folderId: null })
        .where(
          inArray(
            projects.id,
            contained.map((row) => row.id),
          ),
        )
        .run();
    }
    app.db.delete(folders).where(eq(folders.id, existing.id)).run();

    const actor = getActor(app.db, request.session.get('userId'));
    recordAudit(app.db, {
      ...actor,
      action: 'folder.delete',
      targetType: 'folder',
      targetName: existing.name,
      meta: { releasedProjects: contained.length },
    });

    return reply.code(204).send();
  });
}
