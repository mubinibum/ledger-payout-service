# ADR 0003: Kysely for database access

- **Status:** accepted
- **Date:** 2026-08-27

## Context

The ledger needs precise, predictable SQL: append-only inserts, `SELECT ... FOR UPDATE`,
partial indexes, `SERIALIZABLE` transactions where required, and set-based balance queries.
We want compile-time type safety without hiding the SQL.

## Decision

Use **Kysely** (a typed query builder) with **`node-pg`** as the driver, and plain SQL
migration files.

- The generated SQL is obvious from the call site — important when reasoning about locking
  and isolation.
- Types are derived from an explicit `Database` interface we control, kept in sync with
  migrations.
- No hidden lazy-loading, no identity map, no implicit N+1.

## Alternatives considered

- **Prisma** — great DX and migrations, but the query engine abstracts away the SQL and
  makes advanced locking / isolation and raw set operations awkward; a heavier runtime.
- **TypeORM / Sequelize** — full ORMs; the active-record/identity-map model fights an
  append-only ledger and obscures transaction boundaries.
- **Raw `pg` + hand-written SQL strings** — maximal control, but no type safety and more
  boilerplate for the 90% of queries that are straightforward.

## Consequences

- We maintain the `Database` type by hand (or via `kysely-codegen` later); drift is a risk
  mitigated by integration tests against a real Postgres (Testcontainers).
- Complex dynamic queries are more verbose than in an ORM — acceptable and rare here.
