#!/bin/sh
# Merge a PR only when every gate holds, all checked in this one run (US-64 AC32, Brad 2026-11-12: four sessions
# each wrote their own scratch "gated merge" script; one drifting is how a bad merge happens).
#   sh tools/merge-gated.sh <pr> <full 40-hex sha> [--commit-checks]
# In order, refusing at the first that fails:
#   1. the sha is 40 hex (exit 3)
#   2. the PR is open (5) and its head is that sha (6)
#   3. gate files: a PR that changes tools/merge-gated.sh or .github/workflows/ci.yml must not be judged by the copy
#      it changed. This script then runs `git fetch origin main`, writes main's tools/merge-gated.sh to a temp file
#      and runs that copy with the same arguments and MERGE_GATED_FROM_MAIN=1, exiting with its code. A failed
#      fetch, or no or an empty copy on main, refuses (16): the owner merges that PR by hand. A copy run with the
#      marker skips this step. The marker guards against accidents, not against someone who sets it on purpose:
#      review of the diff is the real control. A PR that changes ci.yml also gets one stderr note: its own CI
#      result came from the PR's workflow, so the reviewer must have read that diff (a note, not a refusal:
#      workflow PRs are legitimate and Brad-reviewed). gh lists at most 100 files; a PR with more refuses (17)
#      rather than judging part of the list.
#   4. CI's own workflow: the newest ci.yml run on the sha (by createdAt) exists (11), is completed (14) and ended
#      success (15). So a job named `test` from another workflow cannot stand in for CI, and a draft PR's run
#      (every job skipped, the run's conclusion `skipped`) never passes.
#   5. default mode only: the PR's statusCheckRollup is non-empty (7), every entry finished (8), each SUCCESS or
#      SKIPPED (9), and a check named exactly `test` is SUCCESS (10). Every entry counts, even two of one name:
#      any red one refuses, whichever is newer (re-run the job to replace it). --commit-checks skips this step:
#      it is for CI started by workflow_dispatch, whose runs do not reach the PR's rollup; step 4 is its gate.
#   6. no Deploy run is unfinished (12). First one snapshot of the newest 100 runs, unfiltered: one call is atomic
#      for the runs it lists, so no status change hides a run among them. Then, for an unfinished run older than
#      that, one call per status in the order requested, waiting, pending, queued, in_progress, all twice: forward
#      progress cannot dodge that order, and the second pass catches a run that went in_progress -> waiting (an
#      environment review) and back. Unguarded: a run older than 100 newer runs that also flips status in step
#      with both passes. --match-head-commit and Deploy's own concurrency group are the backstop.
#   7. then `gh pr merge <pr> --merge --match-head-commit <sha>`, nothing else; its failure exits 13.
# A gh error, timeout or an answer it cannot parse refuses with exit 4; usage errors exit 2. Every gh call,
# the merge too, and the git fetch get MERGE_GATED_GH_TIMEOUT seconds (default 60; zero or not a number is 60). A
# merge that times out exits 13 with its outcome unknown: check the PR.
# Ghost runs (GitHub queues a run that never gets jobs): one newer than the real CI run refuses (14) and is named
# so it can be cancelled (`gh run cancel <id>`); an older one is ignored. It adds nothing to the rollup. A ghost
# Deploy run blocks (12) the same way, by id.
# The repo comes from the checkout's origin (gh infers it). Tests: tools/merge-gated.test.ts (a stub gh).
set -u
die() { echo "merge-gated: refused: $1" >&2; exit "$2"; }
T=${MERGE_GATED_GH_TIMEOUT:-60}
case "$T" in *[!0-9]*|'') T=60 ;; esac
[ "$T" -gt 0 ] || T=60
# gh is Go, which ignores SIGALRM, so `alarm; exec gh` cannot stop it. Perl forks the command into its own process
# group (stdin /dev/null: a gate never prompts), waits, and on the alarm SIGKILLs the group and exits 124. INT,
# TERM and HUP kill the group too, so nothing it starts outlives the script.
bounded() {
  perl -e 'my $t = shift; my $pid = fork; defined $pid or exit 125;
    if (!$pid) { setpgrp(0, 0); open STDIN, "<", "/dev/null"; exec @ARGV or exit 127 }
    my $end = sub { kill "KILL", -$pid, $pid; exit $_[0] };
    $SIG{ALRM} = sub { $end->(124) }; $SIG{$_} = sub { $end->(130) } for qw(INT TERM HUP);
    alarm $t; waitpid $pid, 0; alarm 0;
    exit($? & 127 ? 128 + ($? & 127) : $? >> 8)' "$T" "$@"
}
gh() { bounded gh "$@"; }

args="$*"
pr=${1:-}; sha=${2:-}; mode=${3:-rollup}
case "$pr" in ''|*[!0-9]*) die "usage: sh tools/merge-gated.sh <pr> <full sha> [--commit-checks]" 2 ;; esac
case "$mode" in rollup|--commit-checks) ;; *) die "usage: sh tools/merge-gated.sh <pr> <full sha> [--commit-checks]" 2 ;; esac
[ $# -le 3 ] || die "usage: sh tools/merge-gated.sh <pr> <full sha> [--commit-checks]" 2
printf '%s' "$sha" | grep -Eq '^[0-9a-f]{40}$' || die "'$sha' is not a full 40-hex sha (lowercase)" 3

head=$(gh pr view "$pr" --json state,headRefOid --jq '"\(.state) \(.headRefOid)"') || die "gh pr view $pr failed" 4
case "$head" in
  OPEN" $sha") ;;
  OPEN" "[0-9a-f]*) printf '%s' "${head#OPEN }" | grep -Eq '^[0-9a-f]{40}$' || die "unparsable PR answer: $head" 4
    die "PR $pr head is ${head#OPEN }, not $sha (pushed since the review?)" 6 ;;
  [A-Z]*" "[0-9a-f]*) die "PR $pr is ${head%% *}, not OPEN" 5 ;;
  *) die "unparsable PR answer: $head" 4 ;;
esac

files=$(gh pr view "$pr" --json changedFiles,files --jq '[.files // [] | .[].path] as $p
  | "\(.changedFiles) \($p | length) \(any($p[]; . == "tools/merge-gated.sh")) \(any($p[]; . == ".github/workflows/ci.yml"))"') \
  || die "gh pr view $pr --json files failed" 4
case "$files" in
  [0-9]*" "[0-9]*" "true" "*|[0-9]*" "[0-9]*" "false" "*) set -- $files ;;
  *) die "unparsable files answer" 4 ;;
esac
if [ "${MERGE_GATED_FROM_MAIN:-}" != 1 ] && { [ "$3" = true ] || [ "$4" = true ]; }; then
  tmp=$(mktemp "${TMPDIR:-/tmp}/merge-gated.XXXXXX") || die "cannot make a temp file" 16
  trap 'rm -f "$tmp"' EXIT
  bounded git fetch -q origin main >&2 || die "PR $pr changes a gate file and \`git fetch origin main\` failed, so main's copy cannot judge it: the owner merges this PR by hand" 16
  git show origin/main:tools/merge-gated.sh > "$tmp" 2>/dev/null && [ -s "$tmp" ] \
    || die "PR $pr changes a gate file and main has no copy of the gate yet: the owner merges this PR by hand" 16
  echo "merge-gated: PR $pr changes a gate file; main's copy judges it" >&2
  MERGE_GATED_FROM_MAIN=1 sh "$tmp" $args; exit $?
fi
[ "$4" = true ] && echo "merge-gated: note: PR $pr changes .github/workflows/ci.yml, so its own CI result came from the PR's workflow; the reviewer must have read that diff" >&2
[ "$1" = "$2" ] || die "PR $pr changes $1 files and gh lists $2; cannot check them for gate files" 17

# Each filter prints one line: "ok", or "<code> <reason>". Check names are outside text: they go only into the
# reason, never into the decision.
verdict=$(gh run list --workflow ci.yml --commit "$sha" --json databaseId,status,conclusion,createdAt --jq '
  if length == 0 then "11 no CI (ci.yml) run on this sha"
  else (sort_by(.createdAt, .databaseId) | last) as $r
  | if $r.status != "completed" then "14 the newest CI run \($r.databaseId) is \($r.status)"
    elif $r.conclusion != "success" then "15 the newest CI run \($r.databaseId) ended \($r.conclusion)"
    else "ok" end end') || die "gh run list --workflow ci.yml failed" 4
case "$verdict" in
  ok) ;;
  11" "*|14" "*|15" "*) die "${verdict#* }" "${verdict%% *}" ;;
  *) die "unparsable CI runs answer" 4 ;;
esac

if [ "$mode" = rollup ]; then
  verdict=$(gh pr view "$pr" --json statusCheckRollup --jq '[.statusCheckRollup[]
      | {n: (.name // .context), s: (if .__typename == "StatusContext" then (if .state == "PENDING" or .state == "EXPECTED" then "PENDING" else "COMPLETED" end) else .status end),
         c: (if .__typename == "StatusContext" then .state else .conclusion end)}] as $a
    | if ($a | length) == 0 then "7 the PR has no checks"
      elif any($a[]; .s != "COMPLETED") then "8 still running: \([$a[] | select(.s != "COMPLETED") | .n] | join(", "))"
      elif any($a[]; .c != "SUCCESS" and .c != "SKIPPED") then "9 not green: \([$a[] | select(.c != "SUCCESS" and .c != "SKIPPED") | "\(.n)=\(.c)"] | join(", "))"
      elif any($a[]; .n == "test" and .c == "SUCCESS") then "ok"
      else "10 no check named test succeeded" end') || die "gh pr view $pr --json statusCheckRollup failed" 4
  case "$verdict" in
    ok) ;;
    7" "*|8" "*|9" "*|10" "*) die "${verdict#* }" "${verdict%% *}" ;;
    *) die "unparsable checks answer" 4 ;;
  esac
fi

# Refuses (12) if the runs `gh run list --workflow deploy.yml "$@"` lists hold one that is not completed.
no_deploy() {
  deploys=$(gh run list --workflow deploy.yml "$@" --json databaseId,status \
    --jq '[.[] | select(.status != "completed")] | "n=\(length)", (.[] | "\(.databaseId) \(.status)")') \
    || die "gh run list --workflow deploy.yml failed" 4
  case "$deploys" in
    n=0) ;;
    n=[0-9]*) die "a Deploy run is not finished (run status: $(printf '%s\n' "$deploys" | sed 1d | paste -sd ',' -))" 12 ;;
    *) die "unparsable Deploy runs answer" 4 ;;
  esac
}
no_deploy --limit 100
for s in requested waiting pending queued in_progress requested waiting pending queued in_progress; do
  no_deploy --status "$s" --limit 5
done

gh pr merge "$pr" --merge --match-head-commit "$sha"; rc=$?
[ "$rc" = 0 ] && exit 0
[ "$rc" = 124 ] && die "gh pr merge $pr timed out after ${T}s; the merge's outcome is unknown: check the PR (gh pr view $pr --json state)" 13
die "gh pr merge $pr failed (exit $rc)" 13
