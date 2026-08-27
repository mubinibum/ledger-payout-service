# Security

## Status

This is a **portfolio / engineering-demonstration** project. It is **not** a real financial
service, handles **no real money**, and integrates with **no real payment provider** (a mock
provider is used). Do not deploy it as anything other than a demo.

## Scope of security work in this repo

Later milestones add: a one-page threat model, HMAC-signed webhooks with a timestamp window,
scoped API credentials with rate limiting, input validation at every boundary (zod), and CI
dependency/secret scanning. None of this is implemented in M1 beyond configuration hygiene.

## Configuration hygiene (M1)

- No secrets are committed. `.env` is gitignored; only `.env.example` (placeholder values)
  is tracked.
- `docker-compose.yml` values are throwaway and bind to `127.0.0.1` only.

## Reporting

If you find a security issue in this demo, open an issue or contact the author. There is no
bounty and no production system behind this repository.
