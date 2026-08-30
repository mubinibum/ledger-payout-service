import { Redis, type RedisOptions } from 'ioredis';
import { loadEnv } from '../config/env.js';

let client: Redis | undefined;

/** Connection target from REDIS_URL, or the REDIS_HOST/REDIS_PORT pair. */
export function redisConnectionOptions(extra: RedisOptions = {}): RedisOptions {
  const env = loadEnv();
  if (env.REDIS_URL) {
    const url = new URL(env.REDIS_URL);
    return {
      host: url.hostname,
      port: url.port ? Number(url.port) : 6379,
      ...(url.password ? { password: url.password } : {}),
      ...extra,
    };
  }
  return { host: env.REDIS_HOST, port: env.REDIS_PORT, ...extra };
}

/**
 * Lazily-created shared Redis client for cheap operations and the readiness probe.
 * `lazyConnect` keeps startup from blocking on Redis. BullMQ needs its own connection with
 * different retry semantics — see `src/infra/queue.ts`.
 */
export function getRedis(): Redis {
  if (client) return client;
  client = new Redis(
    redisConnectionOptions({
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
    }),
  );
  // Prevent unhandled 'error' events from crashing the process before first use.
  client.on('error', () => undefined);
  return client;
}

/** Cheap probe for /readyz. Returns true if PING succeeds within the timeout. */
export async function pingRedis(timeoutMs: number): Promise<boolean> {
  const redis = getRedis();
  try {
    if (redis.status === 'wait' || redis.status === 'end') {
      await redis.connect();
    }
    const pong = await Promise.race([
      redis.ping(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('redis ping timeout')), timeoutMs),
      ),
    ]);
    return pong === 'PONG';
  } catch {
    return false;
  }
}

export async function closeRedis(): Promise<void> {
  if (!client) return;
  try {
    await client.quit();
  } catch {
    client.disconnect();
  } finally {
    client = undefined;
  }
}
