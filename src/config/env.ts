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

  // REDIS_URL wins over REDIS_HOST/REDIS_PORT when set.
  REDIS_URL: z.string().url().optional(),
  REDIS_HOST: z.string().min(1).default('127.0.0.1'),
  REDIS_PORT: z.coerce.number().int().min(1).max(65535).default(6379),

  READINESS_TIMEOUT_MS: z.coerce.number().int().min(100).max(30_000).default(1500),

  // Number of times a transfer retries on a transient DB error (deadlock / serialization).
  TRANSFER_MAX_RETRIES: z.coerce.number().int().min(0).max(10).default(3),

  // Dev/demo ONLY: the funding endpoint injects an opening balance via a balanced ledger
  // transaction (credit target / debit the system account). Default is `false` — it must be
  // turned on explicitly for local development or a demo, and must never be `true` in a real
  // deployment (there is no such thing as free money in a real ledger).
  ALLOW_FUNDING: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),

  // --- M3: payouts, outbox, worker, provider, webhooks, reconciliation ---

  // Queue + worker.
  PAYOUT_QUEUE_NAME: z.string().min(1).default('payout-jobs'),
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(100).default(5),
  WORKER_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(5),
  WORKER_BACKOFF_MS: z.coerce.number().int().min(100).max(600_000).default(2_000),

  // Outbox publisher.
  OUTBOX_POLL_INTERVAL_MS: z.coerce.number().int().min(50).max(60_000).default(1_000),
  OUTBOX_BATCH_SIZE: z.coerce.number().int().min(1).max(1_000).default(50),
  OUTBOX_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(50).default(10),

  // Provider adapter. `mock` is the only implementation in M3; a real adapter is out of scope.
  PAYOUT_PROVIDER: z.enum(['mock']).default('mock'),
  PROVIDER_BASE_URL: z.string().url().default('http://127.0.0.1:4000'),
  PROVIDER_TIMEOUT_MS: z.coerce.number().int().min(50).max(60_000).default(3_000),

  // Inbound webhook verification. Secret has no default — the webhook route 503s without it.
  WEBHOOK_SECRET: z.string().min(16).optional(),
  WEBHOOK_TOLERANCE_SEC: z.coerce.number().int().min(1).max(3_600).default(300),

  // Reconciliation.
  RECONCILE_STALE_AFTER_SEC: z.coerce.number().int().min(1).max(86_400).default(120),
  RECONCILE_BATCH_SIZE: z.coerce.number().int().min(1).max(1_000).default(50),
  RECONCILE_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(100).default(20),

  // Alert threshold: a payout still holding reserved funds this long after creation is
  // surfaced by the `payouts_reserved_beyond_threshold` gauge / runbook.
  RESERVED_PAYOUT_ALERT_SEC: z.coerce.number().int().min(1).max(2_592_000).default(3_600),

  // How long the outbox publisher waits for a single `queue.add` before giving up on it
  // (and retrying the event next cycle). Keeps a hung Redis from holding a DB row lock.
  OUTBOX_ENQUEUE_TIMEOUT_MS: z.coerce.number().int().min(100).max(30_000).default(3_000),

  // Mock provider process (local only).
  MOCK_PROVIDER_PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  MOCK_PROVIDER_WEBHOOK_URL: z
    .string()
    .url()
    .default('http://127.0.0.1:3000/v1/webhooks/provider/payouts'),
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
