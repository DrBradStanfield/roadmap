#!/bin/sh
# Wait for a GitHub Actions run or a PR's checks, then print one short verdict (Brad 2026-11-10: hand-typed
# `until gh run view ... | jq ...` loops hung for hours or were refused by the worktree sandbox).
#
#   sh tools/wait-run.sh deploy <run-id>   wait until the run completes; print its conclusion, head sha, each
#                                          job's name=conclusion and the live healthz status
#   sh tools/wait-run.sh pr <number>       wait until no check is pending; print pass/fail counts, the head sha
#                                          and mergeability
#
# Exit: 0 success; 1 the run or a check failed, a final read failed, or healthz is not 200; 2 usage; 3 gave up
# (WAIT_RUN_MAX_MIN of wall-clock time, default 90, or 10 gh errors in a row; each gh call is cut off at 60 s).
#
# Cheap on purpose: many sessions run this at once on one GitHub account, and on 2026-11-10 they spent the
# 5000/hour REST limit (US-64 AC26). Each poll is ONE gh call: deploy reads the run over REST, pr reads the checks
# over GraphQL (a separate budget). Polls every WAIT_RUN_INTERVAL seconds (default 60, never less), every 120 s
# after 10 min and every 300 s after 30 min. Every 10th poll, and after a gh error, it reads `gh api rate_limit`
# (free); with under 200 left in the budget its mode spends (core for deploy, graphql for pr) it sleeps until the
# reset instead of polling. Plain POSIX sh plus perl (macOS ships
# it) for the per-call limit, and gh's own --jq (no jq needed). Run it in the background (run_in_background) so
# the session is woken when it ends.
set -u
mode=${1:-}; id=${2:-}
interval=${WAIT_RUN_INTERVAL:-60}
max_s=$(( ${WAIT_RUN_MAX_MIN:-90} * 60 ))
healthz=${WAIT_RUN_HEALTHZ:-https://health-tool-app.fly.dev/healthz}
case "$id" in ''|*[!0-9]*) mode=bad ;; esac
case "$interval$max_s" in *[!0-9]*) mode=bad ;; esac
case "$mode" in
  deploy|pr) ;;
  *) echo "usage: sh tools/wait-run.sh deploy <run-id> | pr <number>" >&2; exit 2 ;;
esac
[ "$interval" -ge 60 ] || interval=60
budget=core; [ "$mode" = pr ] && budget=graphql

start=$(date +%s); errors=0; polls=0
# Every gh call gets WAIT_RUN_GH_TIMEOUT seconds (default 60; perl's alarm, since macOS has no `timeout`), so a
# stuck request counts as a gh error instead of hanging the wait.
gh() { perl -e 'alarm shift; exec @ARGV' "${WAIT_RUN_GH_TIMEOUT:-60}" gh "$@"; }
# Wall-clock, so slow gh calls count too.
give_up_if_late() {
  waited=$(( $(date +%s) - start ))
  if [ "$waited" -ge "$max_s" ]; then echo "gave up after $((waited / 60)) min; still not finished" >&2; exit 3; fi
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
        sleep "$s"; return
      fi ;;
    esac
  fi
  s=$interval
  if [ "$waited" -ge 1800 ]; then [ "$s" -ge 300 ] || s=300
  elif [ "$waited" -ge 600 ]; then [ "$s" -ge 120 ] || s=120; fi
  sleep "$s"
}
# Poll until `$1` prints "done"; gh errors are retried, not fatal (a network blip must not end the wait).
poll() {
  while :; do
    if state=$("$@" 2>/dev/null); then
      errors=0
      [ "$state" = done ] && return 0
    else
      errors=$((errors + 1))
      if [ "$errors" -ge 10 ]; then echo "gave up: 10 gh errors in a row" >&2; exit 3; fi
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
pr_state() {
  gh pr view "$id" --json statusCheckRollup --jq '[.statusCheckRollup // [] | group_by(.context // "\(.name)/\(.workflowName)")
    | .[] | max_by(.startedAt) | if (.state // "") != "" then .state elif .status == "COMPLETED" then .conclusion else .status end]
    | if length > 0 and all(IN("SUCCESS", "SKIPPED", "NEUTRAL", "ERROR", "FAILURE", "TIMED_OUT", "ACTION_REQUIRED", "CANCELLED"))
      then "done" else "pending" end'
}

if [ "$mode" = deploy ]; then
  poll run_state
  report=$(gh run view "$id" --json conclusion,headSha,jobs \
    --jq '"conclusion=\(.conclusion)", "head=\(.headSha)", (.jobs[] | "job \(.name)=\(.conclusion)")') \
    || { echo "could not read the run's result" >&2; exit 1; }
  echo "$report"
  conclusion=$(echo "$report" | sed -n 's/^conclusion=//p')
  code=$(curl -sS -m 15 -o /dev/null -w '%{http_code}' "$healthz" 2>/dev/null) || code=000
  echo "healthz=$code ($healthz)"
  [ "$conclusion" = success ] && [ "$code" = 200 ] && exit 0
  exit 1
fi

# One read gives the counts and the verdict. A check that went back to pending (a re-run or new push between the
# poll and this read) sends the wait back to polling, within the same time limit.
while :; do
  poll pr_state
  checks=$(gh pr checks "$id" --json name,bucket --jq '
    "pass=\([.[] | select(.bucket == "pass")] | length) fail=\([.[] | select(.bucket == "fail" or .bucket == "cancel")] | length) skipped=\([.[] | select(.bucket == "skipping")] | length) pending=\([.[] | select(.bucket == "pending")] | length)",
    (.[] | select(.bucket == "fail" or .bucket == "cancel") | "failed: \(.name)")' 2>/dev/null)
  # Verdicts come only from line 1, the fixed-format summary; check names (outside text) never decide anything.
  summary=$(printf '%s\n' "$checks" | sed -n '1p')
  case "$summary" in pass=*" pending=0") break ;; esac
  # Pending again, or the read failed: wait again, still inside the same time limit.
  give_up_if_late
  nap
done
echo "$checks"
gh pr view "$id" --json headRefOid,state,mergeable,mergeStateStatus \
  --jq '"head=\(.headRefOid)", "state=\(.state) mergeable=\(.mergeable) mergeState=\(.mergeStateStatus)"' \
  || { echo "could not read the PR's head and mergeability" >&2; exit 1; }
case "$summary" in *" fail=0 skipped="*) exit 0 ;; esac
exit 1
