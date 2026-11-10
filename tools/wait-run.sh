#!/bin/sh
# Wait for a GitHub Actions run or a PR's checks, then print one short verdict (Brad 2026-11-10: hand-typed
# `until gh run view ... | jq ...` loops hung for hours or were refused by the worktree sandbox).
#
#   sh tools/wait-run.sh deploy <run-id>   wait until the run completes; print its conclusion, head sha, each
#                                          job's name=conclusion and the live healthz status
#   sh tools/wait-run.sh pr <number>       wait until no check is pending; print pass/fail counts, the head sha
#                                          and mergeability
#
# Exit: 0 success; 1 the run or a check failed, or healthz is not 200; 2 usage; 3 gave up (WAIT_RUN_MAX_MIN,
# default 90, or 10 gh errors in a row). Polls every WAIT_RUN_INTERVAL seconds (default 30). Plain POSIX sh,
# gh's own --jq (no jq needed). Run it in the background (run_in_background) so the session is woken when it ends.
set -u
mode=${1:-}; id=${2:-}
interval=${WAIT_RUN_INTERVAL:-30}
max_s=$(( ${WAIT_RUN_MAX_MIN:-90} * 60 ))
healthz=${WAIT_RUN_HEALTHZ:-https://health-tool-app.fly.dev/healthz}
case "$id" in ''|*[!0-9]*) mode=bad ;; esac
case "$mode" in
  deploy|pr) ;;
  *) echo "usage: sh tools/wait-run.sh deploy <run-id> | pr <number>" >&2; exit 2 ;;
esac

waited=0; errors=0
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
    if [ "$waited" -ge "$max_s" ]; then echo "gave up after $((waited / 60)) min; still not finished" >&2; exit 3; fi
    sleep "$interval"; waited=$((waited + interval))
  done
}

run_state() { gh run view "$id" --json status --jq 'if .status == "completed" then "done" else .status end'; }
# `gh pr checks` exits non-zero while checks pend or fail, so read only its output. No checks yet = still pending,
# as long as the PR itself answers (a wrong number or no network counts as a gh error).
pr_state() {
  out=$(gh pr checks "$id" --json bucket --jq 'if length > 0 and all(.bucket != "pending") then "done" else "pending" end' 2>/dev/null)
  [ -n "$out" ] || { gh pr view "$id" --json number >/dev/null 2>&1 || return 1; out=pending; }
  echo "$out"
}

if [ "$mode" = deploy ]; then
  poll run_state
  gh run view "$id" --json conclusion,headSha,jobs \
    --jq '"conclusion=\(.conclusion)", "head=\(.headSha)", (.jobs[] | "job \(.name)=\(.conclusion)")'
  conclusion=$(gh run view "$id" --json conclusion --jq .conclusion)
  code=$(curl -sS -m 15 -o /dev/null -w '%{http_code}' "$healthz" 2>/dev/null) || code=000
  echo "healthz=$code ($healthz)"
  [ "$conclusion" = success ] && [ "$code" = 200 ] && exit 0
  exit 1
fi

poll pr_state
gh pr checks "$id" --json bucket \
  --jq '"pass=\([.[] | select(.bucket == "pass")] | length) fail=\([.[] | select(.bucket == "fail" or .bucket == "cancel")] | length) skipped=\([.[] | select(.bucket == "skipping")] | length)"' 2>/dev/null
gh pr checks "$id" --json name,bucket --jq '.[] | select(.bucket == "fail" or .bucket == "cancel") | "failed: \(.name)"' 2>/dev/null
gh pr view "$id" --json headRefOid,state,mergeable,mergeStateStatus \
  --jq '"head=\(.headRefOid)", "state=\(.state) mergeable=\(.mergeable) mergeState=\(.mergeStateStatus)"'
failed=$(gh pr checks "$id" --json bucket --jq '[.[] | select(.bucket == "fail" or .bucket == "cancel")] | length' 2>/dev/null)
[ "${failed:-1}" = 0 ] && exit 0
exit 1
