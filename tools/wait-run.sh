#!/bin/sh
# Wait for a GitHub Actions run or a PR's checks, then print one short verdict (Brad 2026-11-10: hand-typed
# `until gh run view ... | jq ...` loops hung for hours or were refused by the worktree sandbox).
#
#   sh tools/wait-run.sh deploy <run-id>   wait until the run completes; print its conclusion, head sha, each
#                                          job's name=conclusion and the live healthz status
#   sh tools/wait-run.sh pr <number>       wait until no check is pending; print pass/fail counts, the head sha
#                                          and mergeability; while checks are unfinished, a PR GitHub reports
#                                          in conflict with main on two polls in a row gets no new CI run, so
#                                          it says so and exits 1; no successful check named `test` (a draft
#                                          PR, every check skipped) is not a pass: it says so and exits 1
#
# Exit: 0 success; 1 the run or a check failed, no `test` check passed, a final read failed, or healthz is not
# 200; 2 usage; 3 gave up
# (WAIT_RUN_MAX_MIN of wall-clock time, default 90, at most 1440, or 10 gh errors in a row; each gh call is killed at 60 s,
# even a hung gh that ignores signals).
# Every exit the script controls (not SIGKILL) ends with one JSON line, the last on stdout (`tail -1`), naming its
# outcome (US-64 AC26):
#   {"wait_run":"<outcome>","run"|"pr":<id>,"sha":"<head, or empty>","detail":"<short>"}
# success 0; run_failed, unhealthy, result_unreadable (deploy), checks_failed, untested, conflict, head_unreadable
# (pr) 1; usage 2 (no id key; also a bad id, mode or WAIT_RUN_MAX_MIN, which must be a whole number up to 1440); timeout,
# gh_errors 3; interrupted on INT, TERM or HUP, and the exit is the signal's 128+n (130, 143, 129).
#
# Cheap on purpose: many sessions run this at once on one GitHub account, and on 2026-11-10 they spent the
# 5000/hour REST limit (US-64 AC26). Each poll is ONE gh call: deploy reads the run over REST, pr reads the checks
# over GraphQL (a separate budget). Polls every WAIT_RUN_INTERVAL seconds (default 60, never less), every 120 s
# after 10 min and every 300 s after 30 min. Every 10th poll, and after a gh error, it reads `gh api rate_limit`
# (free); with under 200 left in the budget its mode spends (core for deploy, graphql for pr) it sleeps until the
# reset instead of polling. It prints the budget left in both (one free `gh api rate_limit` read each) to stderr
# when the wait starts and when it ends, on every exit after the usage check, so the next shortage names its
# spender; a failed read prints nothing and never changes the exit code. Plain POSIX sh plus perl (macOS ships
# it) for the per-call limit, and gh's own --jq (no jq needed). Run it in the background (run_in_background) so
# the session is woken when it ends.
set -u
mode=${1:-}; id=${2:-}
interval=${WAIT_RUN_INTERVAL:-60}
# Checked before the arithmetic, which would fail on 1.5 with a shell error and no status line. Leading zeros are
# dropped, so 010 is ten minutes, not octal.
max_min=${WAIT_RUN_MAX_MIN:-90}
case "$max_min" in *[!0-9]*) mode=bad; max_min=0 ;; esac
max_min=${max_min#"${max_min%%[!0]*}"}
[ ${#max_min} -le 4 ] && [ "${max_min:-0}" -le 1440 ] || { mode=bad; max_min=0; }
max_s=$(( ${max_min:-0} * 60 ))
healthz=${WAIT_RUN_HEALTHZ:-https://health-tool-app.fly.dev/healthz}
case "$id" in ''|*[!0-9]*) mode=bad ;; esac
case "$interval$max_s" in *[!0-9]*) mode=bad ;; esac
# The status line. detail can hold a check or job name (outside text): one line, invalid UTF-8 turned to U+FFFD,
# control characters to spaces, at most 200 characters, JSON-escaped; sha is kept only if it is hex. The id prints
# without leading zeros, as JSON needs.
say_status() {
  perl -CS -MEncode -e 'my ($o, $k, $id, $sha, $d) = map { decode("UTF-8", $_) } @ARGV;
    $id =~ s/\A0+(?=\d)//; $sha = "" unless $sha =~ /\A[0-9a-f]{1,64}\z/;
    $d =~ s/[\x00-\x1f\x7f-\x9f\x{2028}\x{2029}]+/ /g; $d = substr($d, 0, 200); $d =~ s/(["\\])/\\$1/g;
    print qq({"wait_run":"$o",), ($k eq "" ? "" : qq("$k":$id,)), qq("sha":"$sha","detail":"$d"}\n)' -- "$@"
}
case "$mode" in
  deploy|pr) ;;
  *) echo "usage: sh tools/wait-run.sh deploy <run-id> | pr <number>" >&2
     say_status usage "" "" "" "usage: deploy <run-id> | pr <number>"; exit 2 ;;
esac
key=run; [ "$mode" = pr ] && key=pr
outcome=interrupted; sha=; detail="ended before a verdict"
# Each exit path names its outcome; the EXIT trap prints the status line.
finish() { outcome=$1; detail=$3; exit "$2"; }
[ "$interval" -ge 60 ] || interval=60
budget=core; [ "$mode" = pr ] && budget=graphql

start=$(date +%s); errors=0; polls=0; conflicts=0
# Every gh call gets WAIT_RUN_GH_TIMEOUT seconds (default 60; zero or not a number is 60), so a stuck request
# counts as a gh error instead of hanging the wait. gh is Go, which ignores SIGALRM, so `alarm; exec gh` cannot
# stop it: perl forks gh into its own process group, waits, and on the alarm SIGKILLs the group and exits 124.
# INT, TERM and HUP kill the group too. Copied from tools/merge-gated.sh, not shared: that gate also runs main's
# copy from a temp file, where a sourced helper would not be beside it.
T=${WAIT_RUN_GH_TIMEOUT:-60}
case "$T" in *[!0-9]*|'') T=60 ;; esac
[ "$T" -gt 0 ] || T=60
gh() {
  perl -e 'my $t = shift; my $pid = fork; defined $pid or exit 125;
    if (!$pid) { setpgrp(0, 0); open STDIN, "<", "/dev/null"; exec @ARGV or exit 127 }
    my $end = sub { kill "KILL", -$pid, $pid; exit $_[0] };
    $SIG{ALRM} = sub { $end->(124) }; $SIG{$_} = sub { $end->(130) } for qw(INT TERM HUP);
    alarm $t; waitpid $pid, 0; alarm 0;
    exit($? & 127 ? 128 + ($? & 127) : $? >> 8)' "$T" gh "$@"
}
say_budget() {
  b=$(gh api rate_limit --jq '"core=\(.resources.core.remaining) graphql=\(.resources.graphql.remaining)"' 2>/dev/null)
  case "$b" in core=[0-9]*" graphql="[0-9]*) echo "GitHub budget at $1: $b" >&2 ;; esac
}
say_budget start
# A second signal must not cut the status line off, so the trap ignores them first.
trap 'trap "" INT TERM HUP; say_budget end; say_status "$outcome" "$key" "$id" "$sha" "$detail"' EXIT
# dash (CI's sh) skips the EXIT trap on a signal it does not trap, so trap each one and exit with its 128+n.
trap 'exit 130' INT; trap 'exit 143' TERM; trap 'exit 129' HUP
# Wall-clock, so slow gh calls count too.
give_up_if_late() {
  waited=$(( $(date +%s) - start ))
  if [ "$waited" -ge "$max_s" ]; then echo "gave up after $((waited / 60)) min; still not finished" >&2
    finish timeout 3 "gave up after $((waited / 60)) min"; fi
}
# Sleep one interval, longer the longer we have waited. If this mode's budget is nearly spent, sleep until it
# resets instead, never past the time limit.
nap() {
  polls=$((polls + 1))
  if [ $((polls % 10)) -eq 1 ] || [ "$errors" -gt 0 ]; then
    low=$(gh api rate_limit --jq ".resources.$budget"' | "\(.remaining) \(.reset)"' 2>/dev/null)
    left=${low% *}; reset=${low#* }
    case "$left$reset" in ''|*[!0-9]*) ;; *)
      if [ "$left" -lt 200 ]; then
        s=$(( reset - $(date +%s) + 5 )); cap=$(( max_s - waited ))
        [ "$s" -le "$cap" ] || s=$cap
        [ "$s" -ge 1 ] || s=1
        echo "GitHub rate limit low ($left left); sleeping ${s}s until it resets" >&2
        sleep "$s" >/dev/null 2>&1 & wait $!; return
      fi ;;
    esac
  fi
  s=$interval
  if [ "$waited" -ge 1800 ]; then [ "$s" -ge 300 ] || s=300
  elif [ "$waited" -ge 600 ]; then [ "$s" -ge 120 ] || s=120; fi
  # In the background: a trapped signal waits for a foreground command, but cuts a wait short. Off the caller's
  # pipes, so a sleep left behind when the script dies does not hold them open.
  sleep "$s" >/dev/null 2>&1 & wait $!
}
# Poll until `$1` prints "done"; gh errors are retried, not fatal (a network blip must not end the wait).
# GitHub recomputes mergeability after a push, so one CONFLICTING read can be stale: a conflict is final only on
# two conflict reads with no other successful read between them; any other successful read, done included,
# resets the count (a gh error neither adds nor resets).
poll() {
  while :; do
    if state=$("$@" 2>/dev/null); then
      errors=0
      [ "$state" = done ] && { conflicts=0; return 0; }
      if [ "$state" = conflict ]; then conflicts=$((conflicts + 1)); else conflicts=0; fi
      if [ "$conflicts" -ge 2 ]; then echo "PR conflicts with main; merge main in (no new CI runs on a conflicting head)"
        finish conflict 1 "PR conflicts with main; merge main in"; fi
    else
      errors=$((errors + 1))
      if [ "$errors" -ge 10 ]; then echo "gave up: 10 gh errors in a row" >&2; finish gh_errors 3 "10 gh errors in a row"; fi
    fi
    give_up_if_late
    nap
  done
}

# One REST request per poll.
run_state() { gh api "repos/{owner}/{repo}/actions/runs/$id" --jq 'if .status == "completed" then "done" else .status end'; }
# One GraphQL query per poll. No checks yet = still pending; a wrong number or no network is a gh error. Mirrors
# `gh pr checks` (cli/cli pkg/cmd/pr/checks/aggregate.go, v2.102): keep the newest check per status context or per
# name/workflow (gh also keys on the run's event, which this JSON lacks), take its state (a status's state, else a
# completed run's conclusion, else the run's status), and count it pending unless gh gives that state a bucket.
# The same query reads mergeability. Finished checks are judged first, so they print their counts even if main
# moved since; unfinished checks on a PR in conflict with main get no new CI run, so waiting on them never ends.
pr_state() {
  gh pr view "$id" --json statusCheckRollup,mergeable,mergeStateStatus --jq '(.mergeable == "CONFLICTING" or .mergeStateStatus == "DIRTY") as $c
    | [.statusCheckRollup // [] | group_by(.context // "\(.name)/\(.workflowName)")
    | .[] | max_by(.startedAt) | if (.state // "") != "" then .state elif .status == "COMPLETED" then .conclusion else .status end]
    | if length > 0 and all(IN("SUCCESS", "SKIPPED", "NEUTRAL", "ERROR", "FAILURE", "TIMED_OUT", "ACTION_REQUIRED", "CANCELLED"))
      then "done" elif $c then "conflict" else "pending" end'
}

if [ "$mode" = deploy ]; then
  poll run_state
  report=$(gh run view "$id" --json conclusion,headSha,jobs \
    --jq '"conclusion=\(.conclusion)", "head=\(.headSha)", (.jobs[] | "job \(.name | gsub("[[:cntrl:]]"; " "))=\(.conclusion)")') \
    || { echo "could not read the run's result" >&2; finish result_unreadable 1 "could not read the run's result"; }
  echo "$report"
  conclusion=$(echo "$report" | sed -n 's/^conclusion=//p')
  sha=$(echo "$report" | sed -n 's/^head=//p')
  code=$(curl -sS -m 15 -o /dev/null -w '%{http_code}' "$healthz" 2>/dev/null) || code=000
  echo "healthz=$code ($healthz)"
  [ "$conclusion" = success ] || finish run_failed 1 "conclusion=$conclusion healthz=$code"
  [ "$code" = 200 ] || finish unhealthy 1 "healthz=$code"
  finish success 0 "conclusion=success healthz=200"
fi

# One read gives the counts and the verdict. A check that went back to pending (a re-run or new push between the
# poll and this read) sends the wait back to polling, within the same time limit.
while :; do
  poll pr_state
  checks=$(gh pr checks "$id" --json name,bucket --jq '
    "pass=\([.[] | select(.bucket == "pass")] | length) fail=\([.[] | select(.bucket == "fail" or .bucket == "cancel")] | length) skipped=\([.[] | select(.bucket == "skipping")] | length) tested=\(if any(.[]; .name == "test" and .bucket == "pass") then "yes" else "no" end) pending=\([.[] | select(.bucket == "pending")] | length)",
    (.[] | select(.bucket == "fail" or .bucket == "cancel") | "failed: \(.name | gsub("[[:cntrl:]]"; " "))")' 2>/dev/null)
  # Verdicts come only from line 1, the fixed-format summary. A check name (outside text) cannot forge it: the
  # names go only into the `failed:` lines, and the one name that counts, tested=, is an exact match on `test`.
  summary=$(printf '%s\n' "$checks" | sed -n '1p')
  case "$summary" in pass=*" pending=0") break ;; esac
  # Pending again, or the read failed: wait again, still inside the same time limit.
  give_up_if_late
  nap
done
echo "$checks"
view=$(gh pr view "$id" --json headRefOid,state,mergeable,mergeStateStatus \
  --jq '"head=\(.headRefOid)", "state=\(.state) mergeable=\(.mergeable) mergeState=\(.mergeStateStatus)"') \
  || { echo "could not read the PR's head and mergeability" >&2; finish head_unreadable 1 "could not read the PR's head and mergeability"; }
echo "$view"
sha=$(echo "$view" | sed -n 's/^head=//p')
# All skipped (a draft PR: CI skips every job) is finished but tested nothing, so it is not a pass.
case "$summary" in
  *" fail=0 skipped="*" tested=yes "*) finish success 0 "$summary" ;;
  *" fail=0 skipped="*) echo "no successful test check (a draft PR? mark it ready: gh pr ready $id)"
    finish untested 1 "no successful test check (a draft PR?)" ;;
esac
finish checks_failed 1 "${summary%% skipped=*} failed: $(printf '%s\n' "$checks" | sed -n 's/^failed: //p' | paste -sd , -)"
