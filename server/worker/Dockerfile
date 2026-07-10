# syntax=docker/dockerfile:1
#
# Multi-stage build: install workspace deps + build TypeScript in a full Debian-slim image,
# then copy only the built output + production node_modules into a second image that also
# has the two CLI tools this worker shells out to. Debian (not Alpine) is used throughout so
# apt has both `assimp-utils` and `mdbtools` as ready-made packages, and so better-sqlite3's
# prebuilt native binary (a transitive dep via @plantscope/server-shared, used for local
# dev/tests, not by this container in production) doesn't hit musl-vs-glibc surprises.
FROM node:22-bookworm-slim AS build
RUN corepack enable
WORKDIR /workspace

# Copy just the package.json files first so `pnpm install` is cached across source-only
# changes.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/package.json
COPY packages/core/package.json packages/core/package.json
COPY packages/plugins/package.json packages/plugins/package.json
COPY server/shared/package.json server/shared/package.json
COPY server/worker/package.json server/worker/package.json
RUN pnpm install --frozen-lockfile

COPY packages packages
COPY server/shared server/shared
COPY server/worker server/worker
RUN pnpm --filter @plantscope/server-shared build \
  && pnpm --filter @plantscope/worker build

FROM node:22-bookworm-slim AS runtime
# assimp-utils: provides the `assimp` CLI -- FBX -> GLB geometry conversion
#   (server/worker/src/adapters/fbx/assimp.ts).
# mdbtools: provides `mdb-export`/`mdb-tables` -- streaming .mdb2 ingestion
#   (server/worker/src/adapters/mdb2/mdbtools.ts).
# Both installed once, here, from Debian's own apt repos at image-build time. The running
# container has no outbound network access at all beyond talking to Postgres (CLAUDE.md
# invariant #7 -- see deploy/docker-compose.yml's `backend` network, internal: true), so
# these tools never reach out to anything once the container starts.
RUN apt-get update \
  && apt-get install -y --no-install-recommends assimp-utils mdbtools \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace
COPY --from=build /workspace/node_modules ./node_modules
COPY --from=build /workspace/packages packages
COPY --from=build /workspace/server/shared/dist server/shared/dist
COPY --from=build /workspace/server/shared/package.json server/shared/package.json
COPY --from=build /workspace/server/worker/dist server/worker/dist
COPY --from=build /workspace/server/worker/package.json server/worker/package.json

WORKDIR /workspace/server/worker
ENV NODE_ENV=production
CMD ["node", "dist/index.js"]
