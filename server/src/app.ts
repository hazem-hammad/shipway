import Fastify, { type FastifyInstance } from 'fastify';
import type { Config } from './config.js';

export async function buildApp(cfg: Config): Promise<FastifyInstance> {
  const app = Fastify({
    logger: cfg.devMode,
  });

  app.get('/api/health', async () => {
    return { status: 'ok' };
  });

  return app;
}
