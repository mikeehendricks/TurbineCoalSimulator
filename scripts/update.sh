#!/usr/bin/env bash
# update.sh — pull the latest code from the GitHub repository and reinstall
# dependencies.  Invoked by the "Update Now" button on the hidden admin page.
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BRANCH="${GIT_BRANCH:-main}"
SERVICE="${UPDATE_SERVICE:-turbine-coal-simulator}"

cd "$APP_DIR"

echo "==> Updating $(basename "$APP_DIR") from ${BRANCH}"
if [ ! -d .git ]; then
  echo "!! Not a git working copy — nothing to update." >&2
  exit 1
fi

echo "==> Discarding any local changes to tracked files"
git fetch --all --prune
git checkout -- . 2>/dev/null || true
git reset --hard "origin/${BRANCH}"
git submodule update --init --recursive 2>/dev/null || true

echo "==> Installing dependencies"
npm install --omit=dev --no-audit --no-fund

echo "==> Rebuilding vendored browser libraries"
node scripts/vendor.js || true

echo "==> Done"
