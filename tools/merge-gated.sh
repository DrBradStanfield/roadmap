#!/bin/sh
# Merge a PR only when every gate holds, all checked in this one run (US-64 AC32, Brad 2026-11-12: four sessions
# each wrote their own scratch "gated merge" script; one drifting is how a bad merge happens).
#   sh tools/merge-gated.sh <pr> <full 40-hex sha> [--commit-checks]
# In order, refusing at the first that fails:
#   1. the sha is 40 hex (exit 3)
#   2. the PR is open (5) and its head is that sha (6)
#   3. gate files: a PR that changes tools/merge-gated.sh, tools/generated-files.json or .github/workflows/ci.yml
#      must not be judged by the copy it changed. This script then fetches main (explicit refspec), writes main's
#      tools/merge-gated.sh and tools/generated-files.json (when main has one) to a temp dir and runs that copy
#      with the same arguments and MERGE_GATED_FROM_MAIN=1, exiting with its code. A failed fetch, or no or an
#      empty copy on main, refuses (16): the owner merges that PR by hand. A copy run with the
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
#      Advisory checks are the exception: an entry named exactly `ios-compile` (iOS compile workflow; Brad
#      2026-11-13: it warns, it does not block) never refuses. Pending or not green, it gets one stderr note. The
#      list is a literal in the jq filter below, so nothing at call time can widen it.
#   6. generated files (US-64 AC34; PR 954 went green against an older main, then main went red). Pure git: it runs
#      nothing but gh, git, jq and perl, never a command from the manifest or the PR (a row's `script` is only a
#      pathspec). It fetches main (explicit refspec, so origin/main is fresh in a narrow-refspec clone) and the PR
#      head, takes their merge base, and lists the PR's paths with `git diff --name-only --no-renames`, so a rename
#      shows its old path too (gh lists only the new one): every PR fetches, as moving an input away hides from gh.
#      For each row of tools/generated-files.json (the copy beside this script; main's when the PR changes it,
#      step 3) whose output or an input matches a PR path (globs: * matches any run of characters, slash included,
#      as in a git pathspec), it refuses (9) when `git log <merge-base>..origin/main -- <output> <script>` lists a
#      commit. Main side narrowed to output and script: main's CI keeps main fresh, so an input change on main
#      that alters the output also changed the output there; one that leaves the output alone cannot make the
#      merged output stale. Residual: a main input change that matters only beside the PR's input change; main's
#      CI catches it right after the merge. The refusal says to merge main first and let CI run, naming the
#      generator. CI's freshness tests do the real check. A failed fetch or diff, or no merge base, refuses (4):
#      every PR fetches, so a failed fetch refuses every merge. Main is always refs/remotes/origin/main (a local
#      branch named origin/main cannot shadow it) and paths come out unquoted (core.quotepath=false). A matched row
#      whose output, script or generator is not a non-empty one-line string refuses (4).
#      Staleness (AC35, a note, never a refusal): when main has commits past the merge base, one stderr line says
#      how many. The merge base is the CI base: what a --commit-checks run tested, and no newer than the main a
#      pull_request run merged in, so the count may overstate, never understate.
#   7. stop the line (US-64 AC35): the newest completed ci.yml run on main (by createdAt, among the newest 20; any
#      event but pull_request, which a fork's branch named main could add) must not have ended failure,
#      timed_out or startup_failure (18, naming the run's URL and conclusion). success passes; so do cancelled (a
#      choice, not a failing test) and skipped (tested nothing). A PR labelled exactly fix-main passes a red main
#      with one stderr note. No such run refuses (4).
#   8. no Deploy run is unfinished (12). First one snapshot of the newest 100 runs, unfiltered: one call is atomic
#      for the runs it lists, so no status change hides a run among them. Then, for an unfinished run older than
#      that, one call per status in the order requested, waiting, pending, queued, in_progress, all twice: forward
#      progress cannot dodge that order, and the second pass catches a run that went in_progress -> waiting (an
#      environment review) and back. Unguarded: a run older than 100 newer runs that also flips status in step
#      with both passes. --match-head-commit and Deploy's own concurrency group are the backstop.
#   9. then `gh pr merge <pr> --merge --match-head-commit <sha>`, nothing else; its failure exits 13.
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
  | "\(.changedFiles) \($p | length) \(any($p[]; . == "tools/merge-gated.sh" or . == "tools/generated-files.json")) \(any($p[]; . == ".github/workflows/ci.yml"))"') \
  || die "gh pr view $pr --json files failed" 4
case "$files" in
  [0-9]*" "[0-9]*" "true" "*|[0-9]*" "[0-9]*" "false" "*) set -- $files ;;
  *) die "unparsable files answer" 4 ;;
esac
if [ "${MERGE_GATED_FROM_MAIN:-}" != 1 ] && { [ "$3" = true ] || [ "$4" = true ]; }; then
  tmp=$(mktemp -d "${TMPDIR:-/tmp}/merge-gated.XXXXXX") || die "cannot make a temp dir" 16
  trap 'rm -rf "$tmp"' EXIT
  bounded git fetch -q origin +refs/heads/main:refs/remotes/origin/main >&2 || die "PR $pr changes a gate file and the fetch of main failed, so main's copy cannot judge it: the owner merges this PR by hand" 16
  git show refs/remotes/origin/main:tools/merge-gated.sh > "$tmp/merge-gated.sh" 2>/dev/null && [ -s "$tmp/merge-gated.sh" ] \
    || die "PR $pr changes a gate file and main has no copy of the gate yet: the owner merges this PR by hand" 16
  git show refs/remotes/origin/main:tools/generated-files.json > "$tmp/generated-files.json" 2>/dev/null || rm -f "$tmp/generated-files.json"
  echo "merge-gated: PR $pr changes a gate file; main's copy judges it" >&2
  MERGE_GATED_FROM_MAIN=1 sh "$tmp/merge-gated.sh" $args; exit $?
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
  # Line 1 is the verdict, from the non-advisory entries only. Any later lines name an advisory check (the literal
  # list below, exact names) that is pending or not green; they go to stderr and never refuse.
  verdict=$(gh pr view "$pr" --json statusCheckRollup --jq '[.statusCheckRollup[]
      | {n: (.name // .context | if type == "string" then gsub("[\n\r]"; " ") else . end), s: (if .__typename == "StatusContext" then (if .state == "PENDING" or .state == "EXPECTED" then "PENDING" else "COMPLETED" end) else .status end),
         c: (if .__typename == "StatusContext" then .state else .conclusion end)}] as $all
    | ["ios-compile"] as $adv
    | [$all[] | select(.n | IN($adv[]) | not)] as $a
    | (if ($a | length) == 0 then "7 the PR has no checks"
      elif any($a[]; .s != "COMPLETED") then "8 still running: \([$a[] | select(.s != "COMPLETED") | .n] | join(", "))"
      elif any($a[]; .c != "SUCCESS" and .c != "SKIPPED") then "9 not green: \([$a[] | select(.c != "SUCCESS" and .c != "SKIPPED") | "\(.n)=\(.c)"] | join(", "))"
      elif any($a[]; .n == "test" and .c == "SUCCESS") then "ok"
      else "10 no check named test succeeded" end),
      ($all[] | select(.n | IN($adv[])) | select(.s != "COMPLETED" or (.c != "SUCCESS" and .c != "SKIPPED"))
        | "advisory check \(.n) is \(if .s != "COMPLETED" then .s else .c end); not blocking")') \
    || die "gh pr view $pr --json statusCheckRollup failed" 4
  printf '%s\n' "$verdict" | sed -n '2,$s/^/merge-gated: note: /p' >&2
  verdict=$(printf '%s\n' "$verdict" | sed -n '1p')
  case "$verdict" in
    ok) ;;
    7" "*|8" "*|9" "*|10" "*) die "${verdict#* }" "${verdict%% *}" ;;
    *) die "unparsable checks answer" 4 ;;
  esac
fi

bounded git fetch -q origin +refs/heads/main:refs/remotes/origin/main "refs/pull/$pr/head" >&2 && git cat-file -e "$sha^{commit}" \
  || die "cannot fetch main and PR $pr's head $sha" 4
base=$(git merge-base refs/remotes/origin/main "$sha") || die "PR $pr's head $sha has no merge base with main" 4
behind=$(git rev-list --count "$base..refs/remotes/origin/main") || die "git rev-list on main failed" 4
case "$behind" in 0) ;; 1) w=commit ;; *) w=commits ;; esac
[ "$behind" = 0 ] || echo "merge-gated: note: main has moved $behind $w since this PR's merge base; CI may have tested an older main" >&2
paths=$(git -c core.quotepath=false diff --name-only --no-renames "$base" "$sha") || die "git diff on PR $pr failed" 4
# The rows whose output or an input matches a PR path, one index a line. A glob becomes an anchored regex:
# * any run of characters (slash too, as in a git pathspec), ? one character, everything else literal.
manifest=${0%/*}/generated-files.json
hits=$(jq -r --arg p "$paths" 'def re: "^" + gsub("(?<c>[.+^$(){}|\\[\\]\\\\])"; "\\\(.c)") + "$" | gsub("\\*"; ".*") | gsub("\\?"; ".");
  ($p | split("\n")) as $p | .rows | to_entries[]
  | select(any(.value.output, .value.inputs[]; re as $r | any($p[]; test($r)))) | .key' "$manifest") \
  || die "cannot read $manifest" 4
for i in $hits; do
  row=$(jq -r --argjson i "$i" '.rows[$i] | [.output, .script, .generator]
    | if all(if type == "string" then length > 0 and (contains("\n") | not) else false end) then .[]
      else error("row \($i) needs a non-empty one-line output, script and generator") end' "$manifest") \
    || die "cannot read $manifest" 4
  # One field a line (each non-empty, so none is dropped), unglobbed: output and script go to git as pathspecs.
  set -f; IFS='
'; set -- $row; unset IFS; set +f
  moved=$(git log -1 --format=%H "$base..refs/remotes/origin/main" -- "$1" "$2") || die "git log on $1 failed" 4
  [ -z "$moved" ] || die "$1: main has changed it or its generator script ($2) since this PR's base; merge main first, then let CI run (its generator: \`$3\`)" 9
done

# Stop the line: one line, "ok", "none" or "red <run url> ended <conclusion>".
red=$(gh run list --workflow ci.yml --branch main --status completed --limit 20 --json databaseId,conclusion,event,createdAt,url --jq '
  [.[] | select(.event != "pull_request")] | if length == 0 then "none"
  else sort_by(.createdAt, .databaseId) | last
  | if IN(.conclusion; "failure", "timed_out", "startup_failure") then "red \(.url // .databaseId) ended \(.conclusion)" else "ok" end end') \
  || die "gh run list --workflow ci.yml --branch main failed" 4
case "$red" in
  ok) ;;
  "red "*) fix=$(gh pr view "$pr" --json labels --jq 'any(.labels[]; .name == "fix-main")') || die "gh pr view $pr --json labels failed" 4
    case "$fix" in
      true) echo "merge-gated: note: main is red (its newest CI run ${red#red }); PR $pr carries fix-main, so it may merge" >&2 ;;
      false) die "main is red: its newest completed CI run ${red#red }; fix main first, or label the PR that fixes it fix-main" 18 ;;
      *) die "unparsable labels answer" 4 ;;
    esac ;;
  none) die "no completed CI (ci.yml) run on main among the newest 20" 4 ;;
  *) die "unparsable main CI runs answer" 4 ;;
esac

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
