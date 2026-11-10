#!/bin/bash
# Finish a session's worktree once its work is on GitHub. Run from the main checkout after ExitWorktree (keep).
#   1. refuses uncommitted changes, any commit that is on no remote branch, and unmerged work whose PR is
#      not closed (merge the PR, or close it with a note on where the work went, first);
#   2. copies the worktree's own gitignored files (outputs made there; never the package links worktree-guard.cjs
#      made, nor rebuildable build or cache output) into the main checkout.
#      It never overwrites: a file that already exists in the main checkout with different content keeps the
#      worktree, listed, for a human to resolve;
#   3. unlocks (tools/worktree-new.sh locks it), removes the worktree, its package clones and its local branch (the merged remote
#      branch stays on GitHub; harmless, and the push guard keeps branch deletes Brad's).
# Nothing is ever forced: a worktree that fails a check is reported and left alone.
#   bash tools/worktree-done.sh <name>     one worktree under .claude/worktrees/ (unlocks it)
#   bash tools/worktree-done.sh --all      every worktree under .claude/worktrees/ that passes; a locked one, or
#                                          one used in the last day, may belong to a live session and is skipped
# Ported from claude_business (its copy also refreshes a scriptwriter mirror; this repo has none). Roadmap-only, so
# far: the lock and last-used checks before `git status`, fetch --prune, the worktree identity check, a re-lock
# when removal fails, and build or cache output and .claude/ never copied back.
# Workflow: docs/git-workflow.md.
set -u
MAIN="$(cd "$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")" && pwd -P)"
# Each worktree's package clones (worktree-guard.cjs linkPackages), kept outside the repo; the guard names the folder.
GUARD="$(cd "$(dirname "$0")/.." && pwd)/.claude/hooks/worktree-guard.cjs"
# The package folders, one per line, from the guard's own list (the one copy).
PACKAGE_DIRS="$(node "$GUARD" --package-dirs </dev/null 2>/dev/null)" && [ -n "$PACKAGE_DIRS" ] \
  || { echo "REFUSED: could not read the package folder list from $GUARD; nothing removed." >&2; exit 1; }
# --prune: a remote branch deleted on GitHub must not still count as "pushed".
git -C "$MAIN" fetch -q --prune origin || { echo "REFUSED: git fetch failed; nothing removed." >&2; exit 1; }

finish() { # $1 = worktree path, $2 = 1 to unlock a locked worktree; prints one line; returns 0 if removed
  local WT="$1" UNLOCK="$2" BR LOCAL UNMERGED STATE f CLONES rel
  local -a differ=() skipped=()
  [ -d "$WT" ] || { echo "skip  $WT: not a folder"; return 1; }
  CLONES="$(node "$GUARD" --pkg-cache-dir "$WT" </dev/null 2>/dev/null)" || CLONES="/nonexistent-clones"
  BR="$(git -C "$WT" rev-parse --abbrev-ref HEAD 2>/dev/null)" || { echo "skip  $WT: not a git worktree"; return 1; }
  # A plain folder (or a worktree that lost its .git file) resolves to the main checkout's git: it must be its own
  # top level and listed by `git worktree list`, or the steps below would act on the main checkout.
  local TOP; TOP="$(cd "$WT" && pwd -P)"
  if [ "$(cd "$(git -C "$WT" rev-parse --show-toplevel)" && pwd -P)" != "$TOP" ] \
    || ! git -C "$MAIN" worktree list --porcelain | sed -n 's/^worktree //p' | while IFS= read -r l; do
         [ -d "$l" ] && [ "$(cd "$l" && pwd -P)" = "$TOP" ] && echo y; done | grep -q y; then
    echo "skip  $WT: not a registered worktree of this repo"; return 1
  fi
  # The lock and last-used checks come before `git status`, which refreshes the index and so its mtime.
  if [ "$UNLOCK" != 1 ]; then
    local GD; GD="$(git -C "$WT" rev-parse --absolute-git-dir)"
    if [ -e "$GD/locked" ]; then echo "skip  $WT [$BR]: locked (a live session's); finish it by name"; return 1; fi
    # Unlocked worktrees made by other tools (agent isolation, EnterWorktree name) may still be in use.
    if [ -n "$(find "$GD" -maxdepth 1 \( -name index -o -name HEAD \) -mtime -1 2>/dev/null)" ]; then
      echo "skip  $WT [$BR]: used in the last day; finish it by name if it is done"; return 1
    fi
  fi
  if [ -n "$(git -C "$WT" status --porcelain)" ]; then echo "keep  $WT [$BR]: uncommitted changes"; return 1; fi
  LOCAL="$(git -C "$WT" rev-list --count HEAD --not --remotes)"
  if [ "$LOCAL" != 0 ]; then echo "keep  $WT [$BR]: $LOCAL commit(s) on no remote branch; push them"; return 1; fi
  UNMERGED="$(git -C "$WT" rev-list --count origin/main..HEAD)"
  if [ "$UNMERGED" != 0 ]; then
    STATE="$(cd "$WT" && gh pr list --head "$BR" --state all --json state --jq '.[0].state' 2>/dev/null)"
    if [ "$STATE" != CLOSED ]; then
      echo "keep  $WT [$BR]: $UNMERGED commit(s) not on origin/main, PR ${STATE:-none}; merge or close it first"; return 1
    fi
  fi
  # Copy back the worktree's own gitignored files and symlinks; a package link worktree-guard.cjs made (to the
  # worktree's clone, or an older one to the same path in the main checkout) is skipped. Copies never clobber (cp -n), and every
  # file is compared after the copy, so a concurrent cleanup that wrote the same path first shows up as a
  # difference, not a loss.
  while IFS= read -r -d '' f; do
    # Finder junk is never worth keeping a worktree for; a dependency install is never copied (reinstall in main);
    # build and cache output (.gitignore) is rebuilt, and both checkouts usually hold a different copy (so are the
    # iOS engine bundle, its sidecar and the parity fixtures: ios/scripts/build-engine.mjs's gitignored output; a
    # tracked file never reaches this list, `git status` above refuses its edits). .claude/ (settings, hooks) never flows back: a worktree's settings.local.json must not
    # reach the main checkout; those files are listed, not copied, and go with the worktree.
    case "/$f" in */.claude/*) skipped+=("$f"); continue;; esac
    case "/$f" in */.DS_Store|*/._*|*/node_modules/*|*/dist/*|*/dist-pages/*|*/_site/*|*/build/*|*/.cache/*|\
      */.react-router/*|*/.vite/*|*/.stryker-tmp*|*/reports/mutation/*|*.map|\
      /ios/HealthRoadmap/Engine/health-engine.js|/ios/HealthRoadmap/Engine/health-engine.json|/ios/HealthRoadmapTests/Fixtures/*) continue;; esac
    if [ -L "$WT/$f" ]; then
      case "$(readlink "$WT/$f")" in "$MAIN/$f"|"$CLONES/$f") continue;; esac
    fi
    [ -f "$WT/$f" ] || [ -L "$WT/$f" ] || continue
    if [ ! -e "$MAIN/$f" ] && [ ! -L "$MAIN/$f" ]; then
      { [[ "$f" != */* ]] || mkdir -p "$MAIN/${f%/*}"; } && cp -pPn "$WT/$f" "$MAIN/$f" || { echo "keep  $WT [$BR]: copying $f back failed"; return 1; }
    fi
    if [ -L "$WT/$f" ] || [ -L "$MAIN/$f" ]; then
      [ -L "$WT/$f" ] && [ -L "$MAIN/$f" ] && [ "$(readlink "$WT/$f")" = "$(readlink "$MAIN/$f")" ] || differ+=("$f")
    else
      cmp -s "$WT/$f" "$MAIN/$f" || differ+=("$f")
    fi
  done < <(git -C "$WT" -c core.quotePath=off ls-files -z --others --ignored --exclude-standard)
  if [ ${#differ[@]} -gt 0 ]; then
    echo "keep  $WT [$BR]: these gitignored files differ from the main checkout's copy; keep the right one by hand, then rerun:"
    printf '    %s\n' "${differ[@]}"
    return 1
  fi
  if [ ${#skipped[@]} -gt 0 ]; then
    echo "note  $WT [$BR]: not copied back (.claude/ never flows to the main checkout), deleted with the worktree:"
    printf '    %s\n' "${skipped[@]}"
  fi
  local WASLOCKED=""; [ -e "$(git -C "$WT" rev-parse --absolute-git-dir)/locked" ] && WASLOCKED=1
  # Remove the package links worktree-guard.cjs made: only those paths, only when they point at the worktree's
  # clones or (older ones) the main checkout, and only the link (no trailing slash). Never delete links broadly:
  # a tracked link is the work itself.
  while IFS= read -r rel; do
    [ -n "$rel" ] && [ -L "$WT/$rel" ] || continue
    case "$(readlink "$WT/$rel")" in "$MAIN/$rel"|"$CLONES/$rel") rm -f "$WT/$rel";; esac
  done <<< "$PACKAGE_DIRS"
  git -C "$MAIN" worktree unlock "$WT" 2>/dev/null
  if ! git -C "$MAIN" worktree remove "$WT"; then
    [ -z "$WASLOCKED" ] || git -C "$MAIN" worktree lock --reason "session worktree (re-locked by worktree-done)" "$WT" 2>/dev/null
    echo "keep  $WT [$BR]: git refused to remove it"; return 1
  fi
  case "$CLONES" in */claude-worktree-packages/?*) rm -rf "$CLONES";; esac
  [ "$BR" = HEAD ] || git -C "$MAIN" branch -q -D "$BR"
  echo "done  $WT [$BR]"
}

if [ "${1:-}" = --all ]; then
  git -C "$MAIN" worktree prune
  for WT in "$MAIN"/.claude/worktrees/*/; do [ -d "$WT" ] && finish "${WT%/}" 0; done
  exit 0
fi
NAME="${1:?usage: bash tools/worktree-done.sh <name> | --all}"
finish "$MAIN/.claude/worktrees/$NAME" 1 || exit 1
git -C "$MAIN" worktree prune
