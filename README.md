# PlantScope

PlantScope is an open-source, on-premise EPC 3D digital-twin platform: a three.js viewer SDK, a
Node API, a conversion worker, and Postgres, packaged as a single docker-compose stack so an EPC
site can self-host its plant models without a cloud dependency.

## Dev quickstart

```sh
pnpm install
pnpm -r build
pnpm -r test
pnpm -r lint
```

To validate the deployment skeleton:

```sh
docker compose -f deploy/docker-compose.yml config
```

See [CLAUDE.md](./CLAUDE.md) for the project's non-negotiable architectural invariants and
current phase status.
