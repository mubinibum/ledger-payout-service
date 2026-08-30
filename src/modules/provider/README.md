# provider (M3)

The payout provider **port** and its only M3 adapter — a local mock.

- `provider.port.ts`: `ProviderPort` — `createPayout` and `getPayoutStatus`, both idempotent
  on the payout's stable idempotency key (ADR 0015).
- `mock-provider.client.ts`: HTTP adapter for the local mock provider. Classifies transport
  failures — connection-refused → `transient`, timeout / mid-flight reset → `ambiguous`;
  429 / 5xx → `transient`; an explicit 4xx rejection → `ProviderError('permanent')`.

The mock provider **server** is a separate app under `src/mock-provider/` with a
control-plane API for deterministic tests. It is local-only and never part of the service
runtime. Run it: `npm run mock-provider`.

A real provider adapter is **out of scope for M3**. It would implement the same port.
