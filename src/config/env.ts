import { z } from 'zod';

/**
 * Environment schema. Parsed once at startup; the process exits early with a readable
 * message if configuration is missing or malformed. No secrets are hard-coded — every
 * value comes from the environment (see .env.example for the template).
 */
const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  HTTP_HOST: z.string().min(1).default('127.0.0.1'),
  HTTP_PORT: z.coerce.number().int().min(1).max(65535).default(3000),

  // Either DATABASE_URL, or the individual PG* parts below (DATABASE_URL wins).
  DATABASE_URL: z.string().url().optional(),
  PGHOST: z.string().min(1).default('127.0.0.1'),
  PGPORT: z.coerce.number().int().min(1).max(65535).default(5432),
  PGDATABASE: z.string().min(1).default('ledger'),
  PGUSER: z.string().min(1).default('ledger'),
  PGPASSWORD: z.string().min(1).default('change-me-locally'),
  DB_POOL_MAX: z.coerce.number().int().min(1).max(100).default(15),
  // How long a caller waits to borrow a pool connection under load before failing.
  DB_CONNECTION_TIMEOUT_MS: z.coerce.number().int().min(100).max(60_000).default(10_000),

  REDIS_HOST: z.string().min(1).default('127.0.0.1'),
  REDIS_PORT: z.coerce.number().int().min(1).max(65535).default(6379),

  READINESS_TIMEOUT_MS: z.coerce.number().int().min(100).max(30_000).default(1500),

  // Number of times a transfer retries on a transient DB error (deadlock / serialization).
  TRANSFER_MAX_RETRIES: z.coerce.number().int().min(0).max(10).default(3),

  // Dev/test affordance: the funding endpoint injects an opening balance via a balanced
  // ledger transaction (credit target / debit the system account). Set to `false` in any
  // real deployment — there is no such thing as free money in a real ledger.
  ALLOW_FUNDING: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
});

export type Env = z.infer<typeof EnvSchema>;

let cached: Env | undefined;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  if (cached) return cached;
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  cached = parsed.data;
  return cached;
}

/** Test-only: clear the memoized env so a fresh source can be parsed. */
export function resetEnvCache(): void {
  cached = undefined;
}
