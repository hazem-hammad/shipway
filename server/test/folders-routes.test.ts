/**
 * `/api/folders` — the grouping the Projects page files projects under, plus the `folderId` end of
 * `POST`/`PATCH /api/projects`.
 *
 * The behaviour worth pinning down is mostly about what a folder is NOT: it is not a container that
 * owns its projects (deleting it lets them go rather than taking them with it), and it is not an
 * access boundary (its counts describe what the caller can already see). The slug rules matter for
 * the same reason the project slug rules do — it is the URL a folder view is linked by.
 */
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { folders, projects } from '../src/db/schema.js';
import { slugifyFolderName } from '../src/routes/folders.js';
import { buildOwnerApp, createMember } from './helpers.js';

interface FolderBody {
  id: number;
  name: string;
  slug: string;
  projectCount: number;
}

/** A project row written straight to the db: creating one through the API provisions nginx/DNS,
 * which none of these tests are about. */
function seedProject(app: FastifyInstance, slug: string, folderId: number | null): number {
  app.db
    .insert(projects)
    .values({ name: slug, slug, repo: `acme/${slug}`, branch: 'main', type: 'static', folderId })
    .run();
  const row = app.db.select({ id: projects.id }).from(projects).where(eq(projects.slug, slug)).get();
  if (!row) throw new Error(`seedProject: ${slug} was not inserted`);
  return row.id;
}

async function createFolder(app: FastifyInstance, cookie: string, name: string): Promise<FolderBody> {
  const res = await app.inject({ method: 'POST', url: '/api/folders', headers: { cookie }, payload: { name } });
  expect(res.statusCode).toBe(201);
  return res.json() as FolderBody;
}

describe('slugifyFolderName', () => {
  it('lowercases, collapses runs of punctuation to single hyphens, and trims the ends', () => {
    expect(slugifyFolderName('Brandspace')).toBe('brandspace');
    expect(slugifyFolderName('Brandspace — Internal Tools')).toBe('brandspace-internal-tools');
    expect(slugifyFolderName('  Acme  //  Web  ')).toBe('acme-web');
  });

  it('returns an empty string for a name with nothing sluggable in it', () => {
    // Which is exactly why POST falls back to a generated slug rather than trusting this.
    expect(slugifyFolderName('!!!')).toBe('');
  });
});

describe('POST /api/folders', () => {
  it('creates a folder with a slug derived from the name (201)', async () => {
    const { app, cookie } = await buildOwnerApp();

    const body = await createFolder(app, cookie, 'Brandspace');

    expect(body).toMatchObject({ name: 'Brandspace', slug: 'brandspace', projectCount: 0 });
  });

  it('gives a second folder of the same name a distinct slug, since the slug is the URL', async () => {
    const { app, cookie } = await buildOwnerApp();

    const first = await createFolder(app, cookie, 'Brandspace');
    const second = await createFolder(app, cookie, 'Brandspace');

    expect(first.slug).toBe('brandspace');
    expect(second.slug).toBe('brandspace-2');
    expect(second.name).toBe('Brandspace');
  });

  it('falls back to a generated slug when the name slugifies to nothing', async () => {
    const { app, cookie } = await buildOwnerApp();

    const body = await createFolder(app, cookie, '!!!');

    expect(body.slug).toBe('folder');
  });

  it('rejects an empty name (400)', async () => {
    const { app, cookie } = await buildOwnerApp();

    const res = await app.inject({ method: 'POST', url: '/api/folders', headers: { cookie }, payload: { name: '   ' } });

    expect(res.statusCode).toBe(400);
  });

  it('is admin-only — a member cannot restructure everyone else’s list (403)', async () => {
    const { app, cookie } = await buildOwnerApp();
    const member = await createMember(app);

    const res = await app.inject({ method: 'POST', url: '/api/folders', headers: { cookie: member.cookie }, payload: { name: 'Brandspace' } });

    expect(res.statusCode).toBe(403);
    expect(app.db.select().from(folders).all()).toHaveLength(0);
    // Reading is not gated: a member has to be able to see the folder their projects are in.
    const list = await app.inject({ method: 'GET', url: '/api/folders', headers: { cookie: member.cookie } });
    expect(list.statusCode).toBe(200);
    void cookie;
  });
});

describe('GET /api/folders', () => {
  it('lists folders by name with the number of projects in each', async () => {
    const { app, cookie } = await buildOwnerApp();
    const brandspace = await createFolder(app, cookie, 'Brandspace');
    await createFolder(app, cookie, 'Acme');

    seedProject(app, 'brandspace-backend', brandspace.id);
    seedProject(app, 'brandspace-website', brandspace.id);
    seedProject(app, 'loose-end', null);

    const res = await app.inject({ method: 'GET', url: '/api/folders', headers: { cookie } });

    expect(res.statusCode).toBe(200);
    const body = res.json() as FolderBody[];
    expect(body.map((folder) => [folder.name, folder.projectCount])).toEqual([
      ['Acme', 0],
      ['Brandspace', 2],
    ]);
  });

  it('counts only the projects the caller can see, so a count can’t leak one they weren’t granted', async () => {
    const { app, cookie } = await buildOwnerApp();
    const folder = await createFolder(app, cookie, 'Brandspace');
    const granted = seedProject(app, 'brandspace-backend', folder.id);
    seedProject(app, 'brandspace-secret', folder.id);

    const member = await createMember(app);
    const scope = await app.inject({
      method: 'PUT',
      url: `/api/users/${String(member.userId)}/projects`,
      headers: { cookie },
      payload: { projectAccess: 'selected', projectIds: [granted] },
    });
    expect(scope.statusCode).toBe(200);

    const asOwner = (await app.inject({ method: 'GET', url: '/api/folders', headers: { cookie } })).json() as FolderBody[];
    const asMember = (await app.inject({ method: 'GET', url: '/api/folders', headers: { cookie: member.cookie } })).json() as FolderBody[];

    expect(asOwner[0]?.projectCount).toBe(2);
    expect(asMember[0]?.projectCount).toBe(1);
  });
});

describe('PATCH /api/folders/:id', () => {
  it('renames a folder and leaves the slug alone, so existing links keep working', async () => {
    const { app, cookie } = await buildOwnerApp();
    const folder = await createFolder(app, cookie, 'Brandspace');

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/folders/${String(folder.id)}`,
      headers: { cookie },
      payload: { name: 'Brandspace Group' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ name: 'Brandspace Group', slug: 'brandspace' });
  });

  it('404s on a folder that does not exist', async () => {
    const { app, cookie } = await buildOwnerApp();

    const res = await app.inject({ method: 'PATCH', url: '/api/folders/999', headers: { cookie }, payload: { name: 'Nope' } });

    expect(res.statusCode).toBe(404);
  });
});

describe('DELETE /api/folders/:id', () => {
  it('ungroups the projects inside it rather than deleting them (204)', async () => {
    const { app, cookie } = await buildOwnerApp();
    const folder = await createFolder(app, cookie, 'Brandspace');
    const backend = seedProject(app, 'brandspace-backend', folder.id);
    const website = seedProject(app, 'brandspace-website', folder.id);

    const res = await app.inject({ method: 'DELETE', url: `/api/folders/${String(folder.id)}`, headers: { cookie } });

    expect(res.statusCode).toBe(204);
    expect(app.db.select().from(folders).all()).toHaveLength(0);
    const rows = app.db.select({ id: projects.id, folderId: projects.folderId }).from(projects).all();
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.folderId === null)).toBe(true);
    expect(rows.map((row) => row.id).sort()).toEqual([backend, website].sort());
  });

  it('is admin-only (403)', async () => {
    const { app, cookie } = await buildOwnerApp();
    const folder = await createFolder(app, cookie, 'Brandspace');
    const member = await createMember(app);

    const res = await app.inject({ method: 'DELETE', url: `/api/folders/${String(folder.id)}`, headers: { cookie: member.cookie } });

    expect(res.statusCode).toBe(403);
    expect(app.db.select().from(folders).all()).toHaveLength(1);
  });
});

describe('project folderId', () => {
  it('files a project into a folder and back out again via PATCH', async () => {
    const { app, cookie } = await buildOwnerApp();
    const folder = await createFolder(app, cookie, 'Brandspace');
    const id = seedProject(app, 'brandspace-backend', null);

    const into = await app.inject({
      method: 'PATCH',
      url: `/api/projects/${String(id)}`,
      headers: { cookie },
      payload: { folderId: folder.id },
    });
    expect(into.statusCode).toBe(200);
    expect((into.json() as { folderId: number | null }).folderId).toBe(folder.id);

    const out = await app.inject({
      method: 'PATCH',
      url: `/api/projects/${String(id)}`,
      headers: { cookie },
      payload: { folderId: null },
    });
    expect(out.statusCode).toBe(200);
    expect((out.json() as { folderId: number | null }).folderId).toBeNull();
  });

  it('rejects a folderId that names no folder with a 400, not a foreign-key 500', async () => {
    const { app, cookie } = await buildOwnerApp();
    const id = seedProject(app, 'brandspace-backend', null);

    const res = await app.inject({ method: 'PATCH', url: `/api/projects/${String(id)}`, headers: { cookie }, payload: { folderId: 4242 } });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'folder not found' });
  });

  it('is reported on the projects list, so the page can group without a second request', async () => {
    const { app, cookie } = await buildOwnerApp();
    const folder = await createFolder(app, cookie, 'Brandspace');
    seedProject(app, 'brandspace-backend', folder.id);

    const res = await app.inject({ method: 'GET', url: '/api/projects', headers: { cookie } });

    expect(res.statusCode).toBe(200);
    expect((res.json() as { slug: string; folderId: number | null }[])[0]).toMatchObject({
      slug: 'brandspace-backend',
      folderId: folder.id,
    });
  });
});
