# One booted simulator (US-71 AC7), sourced by sim-run.sh after its settings and die().
# After taking the lock, a run refuses at once (75) while any other device is booted, in the default set
# or in --set testing (parallel-test clones), the demo device included. A device left booted makes every
# later run refuse until someone shuts it down; the refusal names it and prints the command (xcrun simctl
# shutdown <udid>, or --set testing for a clone). While the command runs, a watchdog checks every
# HR_SIM_GUARD_SECONDS (15); a device booted meanwhile ends the command (exit 76), but is never shut
# down, since it may be Brad's own. The demo device is spared there when ALLOW_EXTRA_SIMULATOR=other-device.
# HR_SIM_ALLOW_SECOND=1 skips both. Each list call gets LIST_SECONDS (15, at most the run's time limit)
# and the watchdog 2 s to stop, so a hung simctl never holds the lock past them; a list that times out
# finds nothing (fails open).

LIST_SECONDS=15
[ "$RUN_LIMIT" -lt "$LIST_SECONDS" ] 2>/dev/null && [ "$RUN_LIMIT" -gt 0 ] && LIST_SECONDS=$RUN_LIMIT
FOUND="$HOME_DIR/booted.$$"

# Runs a command for at most LIST_SECONDS in its own process group, all of which goes at the limit or
# on a signal, so a child that keeps the output pipe open cannot outlive it.
bounded() {
  perl -e 'my $t = shift; my $p = fork // exit 1; if (!$p) { setpgrp(0, 0); exec { $ARGV[0] } @ARGV or exit 127 }
    $SIG{$_} = sub { kill "KILL", -$p; exit 124 } for qw(ALRM INT TERM HUP);
    alarm $t; waitpid($p, 0); exit($? >> 8)' "$LIST_SECONDS" "$@"
}

# The first booted device other than the shared one (the recorded UDID, else any named HR Shared iPhone),
# in the default set then the testing set, as "<name> (<udid>)|<shutdown command>". $1=1 spares the demo
# device. Fails open: a list that cannot be read finds nothing.
other_booted() {
  local set hit shared
  shared=$(cat "$HOME_DIR/udid" 2>/dev/null)
  for set in "" testing; do
    hit=$(bounded xcrun simctl ${set:+--set $set} list devices booted 2>/dev/null | awk -v set="$set" -v me="$shared" \
        -v name="$NAME" -v demo="$([ "${1:-0}" = 1 ] && echo "$DEMO")" 'match($0, / \([0-9A-F-]+\) \(Booted\)/) {
      u = substr($0, RSTART + 2, RLENGTH - 12); n = substr($0, 1, RSTART - 1); sub(/^ +/, "", n)
      if (set == "" && (u == me || (me == "" && n == name) || n == demo)) next
      print n " (" u ")|xcrun simctl " (set == "" ? "" : "--set testing ") "shutdown " u; exit }')
    [ -n "$hit" ] && { echo "$hit"; return 0; }
  done
  return 1
}

refuse_second() {
  local hit
  hit=$(other_booted 0) || return 0
  die "refused: another simulator is booted, ${hit%%|*}; one at a time. Shut it down (${hit#*|}) or set HR_SIM_ALLOW_SECOND=1 to run beside it" 75
}

# The watchdog, in the background without fd 9 or 7: a device booted during the run is written to FOUND
# and ends the command through the shim (TERM to its group, then the usual cleanup). It shuts nothing
# down, and exits on TERM (killing its own sleep) or once sim-run is gone: sim-run's pid answers kill -0
# while it is an unreaped zombie, so it checks that sim-run is still its parent.
watch_devices() {
  local hit spare=0 s="" me
  [ "${ALLOW_EXTRA_SIMULATOR:-}" = other-device ] && spare=1
  me=$(exec sh -c 'echo $PPID')
  trap '[ -n "$s" ] && kill "$s" 2>/dev/null; exit 0' TERM
  while :; do
    sleep "$WATCH_EVERY" & s=$!
    wait "$s"
    [ "$(/bin/ps -o ppid= -p "$me" 2>/dev/null | tr -d ' ')" = "$$" ] || exit 0
    hit=$(other_booted "$spare") || continue
    trap '' TERM
    echo "$hit" > "$FOUND"
    kill -TERM "$SHIM" 2>/dev/null
    exit 76
  done
}

# Stops the watchdog: TERM, which it takes only once a list call returns, then KILL after 2 s, so it
# never holds the lock. If it found a device, prints the line and sets RC to 76; the command was stopped
# only if the shim reports a signal (143), else it had already ended.
end_watch() {
  local hit i
  kill "$WATCH" 2>/dev/null
  for i in 1 2 3 4 5 6 7 8 9 10; do kill -0 "$WATCH" 2>/dev/null || break; sleep 0.2; done
  kill -KILL "$WATCH" 2>/dev/null
  wait "$WATCH" 2>/dev/null
  WATCH=""
  hit=$(cat "$FOUND" 2>/dev/null) && [ -n "$hit" ] || return 0
  rm -f "$FOUND"
  if [ "$RC" = 143 ]; then
    echo "sim-run: stopped the command (exit 76): another simulator booted during the run, ${hit%%|*}; one at a time. Shut it down: ${hit#*|}" >&2
  else
    echo "sim-run: another simulator booted during the run (exit 76), ${hit%%|*}, found after the command ended; one at a time. Shut it down: ${hit#*|}" >&2
  fi
  RC=76
}
