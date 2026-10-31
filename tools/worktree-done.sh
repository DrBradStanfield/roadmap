#!/bin/bash
# Finish a session's worktree once its work is on GitHub. Run from the main checkout after ExitWorktree (keep).
#   1. refuses uncommitted changes, any commit that is on no remote branch, and unmerged work whose PR is
#      not closed (merge the PR, or close it with a note on where the work went, first);
#   2. copies the worktree's own gitignored files (outputs made there; never links to the main checkout's
#      files, its node_modules clones, or rebuildable build or cache output) into the main checkout.
#      It never overwrites: a file that already exists in the main checkout with different content keeps the
#      worktree, listed, for a human to resolve;
#   3. unlocks (tools/worktree-new.sh locks it), removes the worktree and its local branch (the merged remote
#      branch stays on GitHub; harmless, and the push guard keeps branch deletes Brad's).
# Nothing is ever forced: a worktree that fails a check is reported and left alone.
#   bash tools/worktree-done.sh <name>     one worktree under .claude/worktrees/ (unlocks it)
#   bash tools/worktree-done.sh --all      every worktree under .claude/worktrees/ that passes; a locked one, or
#                                          one used in the last day, may belong to a live session and is skipped
# Ported from claude_business (its copy also refreshes a scriptwriter mirror; this repo has none).
# Workflow: docs/git-workflow.md.
set -u
MAIN="$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")"
# --prune: a remote branch deleted on GitHub must not still count as "pushed".
git -C "$MAIN" fetch -q --prune origin || { echo "REFUSED: git fetch failed; nothing removed." >&2; exit 1; }

finish() { # $1 = worktree path, $2 = 1 to unlock a locked worktree; prints one line; returns 0 if removed
  local WT="$1" UNLOCK="$2" BR LOCAL UNMERGED STATE f
  local -a differ=()
  [ -d "$WT" ] || { echo "skip  $WT: not a folder"; return 1; }
  BR="$(git -C "$WT" rev-parse --abbrev-ref HEAD 2>/dev/null)" || { echo "skip  $WT: not a git worktree"; return 1; }
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
  # Copy back the worktree's own gitignored files and symlinks; a link to the same path in the main checkout
  # (claude_business's guard makes them; here only by hand) is skipped. Copies never clobber (cp -n), and every
  # file is compared after the copy, so a concurrent cleanup that wrote the same path first shows up as a
  # difference, not a loss.
  while IFS= read -r -d '' f; do
    # Finder junk is never worth keeping a worktree for; a dependency install is never copied (reinstall in main);
    # build and cache output (.gitignore) is rebuilt, and both checkouts usually hold a different copy.
    # .claude/ (settings, hooks) never flows back: a worktree's settings.local.json must not reach the main checkout.
    case "/$f" in */.claude/*|*/.DS_Store|*/._*|*/node_modules/*|*/dist/*|*/dist-pages/*|*/_site/*|*/build/*|*/.cache/*|\
      */.react-router/*|*/.vite/*|*/.stryker-tmp*|*/reports/mutation/*|*.log|*.map) continue;; esac
    [ -L "$WT/$f" ] && [ "$(readlink "$WT/$f")" = "$MAIN/$f" ] && continue
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
  local WASLOCKED=""; [ -e "$(git -C "$WT" rev-parse --absolute-git-dir)/locked" ] && WASLOCKED=1
  git -C "$MAIN" worktree unlock "$WT" 2>/dev/null
  if ! git -C "$MAIN" worktree remove "$WT"; then
    [ -z "$WASLOCKED" ] || git -C "$MAIN" worktree lock --reason "session worktree (re-locked by worktree-done)" "$WT" 2>/dev/null
    echo "keep  $WT [$BR]: git refused to remove it"; return 1
  fi
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
