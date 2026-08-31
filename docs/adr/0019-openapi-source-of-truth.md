# ADR 0019: OpenAPI as a checked-in spec with a drift test

- **Status:** accepted (M4)
- **Date:** 2026-08-31

## Context

M4 requires an OpenAPI 3.1 document for the real HTTP API. The routes validate with Zod
*inside* their handlers (`schema.parse(request.body)`), not through Fastify's JSON-schema
`schema` option, so there is no schema object to auto-serialise into OpenAPI today. Options:

1. Wire every route's Zod schema into Fastify (`fastify-type-provider-zod` or hand-written
   JSON schema) and generate the spec with `@fastify/swagger`.
2. Hand-maintain the spec and guard it against drift with a test.

## Decision

Option 2. `openapi/openapi.yaml` is the hand-maintained source of truth;
`openapi/openapi.json` is a deterministic derivative committed beside it
(`npm run openapi:generate`).

`npm run openapi:check` (CI gate + `test/integration/openapi.test.ts`) fails when:

- the spec is not valid OpenAPI 3.1 structurally (version, `info`, every operation has an
  `operationId` and `responses`, every local `$ref` resolves, no external `$ref`);
- `openapi/openapi.json` is stale relative to the YAML;
- the set of documented `METHOD path` pairs differs from what `buildApp` actually registers
  (introspected via a new `onRoute` option on `buildApp`) — this catches both **phantom**
  routes (documented, not real) and **undocumented** routes (real, not documented);
- the dev/demo funding endpoint is not flagged `x-dev-only: true`;
- any path looks like an internal control endpoint (`mock-provider`, `fault`, `/admin`,
  `manual-review`, `/internal`).

The manual-review resolution flow is intentionally **absent** from the spec — it is an
operator CLI, not HTTP.

## Alternatives considered

- **Full Fastify JSON-schema wiring + `@fastify/swagger`** — the "no drift by construction"
  option, but a large refactor of every route, a new runtime dependency, and a second schema
  representation to keep in step with the Zod one. Deferred; if the API grows this becomes
  worth it.
- **Generate the spec from the Zod schemas** (`zod-to-openapi`) — still needs each route to
  export its schema in a registry and a new dependency; the response bodies are assembled in
  services, not declared, so coverage would be partial.

## Consequences

- The spec can drift in **content** (a field's type, an example) without the test noticing —
  only the path/method surface is enforced automatically. Response-shape accuracy relies on
  review. Acceptable at this size; revisit with option 1 if the API grows.
- Adding or removing a route now *requires* a spec edit or CI goes red — the drift is loud.
- `yaml` is added as a devDependency (parsing the source, offline, deterministic).
