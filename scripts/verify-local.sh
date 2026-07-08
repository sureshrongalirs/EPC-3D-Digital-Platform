#!/usr/bin/env bash
# Runs server/worker's FBX/mdb2 adapters directly (no queue, no Postgres) against real
# client sample files under testdata/local/*.fbx and testdata/local/*.mdb2 -- see
# CLAUDE.md invariant #8: those files are git-ignored and must never be committed. The user
# runs this manually against their own real files; it is not part of CI.
#
# Prints, per file: recovered linkage-key count + distinct count, a diff against
# scripts/fbx_linkage_check.py's independent parse, mdb2 object count, join coverage
# percentage (when a same-basename .fbx/.mdb2 pair is present), and total wall-clock time.
# Exits non-zero if the TS parser and the Python ground-truth parser disagree on even one key.
#
# Usage:
#   scripts/verify-local.sh
set -euo pipefail
cd "$(dirname "$0")/.."

if [ ! -d testdata/local ]; then
  echo "testdata/local/ does not exist -- nothing to verify. Create it and drop in real .fbx/.mdb2 files to use this script."
  exit 0
fi

pnpm --filter @plantscope/worker exec tsx scripts/verify-local.ts
