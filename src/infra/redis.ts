import { Redis } from 'ioredis';
import { loadEnv } from '../config/env.js';

let client: Redis | undefined;

/**
 * Lazily-created Redis client. `lazyConnect` keeps startup from blocking on Redis; the
 * connection is established on first use (or on an explicit `pingRedis`). Later milestones
 * use this for caching, the idempotency store, and the BullMQ backing connection.
 */
export function getRedis(): Redis {
  if (client) return client;
  const env = loadEnv();
  client = new Redis({
    host: env.REDIS_HOST,
    port: env.REDIS_PORT,
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
  });
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
