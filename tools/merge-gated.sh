#!/bin/sh
# Merge a PR only when every gate holds, all checked in this one run (US-64 AC32, Brad 2026-11-12: four sessions
# each wrote their own scratch "gated merge" script; one drifting is how a bad merge happens).
#   sh tools/merge-gated.sh <pr> <full 40-hex sha> [--commit-checks]
# In order, refusing at the first that fails:
#   1. the sha is 40 hex (exit 3)
#   2. the PR is open (5) and its head is that sha (6)
#   3. checks. Default: the PR's statusCheckRollup is non-empty (7), every entry finished (8), each SUCCESS or
#      SKIPPED (9), and a check named exactly `test` is SUCCESS (10). With --commit-checks (CI started by
#      workflow_dispatch, whose runs are not in the rollup): the newest check run of each name on the commit
#      (/commits/<sha>/check-runs, newest = highest id), none at all refuses (7); `test` is success (10), every
#      one is completed (8) with success or skipped (9), and at least 8 names are present (11).
#   4. no Deploy run is queued, pending, waiting or in progress (12)
#   5. then `gh pr merge <pr> --merge --match-head-commit <sha>`, nothing else; its failure exits 13.
# A gh error, timeout (60 s a call) or an answer it cannot parse refuses with exit 4; usage errors exit 2.
# Ghost runs (GitHub queues a run that never gets jobs): a run with no jobs makes no check runs, so it adds
# nothing to the rollup or to /check-runs. If it is the only CI run on the sha there are no checks and the
# merge is refused (7); beside a real run it is invisible and the real run decides. A ghost Deploy run still
# blocks (12): from here it looks like a Deploy waiting to start; the message names its id so it can be
# cancelled (`gh run cancel <id>`).
# The repo comes from the checkout's origin (gh infers it). Tests: tools/merge-gated.test.ts (a stub gh).
set -u
die() { echo "merge-gated: refused: $1" >&2; exit "$2"; }
gh() { perl -e 'alarm shift; exec @ARGV' "${MERGE_GATED_GH_TIMEOUT:-60}" gh "$@"; }

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

# Each filter prints one line: "ok", or "<code> <reason>". Check names are outside text: they go only into the
# reason, never into the decision.
if [ "$mode" = rollup ]; then
  verdict=$(gh pr view "$pr" --json statusCheckRollup --jq '[.statusCheckRollup[]
      | {n: (.name // .context), s: (if .__typename == "StatusContext" then (if .state == "PENDING" or .state == "EXPECTED" then "PENDING" else "COMPLETED" end) else .status end),
         c: (if .__typename == "StatusContext" then .state else .conclusion end)}] as $a
    | if ($a | length) == 0 then "7 the PR has no checks"
      elif any($a[]; .s != "COMPLETED") then "8 still running: \([$a[] | select(.s != "COMPLETED") | .n] | join(", "))"
      elif any($a[]; .c != "SUCCESS" and .c != "SKIPPED") then "9 not green: \([$a[] | select(.c != "SUCCESS" and .c != "SKIPPED") | "\(.n)=\(.c)"] | join(", "))"
      elif any($a[]; .n == "test" and .c == "SUCCESS") then "ok"
      else "10 no check named test succeeded" end') || die "gh pr view $pr --json statusCheckRollup failed" 4
else
  # One page of 100 holds every check CI makes; more than that refuses rather than judging part of the list.
  verdict=$(gh api "repos/{owner}/{repo}/commits/$sha/check-runs?per_page=100" --jq '
    if .total_count > (.check_runs | length) then "4 more check runs than one page holds"
    else [.check_runs | group_by(.name)[] | max_by(.id)] as $a
    | if ($a | length) == 0 then "7 the commit has no check runs"
      elif ([$a[] | select(.name == "test" and .status == "completed" and .conclusion == "success")] | length) == 0 then "10 the newest test run is not a success"
      elif any($a[]; .status != "completed") then "8 still queued or running: \([$a[] | select(.status != "completed") | .name] | join(", "))"
      elif any($a[]; .conclusion != "success" and .conclusion != "skipped") then "9 not green: \([$a[] | select(.conclusion != "success" and .conclusion != "skipped") | "\(.name)=\(.conclusion)"] | join(", "))"
      elif ($a | length) < 8 then "11 only \($a | length) checks (8 or more expected)"
      else "ok" end end') || die "gh api check-runs for $sha failed" 4
fi
case "$verdict" in
  ok) ;;
  4" "*|7" "*|8" "*|9" "*|10" "*|11" "*) die "${verdict#* }" "${verdict%% *}" ;;
  *) die "unparsable checks answer" 4 ;;
esac

deploys=$(gh run list --workflow deploy.yml --limit 20 --json databaseId,status \
  --jq '"n=\(length)", (.[] | select(.status != "completed") | "\(.databaseId) \(.status)")') || die "gh run list --workflow deploy.yml failed" 4
case "$deploys" in n=[0-9]*) ;; *) die "unparsable Deploy runs answer" 4 ;; esac
busy=$(printf '%s\n' "$deploys" | sed 1d | paste -sd ',' -)
[ -z "$busy" ] || die "a Deploy run is not finished (run status: $busy)" 12

gh pr merge "$pr" --merge --match-head-commit "$sha" || die "gh pr merge $pr failed" 13
