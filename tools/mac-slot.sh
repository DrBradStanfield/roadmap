#!/bin/sh
# A machine-wide queue for heavy work on this Mac (US-71 AC9, Brad 2026-11-12): sessions each polled the load
# and started Codex reviews or test runs at the same moment (seven Codex runs at once; load 7-16 for hours).
#   tools/mac-slot.sh codex -- node tools/codex-review.mjs ...   at most 2 at once
#   tools/mac-slot.sh tests -- npx vitest run ...                 at most 3 at once
#   tools/mac-slot.sh status                                      holders and waiters per kind, and the load
# A kind has N slots, files <kind>.1 .. <kind>.N in ~/Library/Caches/health-roadmap-slots (MAC_SLOT_HOME), one
# directory for every worktree, as sim-run.sh keeps its lock. A slot is the kernel's lock: lockf on fd 9 opened on
# that file, which the command inherits through exec, so the slot is held for the command's lifetime (and its
# children's) and freed however it ends. <kind>.<i>.holder (pid and command) is information, never the lock.
# With a slot, it waits while the 1-minute load is MAC_SLOT_MAX_LOAD (8) or more, re-checking every
# MAC_SLOT_POLL_SECONDS (30); after MAC_SLOT_LOAD_WAIT_MIN (60) it starts anyway with a one-line warning (the
# slots still bound what runs at once). An unreadable load does not wait. TERM or INT while it waits exits 143 or
# 130 at once. Then it execs the command, so the exit code is the command's. Waiting for a slot has no limit:
# holders end and the kernel frees their slot. Exit 64: usage.
# MAC_SLOT_CODEX_MAX, MAC_SLOT_TESTS_MAX and MAC_SLOT_LOAD_CMD (prints the load) are for the test suite.
# Off a shared Mac (not macOS, no lockf, or CI set and not false/0) it runs the command directly: no queue.
# Tests: tools/mac-slot.test.ts (macOS only: lockf).
set -u
USAGE="usage: tools/mac-slot.sh codex|tests -- <command...> | status"
die() { echo "mac-slot: $1" >&2; exit "${2:-1}"; }

kind=${1:-}
if [ "$kind" != status ]; then
  case "$kind" in codex|tests) ;; *) die "$USAGE" 64 ;; esac
  shift
  [ "${1:-}" = -- ] || die "$USAGE" 64
  shift
  [ $# -gt 0 ] || die "$USAGE" 64
fi

shared() {
  [ "$(uname)" = Darwin ] && command -v lockf >/dev/null 2>&1 || return 1
  case "${CI:-}" in ''|false|0) return 0 ;; esac
  return 1
}
if ! shared; then
  [ "$kind" = status ] && { echo "no queue here: not a shared Mac"; exit 0; }
  exec "$@"
fi

DIR=${MAC_SLOT_HOME:-$HOME/Library/Caches/health-roadmap-slots}
mkdir -p "$DIR" || die "cannot make $DIR"
POLL=${MAC_SLOT_POLL_SECONDS:-30}
case "$POLL" in ''|*[!0-9]*|0) POLL=30 ;; esac
MAX_LOAD=${MAC_SLOT_MAX_LOAD:-8}
LOAD_WAIT=${MAC_SLOT_LOAD_WAIT_SECONDS:-$(( ${MAC_SLOT_LOAD_WAIT_MIN:-60} * 60 ))}

slots() {
  case "$1" in codex) n=${MAC_SLOT_CODEX_MAX:-2} ;; *) n=${MAC_SLOT_TESTS_MAX:-3} ;; esac
  case "$n" in ''|*[!0-9]*|0) [ "$1" = codex ] && n=2 || n=3 ;; esac
  echo "$n"
}
load() {
  if [ -n "${MAC_SLOT_LOAD_CMD:-}" ]; then sh -c "$MAC_SLOT_LOAD_CMD" 2>/dev/null
  else sysctl -n vm.loadavg 2>/dev/null | awk '{ print $2 }'; fi
}
# True while some process holds slot file $1 (a probe on its own descriptor, let go at once).
held() { ! ( exec 8>>"$1" && lockf -s -t 0 8 ) 2>/dev/null; }
holders() { # kind max: one "pid N (slot i): command" line per held slot
  i=1
  while [ "$i" -le "$2" ]; do
    held "$DIR/$1.$i" && echo "pid $(cut -d' ' -f1 "$DIR/$1.$i.holder" 2>/dev/null) (slot $i): $(cut -d' ' -f2- "$DIR/$1.$i.holder" 2>/dev/null)"
    i=$((i + 1))
  done
}

if [ "$kind" = status ]; then
  for k in codex tests; do
    n=$(slots "$k")
    h=$(holders "$k" "$n")
    w=""
    for f in "$DIR"/waiting."$k".*; do
      [ -f "$f" ] || continue
      p=${f##*.}
      if kill -0 "$p" 2>/dev/null; then w="$w  waiting: pid $p: $(cat "$f")
"; else rm -f "$f"; fi
    done
    echo "$k: $(printf '%s' "$h" | grep -c .)/$n held, $(printf '%s' "$w" | grep -c .) waiting"
    [ -n "$h" ] && printf '%s\n' "$h" | sed 's/^/  /'
    printf '%s' "$w"
  done
  echo "1-minute load: $(load)"
  exit 0
fi

MAX=$(slots "$kind")
CMDLINE=$(printf '%s ' "$@" | tr '\n' ' ' | cut -c1-200)
# Takes slot $1 on fd 9, waiting up to $2 seconds; on failure fd 9 is closed again.
take() {
  exec 9>>"$DIR/$kind.$1"
  lockf -s -t "$2" 9 && { SLOT=$1; return 0; }
  exec 9>&-
  return 1
}
# `status` can only probe a slot by locking it for an instant (lockf has no test-only mode), so a slot that
# refuses is tried once more after 0.2 s: a status probe must not send a caller past a free slot.
scan() {
  i=1
  while [ "$i" -le "$MAX" ]; do
    take "$i" 0 && return 0
    sleep 0.2; take "$i" 0 && return 0
    i=$((i + 1))
  done
  return 1
}

SLOT=""
if ! scan; then
  echo "mac-slot: waiting for a $kind slot ($MAX/$MAX held): $(holders "$kind" "$MAX" | sed 's/ (slot [0-9]*)//' | paste -sd ';' - | sed 's/;/; /g')" >&2
  WFILE="$DIR/waiting.$kind.$$"
  echo "$CMDLINE" > "$WFILE"
  trap 'rm -f "$WFILE"' EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  # Waiters spread over the slots: each blocks on slot (pid mod N)+1 for POLL seconds, then re-scans every slot
  # without blocking, then blocks on the next one. When a slot frees, the kernel gives it to one process only, so
  # waiters never all start at once; a waiter blocked on another slot finds it on its next scan. The kernel's
  # order among waiters (and a newcomer's first scan) is not first-come, first-served.
  j=$(( $$ % MAX + 1 ))
  until take "$j" "$POLL" || scan; do j=$(( j % MAX + 1 )); done
  rm -f "$WFILE"
  trap - EXIT INT TERM
fi
echo "$$ $CMDLINE" > "$DIR/$kind.$SLOT.holder"

# Helpers here run with fd 9 closed (9>&-), so a waiter killed mid-sleep frees its slot at once; the sleep runs in
# the background under `wait`, so TERM and INT end the wait at once too. Only the command keeps fd 9: a daemon it
# leaves behind keeps the slot until that daemon exits (by design: it is still load).
nap_pid=""
trap '[ -n "$nap_pid" ] && kill "$nap_pid" 2>/dev/null; exit 143' TERM
trap '[ -n "$nap_pid" ] && kill "$nap_pid" 2>/dev/null; exit 130' INT
start=$(date +%s) said=0
while :; do
  l=$(load 9>&-)
  case "$l" in ''|*[!0-9.]*) echo "mac-slot: could not read the load; not waiting" >&2; break ;; esac
  awk -v l="$l" -v m="$MAX_LOAD" 'BEGIN { exit !(l + 0 >= m + 0) }' 9>&- || break
  [ "$said" = 1 ] || echo "mac-slot: waiting: 1-minute load $l is $MAX_LOAD or more; holding $kind slot $SLOT/$MAX, re-checking every ${POLL}s" >&2
  said=1
  left=$(( LOAD_WAIT - ($(date +%s) - start) ))
  if [ "$left" -le 0 ]; then
    echo "mac-slot: waited $(( LOAD_WAIT / 60 ))m and the 1-minute load $l is still $MAX_LOAD or more; starting anyway (the slots bound what runs at once)" >&2
    break
  fi
  [ "$left" -lt "$POLL" ] || left=$POLL
  sleep "$left" 9>&- & nap_pid=$!
  wait "$nap_pid"; nap_pid=""
done
trap - TERM INT
echo "mac-slot: starting $kind slot $SLOT/$MAX (load ${l:-?}): $CMDLINE" >&2
exec "$@"
