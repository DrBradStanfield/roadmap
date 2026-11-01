#!/bin/bash
# Manual release, step 0 (docs/deploy-runbook.md): make a detached checkout of exactly origin/main OUTSIDE the
# repo, with its own packages, and print its path. Only merged code ships (Brad 2026-10-31/11-01,
# docs/git-workflow.md). Outside the repo because `shopify app deploy` refuses while any worktree sits inside it
# (docs/reference.md, 2026-10-01).
#   bash tools/release-checkout.sh [folder]     (default: ${TMPDIR:-/tmp}/deploy-checkout)
# Run from the main checkout's root, never a session worktree. Refuses a folder that already exists: an old
# checkout may hold edits or another commit. When done: `git worktree remove --force <folder>` (--force: the
# build output). Any failure exits non-zero and prints nothing on stdout.
set -euo pipefail
MAIN="$(pwd -P)"
refuse() { echo "REFUSED: $*" >&2; exit 1; }
[ "$(git rev-parse --show-toplevel 2>/dev/null)" = "$MAIN" ] \
  && [ "$(git rev-parse --path-format=absolute --git-common-dir)" = "$MAIN/.git" ] \
  || refuse "run this from the main checkout's root, never a session worktree"
if [ -z "${1:-}" ]; then
  case "${TMPDIR:-/tmp}" in /*) ;; *) refuse "TMPDIR ($TMPDIR) is not an absolute path; pass the folder explicitly";; esac
fi
DEST="${1:-${TMPDIR:-/tmp}/deploy-checkout}"
DEST="${DEST%/}"
[ ! -e "$DEST" ] && [ ! -L "$DEST" ] || refuse "$DEST already exists; remove it first (git worktree remove --force \"$DEST\")"
# Resolve through its existing parent (a symlinked parent included): never inside the main checkout, where
# `shopify app deploy` would find two apps and the main checkout's own files could be mixed in.
PARENT="$(cd "$(dirname "$DEST")" 2>/dev/null && pwd -P)" || refuse "the parent folder of $DEST does not exist"
DEST="$PARENT/$(basename "$DEST")"
lc() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }   # the Mac disk ignores case
case "$(lc "$DEST")/" in "$(lc "$MAIN")"/*) refuse "$DEST is inside the main checkout; release from a folder outside it";; esac
git fetch -q origin main
git worktree add -q --detach "$DEST" origin/main
cd "$DEST"
[ ! -e "$MAIN/.env" ] || ln -s "$MAIN/.env" .env   # a link to the secrets, never a copy
npm ci >&2                                          # its own packages, never a link to the main checkout's
[ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] || refuse "HEAD is not origin/main"
[ -z "$(git status --porcelain --untracked-files=no)" ] || refuse "the release checkout has tracked changes"
echo "$DEST"
