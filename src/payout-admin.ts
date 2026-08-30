/* eslint-disable no-console */
import { loadEnv } from './config/env.js';
import { getDb, closeDb } from './infra/db.js';
import { buildServices } from './composition.js';
import { isDomainError } from './domain/errors.js';

/**
 * LOCAL operator CLI for resolving payouts stuck in `manual_review`. There is no public
 * HTTP admin endpoint (no authn/authz yet — deferred). Accounting-destructive actions
 * require `--confirm`.
 *
 *   npm run payout-admin -- inspect <payoutId>
 *   npm run payout-admin -- resolve-succeeded <payoutId> --reason "..." --operator "..." --confirm
 *   npm run payout-admin -- resolve-failed    <payoutId> --reason "..." --operator "..." --confirm
 *   npm run payout-admin -- resume-reconcile  <payoutId> --reason "..." --operator "..."
 */
type Flags = { reason?: string; operator?: string; confirm: boolean };

function parseFlags(argv: readonly string[]): Flags {
  const flags: Flags = { confirm: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--reason') flags.reason = argv[(i += 1)];
    else if (a === '--operator') flags.operator = argv[(i += 1)];
    else if (a === '--confirm') flags.confirm = true;
  }
  return flags;
}

function usage(): never {
  console.error(
    [
      'usage:',
      '  payout-admin inspect <payoutId>',
      '  payout-admin resolve-succeeded <payoutId> --reason "..." --operator "..." --confirm',
      '  payout-admin resolve-failed    <payoutId> --reason "..." --operator "..." --confirm',
      '  payout-admin resume-reconcile  <payoutId> --reason "..." --operator "..."',
    ].join('\n'),
  );
  process.exit(2);
}

async function main(): Promise<void> {
  loadEnv();
  const [command, payoutId, ...rest] = process.argv.slice(2);
  if (!command || !payoutId) usage();
  const flags = parseFlags(rest);
  const { manualReview } = buildServices(getDb());

  const requireReasonAndOperator = (): { reason: string; operatorReference: string } => {
    if (!flags.reason || !flags.operator) {
      console.error('--reason and --operator are required');
      process.exit(2);
    }
    return { reason: flags.reason, operatorReference: flags.operator };
  };
  const requireConfirm = (): void => {
    if (!flags.confirm) {
      console.error('this action changes the ledger; pass --confirm to proceed');
      process.exit(2);
    }
  };

  switch (command) {
    case 'inspect': {
      const info = await manualReview.inspect(payoutId);
      console.log(JSON.stringify(info, null, 2));
      break;
    }
    case 'resolve-succeeded': {
      requireConfirm();
      const r = await manualReview.resolveSucceeded(payoutId, requireReasonAndOperator());
      console.log(
        JSON.stringify({ resolved: 'succeeded', effect: r.effect, status: r.payout.status }),
      );
      break;
    }
    case 'resolve-failed': {
      requireConfirm();
      const r = await manualReview.resolveFailed(payoutId, requireReasonAndOperator());
      console.log(
        JSON.stringify({ resolved: 'failed', effect: r.effect, status: r.payout.status }),
      );
      break;
    }
    case 'resume-reconcile': {
      const r = await manualReview.resumeReconciliation(payoutId, requireReasonAndOperator());
      console.log(JSON.stringify({ resolved: 'resumed', status: r.payout.status }));
      break;
    }
    default:
      usage();
  }
}

main()
  .then(() => closeDb())
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    if (isDomainError(err)) {
      console.error(`${err.code}: ${err.message}`);
    } else {
      console.error(err instanceof Error ? err.message : String(err));
    }
    void closeDb().finally(() => process.exit(1));
  });
