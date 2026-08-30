# payouts (M3)

Payouts to an external provider (a local **mock** provider in M3), with reserved funds and
a state machine.

- **Lifecycle** (`payout-state.ts`): `requested → queued → processing → submitted →
  succeeded | failed`, plus `cancelled` before submission. Terminal states are immutable.
  All transitions go through `assertTransition` — see ADR 0012.
- **Accounting** (`payout-transitions.ts` + `../ledger/ledger.service.ts`): reservation
  (source → `system:payout_holding`) on create; settlement (holding →
  `system:provider_clearing`) on success; release (holding → source) on failure/cancel.
  Each is a balanced ledger transaction; settlement and release are mutually exclusive and
  at-most-once (DB CHECK + the `*_ledger_transaction_id` guards). ADR 0011.
- **create** (`payouts.service.ts`): reservation + payout row + outbox event + idempotency
  record, all in one transaction. `Idempotency-Key` required.
- **worker** (`payout.worker.ts`): `processPayoutJob` is idempotent; transient → retry,
  permanent → release, ambiguous → `submitted` (never a release). BullMQ wiring + dead
  letter. ADR 0014.
- **reconciliation** (`reconciliation.service.ts`): resolves stale non-terminal payouts by
  asking the provider directly. A timeout never releases funds. ADR 0017.

Routes: `payouts.routes.ts` (`POST /v1/payouts`, `GET /v1/payouts[/:id]`,
`POST /v1/payouts/:id/cancel`).
