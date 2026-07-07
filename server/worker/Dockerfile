# Placeholder Dockerfile — Phase 0 scaffold.
# Real multi-stage workspace build (pnpm install --frozen-lockfile, pnpm --filter @plantscope/worker build)
# lands with the worker implementation. This container is never attached to an outbound-capable
# network in deploy/docker-compose.yml (see CLAUDE.md: "Worker has no outbound network").
FROM node:22-alpine
WORKDIR /app
CMD ["node", "--version"]
