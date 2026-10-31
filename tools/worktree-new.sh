#!/bin/sh
# Start a session's worktree: .claude/worktrees/<name> on a new claude/<name> branch from the latest origin/main.
# The branch tracks nothing, so a bare `git push` can never land on main; the first push is
# `git push -u origin claude/<name>`. Next: EnterWorktree with path=<the printed path>.
# Finish with `bash tools/worktree-done.sh <name>` once the PR is merged. Workflow: docs/git-workflow.md.
#   sh tools/worktree-new.sh <name>     (letters, digits, dot, underscore, dash)
set -eu
NAME="${1:?usage: sh tools/worktree-new.sh <name>}"
case "$NAME" in *[!A-Za-z0-9._-]*|'') echo "REFUSED: the name may use letters, digits, . _ - only" >&2; exit 1;; esac
MAIN="$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")"
WT="$MAIN/.claude/worktrees/$NAME"
if [ -e "$WT" ]; then
  echo "REFUSED: $WT already exists. Resume it (EnterWorktree path) or pick another name." >&2
  exit 1
fi
if git -C "$MAIN" show-ref -q --verify "refs/heads/claude/$NAME"; then
  echo "REFUSED: branch claude/$NAME already exists; pick another name." >&2
  exit 1
fi
git -C "$MAIN" fetch -q origin main
# Locked, so `worktree-done.sh --all` (bulk cleanup) never removes a live session's worktree; finishing it by
# name unlocks it.
git -C "$MAIN" worktree add -q --no-track --lock --reason "session worktree, created $(date -u +%Y-%m-%dT%H:%MZ)" \
  -b "claude/$NAME" "$WT" origin/main
echo "$WT"
