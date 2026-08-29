# ADR 0006: Money as integer minor units

- **Status:** accepted
- **Date:** 2026-08-29

## Context

The ledger must never be silently wrong by a fraction of a unit. Floating-point math
(`0.1 + 0.2`) and loosely-typed decimals invite rounding drift and inconsistent behaviour
across the DB, the app, and JSON.

## Decision

Represent every monetary amount as an **integer number of minor units** (cents, sen, …):

- PostgreSQL: `BIGINT`.
- Application: JS `bigint` end to end. `pg` is configured to parse `int8` (OID 20) as
  `bigint`, not `string`.
- API JSON: a **string of digits** (`"1500"`), so no JSON parser can round it.
- No currency-exponent table in M2 — the service only moves and compares integers within a
  single currency, which is all it needs.

## Alternatives considered

- **`NUMERIC`/decimal** — exact, but arrives as a string in `pg`, needs a decimal library
  for arithmetic, and still requires a "no floats" discipline. More surface for little gain
  at this scope.
- **Float / `double precision`** — rejected outright; not exact.

## Consequences

- All arithmetic is `bigint`; a stray `number` in the value path is a type error.
- Amounts up to `1e15` minor units are accepted (well inside `BIGINT`), validated at the
  edge (`domain/money.ts`).
- Presentation formatting (grouping, decimal point) is a client concern, out of scope here.
