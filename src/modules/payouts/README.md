# payouts (M3 / M3.1)

Payouts to an external provider (a local **mock** in M3), with reserved funds, a state
machine, and a `manual_review` safety valve for outcomes that cannot be resolved safely.

- **Lifecycle** (`payout-state.ts`): `requested → queued → processing → submitted →
  succeeded | failed`, `cancelled` before submission, and **`manual_review`** (non-terminal,
  funds reserved, no automatic processing, not cancellable, left only by an explicit
  internal resolution). All transitions go through `assertTransition` — ADR 0012 / ADR 0018.
- **Accounting** (`payout-transitions.ts` + `../ledger/ledger.service.ts`): reservation
  (source → `system:payout_holding`) on create; settlement (holding →
  `system:provider_clearing`) on a definitive success; release (holding → source) on a
  definitive failure / cancel / operator resolution. Each is a balanced ledger transaction;
  settlement and release are mutually exclusive and at-most-once (DB CHECKs). A
  `manual_review` payout has neither. ADR 0011.
- **create** (`payouts.service.ts`): reservation + payout row + outbox event + idempotency
  record, one transaction. `Idempotency-Key` required.
- **worker** (`payout.worker.ts`): idempotent; safe-to-retry → retry, definitive rejection
  → release, **ambiguous → `submitted`, never a release**. Dead-letter releases only a
  payout provably never submitted (`requested`/`queued` + `!provider_contact`); otherwise →
  `manual_review`. ADR 0014 / ADR 0018.
- **reconciliation** (`reconciliation.service.ts`): resolves stale payouts on a
  **definitive** provider answer only; anything ambiguous, and the attempt budget being
  spent, → `manual_review`. A timeout never releases. ADR 0017 / ADR 0018.
- **manual review** (`manual-review.service.ts` + `../../payout-admin.ts`): operator-only
  `resolveSucceeded` / `resolveFailed` / `resumeReconciliation` / `inspect`; every action
  writes a `payout_resolutions` audit row. No public HTTP surface.

Routes: `payouts.routes.ts` (`POST /v1/payouts`, `GET /v1/payouts[/:id]`,
`POST /v1/payouts/:id/cancel`).
