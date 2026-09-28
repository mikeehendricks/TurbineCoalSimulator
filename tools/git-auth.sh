#!/usr/bin/env bash
# git-auth.sh — configure git access to the GitHub repository.
#
# Reads a fine-grained personal access token from ~/.tcsim/token (mode 0600)
# and installs it in the git credential store, then points `origin` at the
# plain https URL.  Nothing secret ends up in .git/config, so `git remote -v`
# is safe to show, and nothing secret ends up in this repository either.
#
#   bash tools/git-auth.sh            # configure and verify
#   bash tools/git-auth.sh --check    # verify only, print nothing sensitive
#
# The token file lives outside the repository on purpose: the security suite
# scans the working tree for credentials and must never see one.
set -euo pipefail

REPO_OWNER="${REPO_OWNER:-mikeehendricks}"
REPO_NAME="${REPO_NAME:-TurbineCoalSimulator}"
BRANCH="${GIT_BRANCH:-main}"
TOKEN_FILE="${TCSIM_TOKEN_FILE:-$HOME/.tcsim/token}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [ ! -s "$TOKEN_FILE" ]; then
  echo "!! No token at $TOKEN_FILE" >&2
  echo "   Write it with:  umask 077; printf '%s\\n' '<token>' > $TOKEN_FILE && chmod 600 $TOKEN_FILE" >&2
  exit 1
fi
if [ "$(stat -c %a "$TOKEN_FILE" 2>/dev/null || stat -f %Lp "$TOKEN_FILE")" != "600" ]; then
  chmod 600 "$TOKEN_FILE" 2>/dev/null || true
fi
TOKEN="$(tr -d ' \t\r\n' < "$TOKEN_FILE")"

if [ "${1:-}" = "--check" ]; then
  code="$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $TOKEN" \
    -H 'Accept: application/vnd.github+json' "https://api.github.com/repos/$REPO_OWNER/$REPO_NAME")"
  case "$code" in
    200) echo "token OK — read/write access to $REPO_OWNER/$REPO_NAME" ;;
    401|403) echo "token REJECTED (http $code) — generate a new fine-grained token with Contents: Read and write" >&2; exit 1 ;;
    *) echo "could not verify token (http $code)" >&2; exit 1 ;;
  esac
  exit 0
fi

echo "==> Installing credentials for $REPO_OWNER/$REPO_NAME"
git config credential.helper store
printf 'https://%s:%s@github.com\n' "$REPO_OWNER" "$TOKEN" > "$HOME/.git-credentials"
chmod 600 "$HOME/.git-credentials"

# Token-free remote: authentication comes from the credential store.
git remote remove origin 2>/dev/null || true
git remote add origin "https://github.com/$REPO_OWNER/$REPO_NAME.git"

echo "==> Verifying"
git fetch --quiet origin
git branch --set-upstream-to="origin/$BRANCH" "$BRANCH" >/dev/null 2>&1 || true
if git push --dry-run origin "$BRANCH" >/dev/null 2>&1; then
  echo "    push access confirmed"
else
  echo "    !! push check failed — is the token valid and Contents: Read and write granted?" >&2
  exit 1
fi
echo "    origin -> $(git remote get-url origin)"
echo "    HEAD   -> $(git log --oneline -1 "origin/$BRANCH")"
echo "==> Done"
