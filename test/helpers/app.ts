import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { closeDb } from '../../src/infra/db.js';
import { closeRedis } from '../../src/infra/redis.js';
import { resetEnvCache } from '../../src/config/env.js';
import { closeTestDb } from './pg.js';

export async function startApp(): Promise<FastifyInstance> {
  resetEnvCache();
  const app = await buildApp();
  await app.ready();
  return app;
}

export async function stopApp(app: FastifyInstance): Promise<void> {
  await app.close();
  await closeDb();
  await closeRedis();
  await closeTestDb();
}
