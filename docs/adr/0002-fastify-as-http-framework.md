# ADR 0002: Fastify as the HTTP framework

- **Status:** accepted
- **Date:** 2026-08-27

## Context

The service needs an HTTP layer for a small number of JSON endpoints (accounts, transfers,
payouts, webhooks, health). Priorities: first-class TypeScript support, low overhead,
schema-based validation, structured logging, and easy in-process testing.

## Decision

Use **Fastify 5**.

- Native `pino` integration gives correlated structured logs with almost no wiring.
- `app.inject()` runs the whole app in-process — the M1 smoke test needs no network or
  services.
- JSON Schema / provider-based validation fits the "validate at the boundary" rule (M2+ pairs
  it with `zod` for typed parsing).
- Plugin encapsulation maps cleanly onto the modular-monolith structure (ADR 0004).

## Alternatives considered

- **Express** — ubiquitous, but no built-in schema validation or logging, weaker types,
  slower. More glue code for the same result.
- **NestJS** — batteries included, but heavy DI/decorator machinery for a service this size;
  obscures the mechanics this project is meant to show.
- **Hono / raw `node:http`** — minimal, but we'd rebuild lifecycle hooks, validation, and
  error handling by hand.

## Consequences

- Some ecosystem lock-in to Fastify plugins; acceptable for a demo.
- Team members unfamiliar with Fastify have a small learning curve vs Express.
