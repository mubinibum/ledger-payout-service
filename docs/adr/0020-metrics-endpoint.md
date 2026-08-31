# ADR 0020: Prometheus `/metrics` — opt-in, adapter over the in-process registry

- **Status:** accepted (M4)
- **Date:** 2026-08-31

## Context

The service already has an in-process metrics registry (`src/infra/metrics.ts`) — labelled
counters and gauges with Prometheus-style names, added in M2/M3 with a `snapshot()` for
tests. M4 needs a real `GET /metrics` exposition, safely.

## Decision

### Exposition

Extend the existing registry with a `render()` that emits Prometheus text format 0.0.4
(`# HELP` / `# TYPE` + samples), and add a `Histogram` type for HTTP request duration. **No
`prom-client` dependency** — the registry is small, the format is stable, and this keeps the
production dependency list minimal.

### Opt-in

`GET /metrics` exists **only when `METRICS_ENABLED=true`** (default `false`). When the flag
is off, the route is *not registered* and a request falls through to the normal 404 handler
— there is no "disabled" code path to misconfigure. HTTP metrics are still *recorded*
unconditionally (cheap, in-process); they are just not *exposed*.

### Label safety (the important part)

Every label written anywhere in the registry must be **bounded and low-cardinality**:

- HTTP method, status class (`2xx`), or a **normalised route template**
  (`/v1/accounts/:id`, taken from `request.routeOptions.url`, never the concrete URL);
- an enum outcome / reason / code / classification.

**Never** a payout id, account id, idempotency key, provider id, raw `reference`, URL with
ids, or an error message. `test/integration/metrics.test.ts` asserts this by scanning the
exposition for uuid-shaped and long-digit-run label values and failing if any appear.

## Alternatives considered

- **`prom-client`** — the standard choice; rejected only to avoid a dependency for a
  formatting task the registry can already almost do. If a pushgateway, exemplars, or
  native histograms are needed later, adopt it.
- **Always-on `/metrics`** — the exposition reveals traffic shape and error rates; default
  off is the safer public-demo posture (`METRICS_ENABLED` + an auth proxy for real use).
- **Separate metrics port** — cleaner isolation, more moving parts; deferred.

## Consequences

- The registry is now also a public contract (metric names / help text). Renames are
  breaking for any scraper.
- `render()` and the histogram are covered by unit tests; the route by an integration test.
- Operators get the signals the runbook references (`payout_manual_review`,
  `outbox_dead_with_reserved_payout`, `http_requests_total`, …) without a new service.
