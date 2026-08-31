# syntax=docker/dockerfile:1.7

# ---------------------------------------------------------------------------------------
# Multi-stage build for the ledger-payout-service.
#
#   - base image pinned to a specific Node 20 patch on Debian bookworm-slim. Replace the
#     tag with a digest (`node:20.20.2-bookworm-slim@sha256:...`) once the repo has a
#     registry / Renovate to keep it current.
#   - build stage installs the full dependency set and compiles TypeScript to `dist/`.
#   - the runtime stage carries ONLY production dependencies, the compiled output and the
#     files needed at run time. No source, no tests, no dev tooling, no secrets.
#   - runs as the non-root `node` user, NODE_ENV=production, with a healthcheck.
#
# The same image runs every process; override the command:
#   API        : (default)                 node dist/index.js
#   publisher  : node dist/publisher.js
#   worker     : node dist/worker.js
#   migrations : node dist/db/migrate.js up
#
# Run with an init so signals reach PID 1 cleanly, e.g. `docker run --init ...` or
# `init: true` in compose. The app also installs its own SIGTERM/SIGINT handlers.
# ---------------------------------------------------------------------------------------

FROM node:20.20.2-bookworm-slim AS build
WORKDIR /app
ENV NODE_ENV=development
# Reproducible install from the committed lockfile.
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# Prune to production dependencies in place, then this tree is copied to the runtime stage.
RUN npm prune --omit=dev

# ---------------------------------------------------------------------------------------
FROM node:20.20.2-bookworm-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    HTTP_HOST=0.0.0.0 \
    HTTP_PORT=3000

# Drop the build toolchain's npm global cache noise; keep the image minimal. `node` (uid
# 1000) already exists in the official image.
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
# package.json + lockfile: needed for `node`'s ESM resolution and to allow an in-image
# `npm audit --omit=dev` during verification. Neither file carries a secret.
COPY --chown=node:node package.json package-lock.json ./
COPY --chown=node:node openapi ./openapi

USER node
EXPOSE 3000

# Liveness from inside the container — no curl/wget in the slim image, so use node.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.HTTP_PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

STOPSIGNAL SIGTERM
CMD ["node", "dist/index.js"]
