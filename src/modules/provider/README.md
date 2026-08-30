# provider (M3 / M3.1)

The payout provider **port** and its only adapter — a local mock.

- `provider.port.ts`: `ProviderPort` — `createPayout`, `getPayoutStatus` (both idempotent
  on the payout's stable idempotency key, ADR 0015), and **`capabilities()`** returning a
  `ProviderCapabilities` contract.
- `mock-provider.client.ts`: HTTP adapter. **Conservative** classification (ADR 0018):
  connection-refused / DNS → `transient` (proven not reached); 429 → `transient`;
  timeout / reset / **5xx** / **unparseable 2xx** / unrecognised error → `ambiguous` (may
  have reached the provider → the caller must not release); explicit 4xx → definitive
  `ProviderError('permanent')`. `classifyTransportError` defaults to `ambiguous`.
- `ProviderCapabilities` (conservative defaults): `notFoundIsDefinitive: false`,
  `fivexxIsDefinitiveNonProcessing: false`. A real adapter opts into stronger guarantees
  here only when the provider's contract backs them; reconciliation uses
  `notFoundIsDefinitive` to decide whether an `unknown` may release funds.

The mock provider **server** is a separate app under `src/mock-provider/` with a
control-plane API for deterministic tests (scenarios incl. `server_5xx`,
`malformed_response`). Local-only, never part of the service runtime. Run it:
`npm run mock-provider`.

A real provider adapter is **out of scope**. It would implement the same port.
