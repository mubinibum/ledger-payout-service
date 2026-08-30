import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { buildServices, type Services } from '../../src/composition.js';
import { getDb, closeDb } from '../../src/infra/db.js';
import { closeRedis } from '../../src/infra/redis.js';
import { closePayoutQueue } from '../../src/infra/queue.js';
import { resetEnvCache } from '../../src/config/env.js';
import { clearFaults } from '../../src/infra/fault.js';
import type { ProviderPort } from '../../src/modules/provider/provider.port.js';
import { closeTestDb } from './pg.js';

/** M2-style helper: build the app with default services and return it. */
export async function startApp(): Promise<FastifyInstance> {
  resetEnvCache();
  clearFaults();
  const app = await buildApp();
  await app.ready();
  return app;
}

export interface StartedStack {
  app: FastifyInstance;
  services: Services;
}

/** M3 helper: build the app with explicit services (e.g. a provider pointed at a mock). */
export async function startStack(opts: { provider?: ProviderPort } = {}): Promise<StartedStack> {
  resetEnvCache();
  clearFaults();
  const services = buildServices(getDb(), opts);
  const app = await buildApp(services);
  await app.ready();
  return { app, services };
}

export async function stopApp(target: FastifyInstance | StartedStack): Promise<void> {
  const app = 'app' in target ? target.app : target;
  clearFaults();
  await app.close();
  await closePayoutQueue();
  await closeDb();
  await closeRedis();
  await closeTestDb();
}
