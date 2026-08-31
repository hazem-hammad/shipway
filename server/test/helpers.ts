/**
 * Shared test fixtures for building an authenticated test app across roles. Individual test files
 * still keep their own local `sessionCookie`/`ADMIN` copies where that predates this file (see e.g.
 * `auth.test.ts`) — this module exists so *new* Task 2+ tests (role matrix, audit wiring, migration)
 * don't have to hand-roll yet another copy, and so `createMember`/`createAdmin` fixtures (which need
 * to poke the db directly, since there's no role-assigning API yet — see Task 3) live in one place.
 */
import { eq } from 'drizzle-orm';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { users } from '../src/db/schema.js';
import { setSetting } from '../src/db/settings.js';
import { hashPassword } from '../src/lib/passwords.js';

export type BuildAppDeps = Parameters<typeof buildApp>[1];

/** A fresh, throwaway data directory for one test app instance. */
export function tmpDataDir(prefix = 'shipway-test-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Extracts the `name=value` pair from a response's Set-Cookie header, for reuse in later injects. */
export function sessionCookie(res: LightMyRequestResponse): string {
  const raw = res.headers['set-cookie'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value || typeof value !== 'string') {
    throw new Error('expected a set-cookie header in the response');
  }
  return value.split(';')[0]!;
}

export const OWNER_CREDENTIALS = { name: 'Ada Lovelace', email: 'ada@example.com', password: 'correct-horse-battery' };

/**
 * Builds a `buildApp()` instance against a fresh temp data dir/dev-mode config, with the host's own
 * database engines configured the way `install.sh` leaves a real one.
 *
 * Those two settings are what make `local:mysql` / `local:postgres` exist as connections
 * (`services/dbconnections.ts`), and without them the database routes correctly refuse to provision
 * anything. A host that can't take a database is a specific thing to test, not the baseline — the
 * suites that want it set their own settings instead of using this helper.
 */
export async function buildTestApp(deps: BuildAppDeps = {}): Promise<FastifyInstance> {
  const cfg = loadConfig({ SHIPWAY_DEV: '1', SHIPWAY_DATA_DIR: tmpDataDir() });
  const app = await buildApp(cfg, deps);
  setSetting(app.db, 'mysql_admin_url', 'mysql://shipway_admin:test-only@127.0.0.1:3306');
  setSetting(app.db, 'postgres_admin_url', 'postgres://shipway_admin:test-only@127.0.0.1:5432/postgres');
  return app;
}

export interface AuthedApp {
  app: FastifyInstance;
  cookie: string;
  userId: number;
}

/**
 * Builds an app and creates the very first user via `POST /api/setup/admin` — which is always
 * created as `'owner'` directly (see `routes/auth.ts`) — returning a ready-to-use session cookie.
 */
export async function buildOwnerApp(deps: BuildAppDeps = {}): Promise<AuthedApp> {
  const app = await buildTestApp(deps);
  const create = await app.inject({ method: 'POST', url: '/api/setup/admin', payload: OWNER_CREDENTIALS });
  const cookie = sessionCookie(create);
  const userId = (create.json() as { id: number }).id;
  return { app, cookie, userId };
}

let fixtureCounter = 0;

async function createUserWithRole(
  app: FastifyInstance,
  role: 'member' | 'admin' | 'owner',
  overrides: Partial<{ name: string; email: string; password: string }>,
): Promise<AuthedApp> {
  fixtureCounter += 1;
  const name = overrides.name ?? `Fixture ${role} ${fixtureCounter}`;
  const email = overrides.email ?? `fixture-${fixtureCounter}-${role}@example.com`;
  const password = overrides.password ?? 'fixture-password-123';

  const passwordHash = await hashPassword(password);
  // Inserted directly: Task 2 has no route that assigns a role at creation time (that's Task 3's
  // invite/`PATCH /api/users/:id/role` flow) — every user created through the API today defaults to
  // 'member' (see schema.ts), so an 'admin' fixture has to be seeded straight into the db.
  app.db.insert(users).values({ name, email, passwordHash, role }).run();
  const row = app.db.select({ id: users.id }).from(users).where(eq(users.email, email)).get();
  if (!row) {
    throw new Error('createUserWithRole: failed to insert fixture user');
  }

  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password } });
  if (login.statusCode !== 200) {
    throw new Error(`createUserWithRole: fixture login failed (${login.statusCode}): ${login.body}`);
  }

  return { app, cookie: sessionCookie(login), userId: row.id };
}

/** Seeds a plain 'member' user directly into `app`'s db and logs them in. Requires `app` to already
 * have at least the owner set up (so this isn't the first-ever user — see `buildOwnerApp`). */
export async function createMember(
  app: FastifyInstance,
  overrides: Partial<{ name: string; email: string; password: string }> = {},
): Promise<AuthedApp> {
  return createUserWithRole(app, 'member', overrides);
}

/** Seeds an 'admin' user directly into `app`'s db and logs them in. */
export async function createAdmin(
  app: FastifyInstance,
  overrides: Partial<{ name: string; email: string; password: string }> = {},
): Promise<AuthedApp> {
  return createUserWithRole(app, 'admin', overrides);
}
