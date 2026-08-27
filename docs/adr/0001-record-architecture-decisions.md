# ADR 0001: Record architecture decisions

- **Status:** accepted
- **Date:** 2026-08-27

## Context

This project is a portfolio piece whose value is the *reasoning*, not just the code. Design
choices need to be visible and reviewable.

## Decision

Keep short Architecture Decision Records in `docs/adr/`, one file per decision, numbered
sequentially. Each records context, the decision, and the trade-offs accepted. Format is
loosely based on Michael Nygard's ADR template.

## Consequences

- A reviewer can see *why* Fastify/Kysely/etc. were chosen without reading the whole tree.
- Superseded decisions are kept (marked `superseded by ADR-NNNN`), not deleted.
