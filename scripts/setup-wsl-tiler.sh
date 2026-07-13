#!/usr/bin/env bash
# One-time dev setup for running server/worker's OGC 3D Tiles path (mago-3d-tiler, CLAUDE.md
# invariant #4) directly on the host, inside WSL Ubuntu, instead of inside the worker's Docker
# image. Java is NOT needed in production: server/worker/Dockerfile already bakes a JRE and
# the mago-3d-tiler jar into the worker's own image at build time (see its comments) -- this
# script exists purely so a developer can run `pnpm exec tsx watch src/index.ts` on the bare
# WSL host (e.g. to test the tiling path without rebuilding the Docker image on every change)
# and still have `java`/mago-3d-tiler available on PATH.
#
# Installs, in order:
#   1. A JDK 21+ (tries `openjdk-21-jdk` from Ubuntu's own apt repos first; falls back to
#      Eclipse Temurin 21 via Adoptium's own apt repo if that package isn't available on this
#      Ubuntu release)
#   2. The mago-3d-tiler jar, to /opt/mago-3d-tiler.jar
#
# Safe to run more than once -- each step is skipped if already done.
#
# Usage (from WSL Ubuntu, not Windows Git Bash):
#   bash scripts/setup-wsl-tiler.sh
set -euo pipefail

MAGO_JAR_PATH=/opt/mago-3d-tiler.jar
MAGO_REPO=Gaia3D/mago-3d-tiler
# Fallback if the GitHub API lookup below fails (e.g. no network, rate-limited) -- keep this
# in sync with server/worker/Dockerfile's own pinned version.
MAGO_JAR_FALLBACK_URL="https://github.com/${MAGO_REPO}/releases/download/v1.15.4/mago-3d-tiler-1.15.4.jar"

# --- Step 1: must be run inside WSL's own Linux, not Windows Git Bash. ---------------------
# Git Bash (MSYS2/MINGW64) reports a "MINGW64_NT-..." kernel name via uname; a real WSL
# Ubuntu's /proc/version contains "microsoft" (the WSL2 kernel is a genuine Linux kernel
# built by Microsoft) -- this is the standard, reliable way to tell the two apart, since both
# otherwise look like "a bash prompt on Windows" to a casual glance.
if ! grep -qi microsoft /proc/version 2>/dev/null; then
  echo "Run this inside WSL Ubuntu, not Windows Git Bash"
  exit 1
fi

# --- Step 2: skip Java install if a JDK 21+ is already on PATH. ----------------------------
JAVA_ALREADY_OK=0
if command -v java >/dev/null 2>&1; then
  # `java -version` prints to stderr, one line like: openjdk version "21.0.9" 2026-10-20
  JAVA_VERSION_LINE="$(java -version 2>&1 | head -1)"
  JAVA_MAJOR="$(echo "$JAVA_VERSION_LINE" | grep -oE '"[0-9]+' | tr -d '"' | head -1)"
  if [ -n "${JAVA_MAJOR:-}" ] && [ "$JAVA_MAJOR" -ge 21 ] 2>/dev/null; then
    echo "Java already installed, skipping ($JAVA_VERSION_LINE)"
    JAVA_ALREADY_OK=1
  fi
fi

# --- Step 3: install a JDK 21+ if step 2 didn't find one already. --------------------------
if [ "$JAVA_ALREADY_OK" -eq 0 ]; then
  echo "Installing Java 21..."
  sudo apt-get update

  if sudo apt-get install -y openjdk-21-jdk; then
    echo "Installed openjdk-21-jdk from Ubuntu's own apt repos."
  else
    echo "openjdk-21-jdk is not available on this Ubuntu release -- falling back to Eclipse Temurin 21 via Adoptium's apt repo."

    if [ ! -f /etc/apt/sources.list.d/adoptium.list ]; then
      sudo mkdir -p /etc/apt/keyrings
      # apt-key is deprecated (removed in newer Debian/Ubuntu) -- this uses the current
      # signed-by approach instead, same net effect as the deprecated `apt-key add`.
      wget -qO- https://packages.adoptium.net/artifactory/api/gpg/key/public \
        | sudo gpg --dearmor -o /etc/apt/keyrings/adoptium.gpg
      echo "deb [signed-by=/etc/apt/keyrings/adoptium.gpg] https://packages.adoptium.net/artifactory/deb $(lsb_release -cs) main" \
        | sudo tee /etc/apt/sources.list.d/adoptium.list
    else
      echo "Adoptium apt repo already configured, skipping."
    fi

    sudo apt-get update
    sudo apt-get install -y temurin-21-jdk
  fi
fi

# --- Step 4: download the mago-3d-tiler jar, if not already present. -----------------------
if [ -f "$MAGO_JAR_PATH" ]; then
  echo "$MAGO_JAR_PATH already exists, skipping download."
else
  echo "Downloading mago-3d-tiler..."
  # Resolved dynamically (not hardcoded to one version) so this script keeps working as new
  # releases ship -- github.com/Gaia3D/mago-3d-tiler only ever publishes a single plain jar
  # per release (no "-natives-all" variant exists at any released version, checked directly
  # against the GitHub releases API), so there is exactly one asset to pick.
  JAR_URL="$(
    curl -fsSL "https://api.github.com/repos/${MAGO_REPO}/releases/latest" \
      | grep -oE '"browser_download_url": *"[^"]+\.jar"' \
      | grep -oE 'https://[^"]+' \
      | head -1
  )" || true

  if [ -z "${JAR_URL:-}" ]; then
    echo "Could not resolve the latest release jar URL from the GitHub API -- using the pinned fallback."
    JAR_URL="$MAGO_JAR_FALLBACK_URL"
  fi

  echo "Fetching: $JAR_URL"
  sudo curl -fsSL -o "$MAGO_JAR_PATH" "$JAR_URL"
fi

# --- Step 5: verify. ------------------------------------------------------------------------
echo
echo "--- java -version ---"
java -version
echo
echo "--- java -jar $MAGO_JAR_PATH --help (first 5 lines) ---"
java -jar "$MAGO_JAR_PATH" --help 2>&1 | head -5
echo
echo "Setup complete. Start the worker with:"
echo "MAGO_TILER_JAR=$MAGO_JAR_PATH DATA_DIR=... DATABASE_URL=... pnpm exec tsx watch src/index.ts"
