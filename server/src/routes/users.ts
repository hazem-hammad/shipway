import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { users } from '../db/schema.js';
import { hashPassword } from '../lib/passwords.js';

const createUserSchema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  password: z.string().min(8),
});

const userIdParamsSchema = z.object({
  id: z.coerce.number().int(),
});

/** Shape returned to clients: never leaks `passwordHash`. */
function toPublicUser(user: { id: number; name: string; email: string; createdAt: number }) {
  return { id: user.id, name: user.name, email: user.email, createdAt: user.createdAt };
}

/**
 * Registers `/api/users` CRUD. All routes here sit under the global session guard in `buildApp`
 * (not one of the public `/api/auth/`, `/api/setup/`, `/api/webhooks/`, `/api/health` paths), so
 * every handler can assume `request.session.get('userId')` is defined.
 */
export async function userRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/users', async () => {
    const all = app.db.select().from(users).all();
    return all.map(toPublicUser);
  });

  app.post('/api/users', async (request, reply) => {
    const parsed = createUserSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid request body' });
    }

    const { name, email, password } = parsed.data;

    const existing = app.db.select({ id: users.id }).from(users).where(eq(users.email, email)).get();
    if (existing) {
      return reply.code(409).send({ error: 'email already in use' });
    }

    const passwordHash = await hashPassword(password);
    app.db.insert(users).values({ name, email, passwordHash }).run();
    const created = app.db.select().from(users).where(eq(users.email, email)).get();
    if (!created) {
      // Should be unreachable: we just inserted this row inside this handler.
      return reply.code(500).send({ error: 'failed to create user' });
    }

    return reply.code(201).send(toPublicUser(created));
  });

  app.delete('/api/users/:id', async (request, reply) => {
    const parsedParams = userIdParamsSchema.safeParse(request.params);
    if (!parsedParams.success) {
      return reply.code(404).send({ error: 'user not found' });
    }
    const { id } = parsedParams.data;

    const sessionUserId = request.session.get('userId');
    if (sessionUserId !== undefined && id === sessionUserId) {
      return reply.code(403).send({ error: 'cannot delete your own account' });
    }

    const existing = app.db.select({ id: users.id }).from(users).where(eq(users.id, id)).get();
    if (!existing) {
      return reply.code(404).send({ error: 'user not found' });
    }

    app.db.delete(users).where(eq(users.id, id)).run();
    return reply.code(204).send();
  });
}
