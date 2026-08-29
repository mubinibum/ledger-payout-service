# accounts (M2)

Account records and their **projected balance** (`balance_minor`, integer minor units).

- Balance is a cached projection updated in the same DB transaction as the ledger entries
  that move it; every entry also stores `balance_after`, so the ledger stays the audit
  trail and the projection can be cross-checked against it.
- One currency per account. `status` is `active | frozen | closed`; only `active` accounts
  may send or receive transfers. `allow_overdraft` is `false` for user accounts.
- **Funding** (`POST /v1/accounts/:id/funding`) is a dev/test affordance gated by
  `ALLOW_FUNDING`. It never writes a balance directly — it books a balanced `funding`
  ledger transaction: credit the target, debit the internal `system` account for that
  currency (the only account allowed to run negative).

Routes: `accounts.routes.ts` · use cases: `accounts.service.ts` · data access:
`accounts.repository.ts` · request shapes: `accounts.schemas.ts`.
