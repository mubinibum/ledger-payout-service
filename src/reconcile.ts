/* eslint-disable no-console */
import { loadEnv } from './config/env.js';
import { getDb, closeDb } from './infra/db.js';
import { buildServices } from './composition.js';

/**
 * Entry point: run one reconciliation pass and exit. Invoke on a schedule you control
 * (a shell loop, a systemd timer, a k8s CronJob). M3 does not ship a scheduler.
 */
async function main(): Promise<void> {
  loadEnv();
  const { reconciliation } = buildServices(getDb());
  const summary = await reconciliation.reconcileOnce();
  console.log(JSON.stringify({ reconcile: summary }));
}

main()
  .then(() => closeDb())
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    void closeDb().finally(() => process.exit(1));
  });
