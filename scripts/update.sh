#!/usr/bin/env bash
# update.sh — bring the installed copy up to date with the GitHub repository.
# Invoked by the "Update Now" button on the hidden admin console and by
# `tcs-update apply`.
#
# It has to work on both kinds of installation:
#
#   git install     the deploy directory is a git working copy — fetch and
#                   reset to origin/<branch>
#   plain install   the installer deployed files without .git, so there is
#                   nothing to pull — re-clone the repository to a temporary
#                   directory and copy the files across, leaving runtime state
#                   (data/, logs/, .env, node_modules) alone
#
# Before this handled the second case it simply refused with "not a git working
# copy", which silently stranded every install made by install.sh.
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BRANCH="${GIT_BRANCH:-main}"
SERVICE="${UPDATE_SERVICE:-turbine-coal-simulator}"
REPO="${REPO_URL:-https://github.com/mikeehendricks/TurbineCoalSimulator.git}"

cd "$APP_DIR"

echo "==> Updating $(basename "$APP_DIR") from ${BRANCH}"

MODE=""
if [ -d .git ]; then
  MODE=git
  echo "==> Discarding any local changes to tracked files"
  git fetch --all --prune
  git checkout -- . 2>/dev/null || true
  git reset --hard "origin/${BRANCH}"
  git submodule update --init --recursive 2>/dev/null || true
else
  MODE=clone
  echo "==> Not a git working copy — re-cloning ${REPO} and copying the files in"
  TMP="$(mktemp -d)"
  trap 'rm -rf "$TMP"' EXIT
  git clone --depth 1 --branch "$BRANCH" "$REPO" "$TMP/src"
  # capture the commit before the clone's own .git is discarded
  COMMIT="$(git -C "$TMP/src" rev-parse HEAD 2>/dev/null || true)"
  rm -rf "$TMP/src/.git"
  # Copy everything except runtime state, which belongs to this installation.
  if command -v rsync >/dev/null 2>&1; then
    rsync -a --delete \
      --exclude data --exclude logs --exclude node_modules --exclude .env \
      "$TMP/src/" "$APP_DIR/"
  else
    (cd "$TMP/src" && tar --exclude=./data --exclude=./logs --exclude=./node_modules --exclude=./.env -cf - .) \
      | (cd "$APP_DIR" && tar -xf -)
  fi
  rm -rf "$TMP"
fi

# Record what is now deployed. Without .git there is no other way to know which
# build this installation is running, so build.json is the source of truth for
# the footer stamp and for the update check.
# (COMMIT is already set by the clone branch above; only a git install needs it here)
if [ -d .git ]; then COMMIT="$(git rev-parse HEAD 2>/dev/null || true)"; fi
: "${COMMIT:=}"
node -e '
const fs = require("fs");
const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
const stamp = {
  version: pkg.version,
  commit: (process.argv[1] || "") || null,
  branch: process.argv[2],
  method: process.argv[3],
  updatedAt: new Date().toISOString(),
};
fs.writeFileSync("build.json.tmp", JSON.stringify(stamp, null, 2));
fs.renameSync("build.json.tmp", "build.json");
console.log("    build stamp: v" + stamp.version + (stamp.commit ? " · " + stamp.commit.slice(0, 7) : ""));
' "$COMMIT" "$BRANCH" "$MODE"

echo "==> Installing dependencies"
npm install --omit=dev --no-audit --no-fund

echo "==> Rebuilding vendored browser libraries"
node scripts/vendor.js || true

echo "==> Done"
