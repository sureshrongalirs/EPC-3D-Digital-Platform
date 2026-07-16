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

## Dev setup

On Linux/macOS dev machines with `assimp`/`java`/`mago-3d-tiler` already on `PATH`, `server/api`
and `server/worker` can each be started directly with `pnpm dev` in their own directory. On
Windows, see the subsection below first -- the worker cannot run FBX jobs from a native Windows
shell at all.

To provision the full worker toolchain (Java, `mago-3d-tiler`, `assimp`, `mdbtools`) in WSL:
`bash scripts/setup-wsl-tiler.sh` (despite the filename, this installs everything the worker
shells out to, not just the tiling path -- see the script's own header comment).

### Windows dev machines

**The worker process cannot run FBX conversion from a native Windows shell (Git Bash included)
-- it must run inside WSL.** `server/worker/src/adapters/fbx/assimp.ts` shells out to a bare
`assimp` command with no path override and no Windows-native install exists for it (it's
installed via `apt-get install assimp-utils`, a Linux-only mechanism -- see
`server/worker/Dockerfile`). A worker started from Git Bash is still a native Windows process;
it looks for `assimp` on the Windows `PATH`, finds nothing, and every FBX job fails fast with
`assimp is not installed in this environment`, even if `assimp` is installed inside WSL --
Windows and WSL2 have separate `PATH` namespaces.

**Run `server/api` inside WSL too, not split across Windows/WSL.** Both processes share one
sqlite file by default (`DATA_DIR`/`DATABASE_URL`); sqlite's concurrency model depends on OS
file locking, and locking across the Windows/WSL2 filesystem boundary (a native NTFS process on
one side, a `/mnt/*` 9p-mounted view on the other) is not reliable. Keep both on the same
filesystem view.

**`DATA_DIR`/`DATABASE_URL` must live on WSL's own native ext4 filesystem, never under
`/mnt/<drive>`.** This isn't just a performance suggestion -- a real manual-verification run
against `/mnt/d` produced two separate, byte-identical `mago-3d-tiler` crashes
(`org.apache.commons.io.file.DeletingPathVisitor` failing partway through mago's own
post-processing temp-directory cleanup), both times after mago had already written a fully
correct `tileset.json` and all real tile content -- the crash silently orphaned that already-good
output rather than corrupting it, but the job still failed, because the worker's own integrity
gate (correctly) couldn't find what it expected on disk at validation time. Re-running the exact
same real client file against a `DATA_DIR` on native ext4 (`~/plantscope-data`, not under
`/mnt/*`) produced zero such crashes. See `docs/phase5r/task2-findings.md` §8 for the full
evidence chain. Separately, 9p is also just slow for this worker's own access pattern -- a
54MB FBX splits into 4,500+ individual per-object GLB files (Task 2's per-object splitter), and
that many small file writes over a 9p mount is markedly slower than native ext4.

Exact commands, in a **WSL Ubuntu terminal** (not Git Bash), from the repo checked out at e.g.
`D:\EPC-3D-Digital-Platform` (adjust the drive letter/path to match your own checkout) -- note
`DATA_DIR`/`DATABASE_URL` point at `~/plantscope-data` (ext4), while the repo/code itself is
still read from `/mnt/d/...` (fine -- only the DATA_DIR/DB path needs to avoid 9p, not the repo
checkout location):

```bash
# One-time, if you haven't already: bash scripts/setup-wsl-tiler.sh
mkdir -p ~/plantscope-data

cd /mnt/d/EPC-3D-Digital-Platform/server/api
DATA_DIR=~/plantscope-data \
DATABASE_URL=~/plantscope-data/dev.sqlite3 \
pnpm dev
```
```bash
# separate WSL terminal/pane -- start a beat after the API, not simultaneously: both
# processes run migrations against a brand-new empty DB on first start, and starting them
# at the exact same moment is a real, reproducible race (confirmed directly: the loser gets
# a fatal "table already exists" SqliteError). Starting the API first, confirming it logs
# "listening", then starting the worker avoids it.
cd /mnt/d/EPC-3D-Digital-Platform/server/worker
DATA_DIR=~/plantscope-data \
DATABASE_URL=~/plantscope-data/dev.sqlite3 \
pnpm dev
```

A `.env` file in `server/api`/`server/worker` works too, but the path *form* matters: a
Windows-style value (`D:/EPC-3D-Digital-Platform/...`) only resolves correctly for a
Windows-native process, and a `/mnt/d/...`-style value defeats the ext4 requirement above -- use
a plain WSL home-relative path (`~/plantscope-data` or `/home/<user>/plantscope-data`) for both
`DATA_DIR` and `DATABASE_URL`. The inline env vars above take that form and, since `dotenv`
never overrides an already-set `process.env` value, safely override a `.env` file written for
either of the other two cases.

**The demo app (`apps/demo`) has no filesystem/DB dependency and runs identically on either
side** -- plain Windows-native `pnpm dev` from Git Bash, or the same command inside WSL, both
work; WSL2 auto-forwards `localhost` ports to Windows either way, so `http://localhost:5173`
reaches it from a Windows browser regardless of which side it's running on.

See [CLAUDE.md](./CLAUDE.md) for the project's non-negotiable architectural invariants and
current phase status.
