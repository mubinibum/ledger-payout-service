import { pingDb } from '../../infra/db.js';
import { pingRedis } from '../../infra/redis.js';
import { loadEnv } from '../../config/env.js';

export type ComponentStatus = 'ok' | 'unavailable';

export interface ReadinessReport {
  status: 'ok' | 'degraded';
  checkedAt: string;
  components: {
    postgres: ComponentStatus;
    redis: ComponentStatus;
  };
}

/**
 * Liveness: the process is up and the event loop is responsive. No dependency checks —
 * a failing dependency must not cause an orchestrator to kill a healthy process.
 */
export function liveness(): { status: 'ok'; uptimeSeconds: number } {
  return { status: 'ok', uptimeSeconds: Math.round(process.uptime()) };
}

/**
 * Readiness: can this instance serve traffic right now? Checks each dependency in
 * parallel with a per-check timeout. In M1, with no services running, this correctly
 * reports `degraded` — that is the intended behaviour, not a bug.
 */
export async function readiness(): Promise<ReadinessReport> {
  const { READINESS_TIMEOUT_MS } = loadEnv();
  const [pg, redis] = await Promise.all([
    pingDb(READINESS_TIMEOUT_MS),
    pingRedis(READINESS_TIMEOUT_MS),
  ]);

  const components = {
    postgres: pg ? ('ok' as const) : ('unavailable' as const),
    redis: redis ? ('ok' as const) : ('unavailable' as const),
  };
  const allOk = Object.values(components).every((c) => c === 'ok');

  return {
    status: allOk ? 'ok' : 'degraded',
    checkedAt: new Date().toISOString(),
    components,
  };
}
