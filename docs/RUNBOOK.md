# Runbook

Operational playbook for the `ledger-payout-service`. This is a portfolio project running
locally, so "page", "escalate", and "on-call" below describe what a real rotation *would*
do — adapt to your environment.

**Golden rules**

1. **Reserved payout funds are released automatically only** after a definitive provider
   rejection or a pre-submission cancellation. If you are unsure whether the beneficiary was
   paid, the payout belongs in `manual_review` — never force a release.
2. Prefer a safe holding state over a fast resolution. A stuck payout costs patience; a
   wrong release or double settlement costs money and trust.
3. Every manual action on a payout goes through `npm run payout-admin` so it is recorded in
   `payout_resolutions`. Do not hand-edit rows.
4. No command in this runbook mutates production data destructively. There are no
   `DELETE`/`TRUNCATE`/`DROP` steps.

**Key signals** (Prometheus, when `METRICS_ENABLED=true`)

| Signal | Meaning |
|---|---|
| `payout_manual_review` | payouts waiting for an operator |
| `payout_manual_review_oldest_seconds` | age of the oldest one |
| `payouts_reserved_beyond_threshold` | payouts holding funds past `RESERVED_PAYOUT_ALERT_SEC` |
| `outbox_pending` / `outbox_oldest_pending_seconds` / `outbox_dead` | delivery backlog |
| `outbox_dead_with_reserved_payout` | dead events whose payout still holds funds — **always investigate** |
| `worker_dlq_total` | jobs sent to the dead-letter queue |
| `provider_ambiguous_outcomes_total` | ambiguous provider interactions |
| `webhook_rejected_total` / `payout_outcome_conflicts_total` | bad or contradictory callbacks |
| `http_requests_total{status_class="5xx"}` | server errors |
| `reconciliation_outcomes_total` | reconciliation results by outcome |

Operator CLI (`src/payout-admin.ts` — local only, no HTTP admin surface):

```sh
npm run payout-admin -- inspect <payoutId>
npm run payout-admin -- resolve-succeeded <payoutId> --reason "..." --operator "you" --confirm
npm run payout-admin -- resolve-failed    <payoutId> --reason "..." --operator "you" --confirm
npm run payout-admin -- resume-reconcile  <payoutId> --reason "..." --operator "you"
```

There is no `list` subcommand yet — enumerate the queue with SQL (read-only):

```sql
SELECT id, external_id, status, manual_review_reason, provider_contact,
       attempt_count, reconcile_attempt_count, manual_review_at
FROM payouts WHERE status = 'manual_review' ORDER BY manual_review_at;
```

---

## 1. `manual_review` backlog is growing

- **Symptom / signal:** `payout_manual_review` rising; `payout_manual_review_oldest_seconds`
  past your SLO.
- **Immediate safety action:** none required — funds are reserved and safe. Do not
  bulk-resolve.
- **Diagnose:**
  1. the SQL query above — group by `manual_review_reason`.
  2. A single dominant reason (`reconciliation_exhausted`, `worker_unexpected_error`, …)
     points at one upstream cause; a spread suggests the provider or DB.
  3. Check `provider_ambiguous_outcomes_total` and `worker_jobs_total{result="failed"}`
     rate around the onset time; check a worker log sample.
- **Remediate:**
  - Upstream cause fixed and a payout is provably still unpaid (provider dashboard / support
    confirms no transfer) → `payout-admin resolve-failed <id> --reason "..." --operator you --confirm`.
  - Provider confirms the beneficiary was paid → `resolve-succeeded ... --confirm`.
  - Genuinely still in-flight and now safe to retry automatically →
    `resume-reconcile ...` (moves to `submitted`; reconciliation picks it up).
- **Avoid:** resolving on assumption; scripting a loop over the list.
- **Verify:** `payout_manual_review` falls; each resolved payout has a `payout_resolutions`
  row; ledger still balances (§17).
- **Escalate:** if you cannot get a definitive per-payout answer from the provider.

## 2. A single payout is stuck in `manual_review`

- **Symptom:** customer/beneficiary reports a missing payout; `payout-admin inspect <id>` says
  `manual_review`.
- **Safety:** funds are held; no rush.
- **Diagnose:** read `manual_review_reason`, `provider_contact`, `attempt_count`,
  `reconcile_attempt_count`, `last_reconciliation_outcome`, `definitive_outcome_source`,
  `submitted_at`. Cross-check the provider by `provider_payout_id` (or `external_id` if the
  request may never have been accepted).
- **Remediate:** as in §1 — resolve to `failed`, `succeeded`, or `resumed` (resume-reconcile) with a reason
  citing the evidence.
- **Verify:** status is terminal (or `submitted`); a `payout_release`/`payout_settlement`
  ledger transaction exists iff you resolved to `failed`/`succeeded`.

## 3. Outbox backlog / events not publishing

- **Signal:** `outbox_pending` climbing, `outbox_oldest_pending_seconds` large, payouts
  stuck in `requested`.
- **Safety:** reserved funds are safe; payouts just aren't progressing.
- **Diagnose:**
  1. Is the publisher process running? (`npm run publisher` / its container).
  2. Redis reachable? `GET /readyz` → `components.redis`.
  3. Publisher logs for `queue.add` timeouts (`OUTBOX_ENQUEUE_TIMEOUT_MS`).
- **Remediate:** restart the publisher; restore Redis; if a specific event keeps failing,
  inspect `outbox_events.last_error` for that row.
- **Avoid:** deleting outbox rows; manually enqueuing jobs.
- **Verify:** `outbox_pending` drains to ~0; stuck payouts advance to `queued`/`processing`.

## 4. `outbox_dead` > 0 (events exhausted publish attempts)

- **Signal:** `outbox_dead` non-zero; **`outbox_dead_with_reserved_payout` > 0 is urgent.**
- **Safety:** for each dead event with a reserved payout, the payout is either progressing
  by another path or needs manual review — confirm, do not assume.
- **Diagnose:** find the dead rows, map `aggregate_id` → payout, check each payout's status.
- **Remediate:** fix the root cause (schema / permissions / Redis). For a payout that is now
  stranded, use `payout-admin` to move it to `manual_review` handling; re-publishing is a
  code-level operation, not a runbook step.
- **Verify:** `outbox_dead_with_reserved_payout` returns to 0.

## 5. Worker not processing jobs

- **Signal:** `worker_jobs_total` flat while `outbox_published_total` rises; payouts stuck
  in `queued`.
- **Diagnose:** worker process up? Redis up? `WORKER_CONCURRENCY` sane? Worker logs for a
  crash loop.
- **Remediate:** restart the worker; scale concurrency if it is simply behind.
- **Verify:** `queued` count falls; `worker_jobs_total{result="ok"}` increases.

## 6. Worker crash loop

- **Signal:** worker restarts repeatedly; `worker_jobs_total{result="failed"}` spikes.
- **Safety:** BullMQ redelivers; idempotent processing means a redelivered job is safe.
- **Diagnose:** the stack trace on startup or first job. Common causes: bad migration state,
  unreachable DB, a code bug on a specific payload.
- **Remediate:** roll back the deploy; fix forward. If one payload is poison it will hit the
  attempt budget and land in `manual_review` — that is the designed containment.
- **Verify:** worker stable for 10+ minutes; DLQ not growing.

## 7. Jobs piling into the dead-letter queue

- **Signal:** `worker_dlq_total` climbing.
- **Diagnose:** sample DLQ'd jobs; check whether the corresponding payouts reached
  `manual_review` (they should have).
- **Remediate:** address the systemic cause; the payouts are safe in `manual_review`.
- **Avoid:** blindly re-queuing DLQ jobs — you may re-submit to the provider.
- **Verify:** DLQ growth stops; `manual_review` items are being worked (§1).

## 8. Provider webhooks being rejected

- **Signal:** `webhook_rejected_total` rising, by `reason` label
  (`signature`, `timestamp`, `missing_headers`, `body`).
- **Diagnose:**
  - `signature` → `WEBHOOK_SECRET` mismatch between us and the provider, or a proxy is
    altering the body. HMAC is over the **raw** bytes.
  - `timestamp` → clock skew beyond `WEBHOOK_TOLERANCE_SEC`; check NTP.
  - `missing_headers` / `body` → provider misconfiguration or a malformed sender.
- **Remediate:** re-sync the secret (rotate on both sides), fix clock skew, fix the proxy to
  pass the body untouched.
- **Verify:** `webhook_accepted_total` resumes; affected payouts settle/release or are
  reconciled.

## 9. Contradictory provider outcomes

- **Signal:** `payout_outcome_conflicts_total` > 0.
- **Meaning:** a webhook/status contradicts an applied terminal effect (e.g. `failed` after
  we settled). The service logs it, ignores the second effect, and returns
  `conflict_ignored`.
- **Diagnose:** for each conflicted payout, reconcile our ledger against the provider's
  record of truth.
- **Remediate:** if the provider is authoritatively right and we are wrong, this is a
  **correctness incident** — do not "fix" it with the CLI; open an investigation, because a
  ledger correction is a deliberate, reviewed, balanced adjustment.
- **Verify:** root cause identified; provider-side idempotency reviewed.

## 10. `/readyz` reports `degraded`

- **Signal:** readiness 503; `components.postgres` or `components.redis` = `unavailable`.
- **Diagnose:** connectivity, credentials, the dependency's own health, `READINESS_TIMEOUT_MS`
  vs real latency.
- **Remediate:** restore the dependency. The API keeps serving reads/writes that don't need
  the down dependency; an orchestrator should stop routing new traffic on 503 but **not**
  kill the process (liveness is separate).
- **Verify:** `/readyz` → 200.

## 11. Elevated 5xx rate on the API

- **Signal:** `http_requests_total{status_class="5xx"}` rate up;
  `http_request_duration_seconds` p99 up.
- **Diagnose:** `internal_error` logs (they carry the stack); correlate with a deploy, a DB
  incident, or pool exhaustion (`DB_POOL_MAX`, borrow timeouts).
- **Remediate:** roll back a bad deploy; restore the DB; raise pool size only if the DB can
  take it.
- **Verify:** 5xx rate back to baseline.

## 12. Database connection pool exhausted

- **Signal:** spikes of `500` with pool "timeout acquiring connection" in logs under load.
- **Diagnose:** concurrency vs `DB_POOL_MAX`; a slow query holding connections; a leak.
- **Remediate:** shed load / add an instance; tune `DB_POOL_MAX` and
  `DB_CONNECTION_TIMEOUT_MS`; find the slow query.
- **Verify:** error class clears; pool metrics (DB-side) healthy.

## 13. Migration failed or partially applied

- **Signal:** deploy aborts; `npm run migrate:status` shows an unexpected state; app won't
  start.
- **Safety:** do not start app instances against a half-migrated schema.
- **Diagnose:** `migrate:status`; read the failing migration and the DB error.
- **Remediate:** migrations are transactional per step — a failed step rolls back. Fix the
  migration and re-run `migrate:up`. Use `migrate:down` only if the down path is known-good
  for that migration and no newer data depends on it.
- **Verify:** `migrate:status` clean; a fresh `migrate:down`→`up` round-trip passes in a
  scratch DB.

## 14. `payouts_reserved_beyond_threshold` > 0

- **Signal:** payouts holding reserved funds past `RESERVED_PAYOUT_ALERT_SEC` without a
  terminal outcome.
- **Diagnose:** are they in `submitted` (waiting on a webhook/reconcile) or genuinely
  stalled? Check the publisher, worker, reconciliation pass, and provider webhook delivery.
- **Remediate:** clear whichever pipeline stage is stuck (§3–§9). Payouts that reconciliation
  cannot resolve will move themselves to `manual_review`.
- **Verify:** the gauge trends to 0 as payouts reach terminal states.

## 15. Reconciliation pass not running / not resolving

- **Signal:** `reconciliation_runs_total` flat, or `reconciliation_outcomes_total{outcome=...}`
  shows repeated non-progress; `submitted` payouts not advancing.
- **Diagnose:** is `npm run reconcile` scheduled? Provider status endpoint reachable?
  `RECONCILE_*` settings sane?
- **Remediate:** restore the schedule / provider connectivity. After `RECONCILE_MAX_ATTEMPTS`
  a payout is moved to `manual_review` by design — that is not a bug.
- **Verify:** `submitted` payouts either settle/release or land in `manual_review`.

## 16. Redis is down

- **Signal:** `/readyz` redis `unavailable`; publisher `queue.add` timeouts; worker idle.
- **Safety:** reserved funds are safe; no new payout progress.
- **Diagnose/Remediate:** restore Redis; the publisher retries pending events, the worker
  reconnects. `SKIP LOCKED` + enqueue timeout mean no DB locks were held during the outage.
- **Verify:** `outbox_pending` drains; workers resume.

## 17. Ledger integrity check (run after any manual intervention)

The core invariant: **the ledger balances and no committed account balance is negative.**

```sql
-- every ledger transaction nets to zero
SELECT ledger_transaction_id, SUM(CASE WHEN direction='debit' THEN amount_minor ELSE -amount_minor END) AS net
FROM ledger_entries GROUP BY ledger_transaction_id HAVING SUM(CASE WHEN direction='debit' THEN amount_minor ELSE -amount_minor END) <> 0;

-- no negative committed balance on a non-overdraft account
SELECT id, external_id, balance_minor FROM accounts WHERE balance_minor < 0 AND allow_overdraft = false;

-- each payout has at most one of settlement / release
SELECT id FROM payouts
WHERE settlement_ledger_transaction_id IS NOT NULL AND release_ledger_transaction_id IS NOT NULL;
```

All three must return **zero rows**. If any does not, stop, freeze manual actions, and open
a correctness investigation.

## 18. Suspected credential exposure (`WEBHOOK_SECRET` / DB / Redis)

- **Immediate:** rotate the credential in the secret store and restart the affected
  processes. For `WEBHOOK_SECRET`, coordinate the rotation with the provider (a window where
  both old and new are accepted avoids dropped webhooks — not implemented here, so expect a
  brief rejection spike and rely on reconciliation).
- **Diagnose:** how it leaked — git history (`gitleaks`), an image, a log, a screenshot.
  Run `npm run scan:proprietary` and the gitleaks job.
- **Remediate:** purge from wherever it landed; if it is in git history, that is a history
  rewrite + force-push decision made with the repo owner.
- **Verify:** old credential rejected; scanners clean; webhook acceptance recovered.

## 19. Deploying / running hardened

Recommended `docker run` flags for the runtime image:

```sh
docker run --init --read-only --tmpfs /tmp \
  --cap-drop ALL --security-opt no-new-privileges \
  -e NODE_ENV=production -e WEBHOOK_SECRET=... -e DATABASE_URL=... -e REDIS_URL=... \
  ledger-payout-service:<tag>
```

The image already runs as non-root; the app writes nothing to disk, so `--read-only` +
`--tmpfs /tmp` works. The process installs SIGTERM/SIGINT handlers and drains within
`onShutdown`'s 15 s deadline; give the orchestrator a `terminationGracePeriod` ≥ 20 s.
