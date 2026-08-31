# syntax=docker/dockerfile:1.7

# ---------------------------------------------------------------------------------------
# Multi-stage build for the ledger-payout-service.
#
#   - Base image (M4.2.2): the official multi-arch `node` image, Node 20 (same major as
#     before), Debian bookworm-slim variant, pinned by immutable manifest-list digest:
#       node:20.20.2-bookworm-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0
#     Resolved read-only from Docker Hub (`docker buildx imagetools inspect`) — this is the
#     digest the official `node:20.20.2-bookworm-slim` and `node:20-bookworm-slim` tags both
#     point to as of 2026-08-31, i.e. the newest available build of this Node patch; no newer
#     20.x point release existed at the time. Pinning the manifest-LIST digest (not a
#     single-arch image digest) keeps multi-arch pulls working — Docker picks the right
#     platform automatically. Re-resolve and re-pin when bumping the Node version.
#   - build stage installs the full dependency set and compiles TypeScript to `dist/`.
#   - the runtime stage carries ONLY production dependencies, the compiled output and the
#     files needed at run time. No source, no tests, no dev tooling, no secrets, no npm.
#   - runs as the non-root `node` user, NODE_ENV=production, with a healthcheck.
#
# The same image runs every process; override the command:
#   API        : (default)                 node dist/index.js
#   publisher  : node dist/publisher.js
#   worker     : node dist/worker.js
#   migrations : node dist/db/migrate.js up
#
# None of the above ever invoke npm/npx/corepack — every runtime entry point is a plain
# `node <file>.js` and the HEALTHCHECK is a Node one-liner. The application is confirmed to
# have no lifecycle step that installs packages inside a running container. On that basis
# the runtime stage removes the npm CLI, npx, and Corepack entirely (see below) — `node`
# itself and the shared libraries it needs are untouched.
#
# Run with an init so signals reach PID 1 cleanly, e.g. `docker run --init ...` or
# `init: true` in compose. The app also installs its own SIGTERM/SIGINT handlers.
# ---------------------------------------------------------------------------------------

FROM node:20.20.2-bookworm-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0 AS build
WORKDIR /app
ENV NODE_ENV=development
# Reproducible install from the committed lockfile. The build stage keeps npm — it is only
# ever used here, never in the runtime stage below.
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# Prune to production dependencies in place, then this tree is copied to the runtime stage.
RUN npm prune --omit=dev

# ---------------------------------------------------------------------------------------
FROM node:20.20.2-bookworm-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0 AS runtime
WORKDIR /app

# Minimal security upgrade of the base image's OS packages (M4.2.2). `apt-get upgrade`
# (not `dist-upgrade`) only bumps already-installed packages to the version currently in
# the configured Debian/Debian-security repos — it never installs or removes a package.
# This is what actually resolved the HIGH/CRITICAL OS-package CVEs the base image tag was
# pinned at (their fixes exist upstream in Debian but predate this image build). Still root
# at this point in the stage, which `apt-get` requires; `USER node` is set further down.
RUN apt-get update \
    && apt-get upgrade -y --no-install-recommends \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# Remove the npm CLI, npx, and Corepack from the runtime filesystem — not just the PATH.
# The application never calls any of them at runtime (every process is `node <file>.js`;
# the HEALTHCHECK below is a Node one-liner). Their vendored dependencies
# (tar/minimatch/glob/brace-expansion/etc., bundled inside npm's own install, not this
# project's) are exactly what a Trivy image scan flagged — removing the directories removes
# those CVEs at the source instead of suppressing the finding. `node` itself and its shared
# libraries are untouched.
RUN rm -rf \
      /usr/local/lib/node_modules/npm \
      /usr/local/lib/node_modules/corepack \
      /usr/local/bin/npm \
      /usr/local/bin/npx \
      /usr/local/bin/corepack

ENV NODE_ENV=production \
    HTTP_HOST=0.0.0.0 \
    HTTP_PORT=3000

COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
# package.json only — Node needs it in the working directory to resolve `"type": "module"`
# for ESM. package-lock.json is dropped here: its only past purpose (an in-image `npm
# audit`) no longer applies now that npm is removed from this stage.
COPY --chown=node:node package.json ./
COPY --chown=node:node openapi ./openapi

USER node
EXPOSE 3000

# Liveness from inside the container — no curl/wget/npm in the slim image, so use node.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.HTTP_PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

STOPSIGNAL SIGTERM
CMD ["node", "dist/index.js"]
