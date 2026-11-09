#!/bin/sh
# Start a session's worktree: .claude/worktrees/<name> on a new claude/<name> branch from the latest origin/main.
# It links the worktree's package clones before printing the path (US-64 AC21).
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
# A new worktree starts with fresh package clones: drop any left by an earlier worktree at this same path.
GUARD="$MAIN/.claude/hooks/worktree-guard.cjs"   # the main checkout's hook, as merge-batch.mjs runs it
CLONES="$(node "$GUARD" --pkg-cache-dir "$WT" </dev/null 2>/dev/null)" || CLONES=""
case "$CLONES" in */claude-worktree-packages/?*) rm -rf "$CLONES" || echo "note: could not delete old clones at $CLONES" >&2;; esac
# Then make them now, through the hook's own linkPackages (fed the Bash event it answers): a subagent using
# this worktree by absolute path runs with the main checkout as its cwd, so the hook never fires for it.
# Never fatal: the worktree exists and is locked by now, so the path must print, or a rerun refuses the name.
node -e 'process.stdout.write(JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", cwd: process.argv[1] }))' \
  "$WT" | node "$GUARD" >/dev/null 2>&1 || true
MISSING=""
for rel in node_modules widget-src/node_modules packages/health-core/node_modules; do   # as worktree-guard.cjs
  [ ! -d "$MAIN/$rel" ] || [ -e "$WT/$rel" ] || MISSING="${MISSING:+$MISSING }$rel"
done
[ -z "$MISSING" ] || echo "note: no package links yet for $MISSING; the first Bash call run inside $WT makes them" >&2
echo "$WT"
