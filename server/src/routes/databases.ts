import { randomBytes } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { databases, projects } from '../db/schema.js';
import { getSetting } from '../db/settings.js';
import { connectionEnv, IDENTIFIER_RE } from '../services/dbprovision.js';

const idParamsSchema = z.object({ id: z.coerce.number().int() });

const createDatabaseSchema = z.object({
  engine: z.enum(['mysql', 'postgres']),
  name: z.string().regex(IDENTIFIER_RE),
  projectId: z.number().int().optional(),
});

const deleteBodySchema = z.object({ confirmName: z.string() });

const injectBodySchema = z.object({ projectId: z.number().int() });

/** Chars used for generated database passwords: letters + digits only (safe to embed unquoted in most contexts, and matches the brief's `[A-Za-z0-9]` spec). */
const PASSWORD_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const PASSWORD_LENGTH = 24;

/** Generates a random `PASSWORD_LENGTH`-char password from `PASSWORD_CHARS`, using `randomBytes` for entropy. */
function generatePassword(): string {
  const bytes = randomBytes(PASSWORD_LENGTH);
  let out = '';
  for (let i = 0; i < PASSWORD_LENGTH; i++) {
    out += PASSWORD_CHARS[bytes[i]! % PASSWORD_CHARS.length];
  }
  return out;
}

function toErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Matches a `KEY=` assignment at the start of a line (leading whitespace allowed); comments never match. */
const ENV_KEY_RE = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/;

/** Collects the set of keys already assigned in `text` (comments ignored), mirroring `deploy/envfile.ts`. */
function definedEnvKeys(text: string): Set<string> {
  const keys = new Set<string>();
  for (const line of text.split('\n')) {
    const m = ENV_KEY_RE.exec(line);
    if (m) {
      keys.add(m[1] as string);
    }
  }
  return keys;
}

/**
 * Appends the `DB_*` vars for `db` to `envText` under a `# added by shipway` comment, skipping any
 * key `envText` already defines (line-start `KEY=` match). Returns `envText` unchanged if every key
 * is already defined. Unlike `deploy/envfile.ts`'s managed block, this is a one-time append (no
 * strip-and-regenerate) — the injected lines become ordinary user-owned env text from then on.
 */
function appendConnectionEnv(envText: string, engine: 'mysql' | 'postgres', db: { name: string; username: string; password: string }): string {
  const alreadyDefined = definedEnvKeys(envText);
  const entries = Object.entries(connectionEnv(engine, db)).filter(([key]) => !alreadyDefined.has(key));
  if (entries.length === 0) {
    return envText;
  }

  const lines = [`# added by shipway — database ${db.name}`, ...entries.map(([key, value]) => `${key}=${value}`)];
  const base = envText === '' ? '' : envText.endsWith('\n') ? envText : `${envText}\n`;
  const separator = base === '' ? '' : '\n';
  return `${base}${separator}${lines.join('\n')}\n`;
}

/**
 * Registers `/api/databases` CRUD + credential reveal + env injection, plus `/api/services/info`.
 * All routes here sit under the global session guard in `buildApp`.
 */
export async function databaseRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/databases', async () => {
    return app.db
      .select({
        id: databases.id,
        projectId: databases.projectId,
        engine: databases.engine,
        name: databases.name,
        username: databases.username,
        createdAt: databases.createdAt,
        projectName: projects.name,
      })
      .from(databases)
      .leftJoin(projects, eq(databases.projectId, projects.id))
      .all();
  });

  app.post('/api/databases', async (request, reply) => {
    const parsed = createDatabaseSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid request body' });
    }
    const { engine, name, projectId } = parsed.data;

    if (projectId !== undefined) {
      const project = app.db.select({ id: projects.id }).from(projects).where(eq(projects.id, projectId)).get();
      if (!project) {
        return reply.code(404).send({ error: 'project not found' });
      }
    }

    const existing = app.db
      .select({ id: databases.id })
      .from(databases)
      .where(and(eq(databases.name, name), eq(databases.engine, engine)))
      .get();
    if (existing) {
      return reply.code(409).send({ error: 'a database with this name already exists for this engine' });
    }

    const username = name;
    const password = generatePassword();

    try {
      await app.dbAdmin.createDatabase(engine, name, username, password);
    } catch (err) {
      return reply.code(502).send({ error: 'database provisioning failed', detail: toErrorMessage(err) });
    }

    const passwordEncrypted = app.secretBox.encrypt(password);
    app.db
      .insert(databases)
      .values({ projectId: projectId ?? null, engine, name, username, passwordEncrypted })
      .run();

    const created = app.db
      .select({ id: databases.id })
      .from(databases)
      .where(and(eq(databases.name, name), eq(databases.engine, engine)))
      .get();
    if (!created) {
      return reply.code(500).send({ error: 'failed to create database' });
    }

    // The ONE time the plaintext password is ever returned — every other read (GET
    // /api/databases, /:id/credentials) either omits it or requires a separate decrypt.
    return reply.code(201).send({ id: created.id, engine, name, username, password });
  });

  app.get('/api/databases/:id/credentials', async (request, reply) => {
    const paramsParsed = idParamsSchema.safeParse(request.params);
    if (!paramsParsed.success) {
      return reply.code(404).send({ error: 'database not found' });
    }

    const row = app.db.select().from(databases).where(eq(databases.id, paramsParsed.data.id)).get();
    if (!row) {
      return reply.code(404).send({ error: 'database not found' });
    }

    const password = app.secretBox.decrypt(row.passwordEncrypted);
    return {
      username: row.username,
      password,
      env: connectionEnv(row.engine, { name: row.name, username: row.username, password }),
    };
  });

  app.delete('/api/databases/:id', async (request, reply) => {
    const paramsParsed = idParamsSchema.safeParse(request.params);
    if (!paramsParsed.success) {
      return reply.code(404).send({ error: 'database not found' });
    }
    const { id } = paramsParsed.data;

    const bodyParsed = deleteBodySchema.safeParse(request.body);
    if (!bodyParsed.success) {
      return reply.code(400).send({ error: 'invalid request body' });
    }

    const row = app.db.select().from(databases).where(eq(databases.id, id)).get();
    if (!row) {
      return reply.code(404).send({ error: 'database not found' });
    }

    if (bodyParsed.data.confirmName !== row.name) {
      return reply.code(400).send({ error: 'confirmName does not match the database name' });
    }

    try {
      await app.dbAdmin.dropDatabase(row.engine, row.name, row.username);
    } catch (err) {
      return reply.code(502).send({ error: 'database deprovisioning failed', detail: toErrorMessage(err) });
    }

    app.db.delete(databases).where(eq(databases.id, id)).run();

    return reply.code(204).send();
  });

  app.post('/api/databases/:id/inject', async (request, reply) => {
    const paramsParsed = idParamsSchema.safeParse(request.params);
    if (!paramsParsed.success) {
      return reply.code(404).send({ error: 'database not found' });
    }

    const dbRow = app.db.select().from(databases).where(eq(databases.id, paramsParsed.data.id)).get();
    if (!dbRow) {
      return reply.code(404).send({ error: 'database not found' });
    }

    const bodyParsed = injectBodySchema.safeParse(request.body);
    if (!bodyParsed.success) {
      return reply.code(400).send({ error: 'invalid request body' });
    }

    const project = app.db
      .select({ id: projects.id, envEncrypted: projects.envEncrypted })
      .from(projects)
      .where(eq(projects.id, bodyParsed.data.projectId))
      .get();
    if (!project) {
      return reply.code(404).send({ error: 'project not found' });
    }

    const currentEnv = project.envEncrypted ? app.secretBox.decrypt(project.envEncrypted) : '';
    const password = app.secretBox.decrypt(dbRow.passwordEncrypted);
    const nextEnv = appendConnectionEnv(currentEnv, dbRow.engine, { name: dbRow.name, username: dbRow.username, password });

    app.db
      .update(projects)
      .set({ envEncrypted: app.secretBox.encrypt(nextEnv) })
      .where(eq(projects.id, project.id))
      .run();

    return reply.code(204).send();
  });
}

interface RedisInfo {
  host: string;
  port: number;
  password?: string;
}

interface MailpitInfo {
  smtpHost: string;
  smtpPort: number;
  webUrl: string;
}

/** Registers `GET /api/services/info` — connection info for the shared redis/mailpit instances. */
export async function servicesRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/services/info', async () => {
    return {
      redis: getSetting<RedisInfo>(app.db, 'redis_info'),
      mailpit: getSetting<MailpitInfo>(app.db, 'mailpit_info'),
    };
  });
}
