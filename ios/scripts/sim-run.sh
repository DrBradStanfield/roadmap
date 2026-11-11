#!/bin/bash
# The one door to the iOS simulator on this Mac (Brad 2026-11-11: "ideally there would be only one
# simulator"). Every session takes turns on one shared device, "HR Shared iPhone", under a lease:
# a session checks its work, releases, and goes back to coding while the next one runs.
#   ios/scripts/sim-run.sh [--reset-app] -- <command...>   run a command on the shared device
#   ios/scripts/sim-run.sh status                           device, lease, leftover processes
# In the command, {udid} becomes the device's UDID, and SIM_UDID is set for scripts.
#   ios/scripts/sim-run.sh -- xcodebuild test -project HealthRoadmap.xcodeproj -scheme HealthRoadmap
#   ios/scripts/sim-run.sh --reset-app -- xcrun simctl install {udid} <path>.app
#   ios/scripts/sim-run.sh -- xcrun simctl io {udid} screenshot shot.png
# The lease is an atomic mkdir under ~/Library/Caches/health-roadmap-sim; a second caller waits,
# naming the holder, and takes over a lease whose holder has died. The device stays booted between
# runs and shuts down after HR_SIM_IDLE_MIN minutes with no lease (a detached sleep, no daemon).
# Settings: HR_SIM_WAIT_MIN (30), HR_SIM_IDLE_MIN (20; 0 keeps it booted), HR_SIM_POLL_SECONDS (10),
# HR_SIM_LIMIT_SECONDS (1200, a direct xcodebuild's time limit), HR_SIM_DEVICE_TYPE (iPhone-18-Pro,
# the 6.3-inch size App Store Connect takes), HR_SIM_HOME. Tests: ios/scripts/sim-run.test.ts.

SELF="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
HOME_DIR="${HR_SIM_HOME:-$HOME/Library/Caches/health-roadmap-sim}"
LEASE="$HOME_DIR/lease"
NAME="HR Shared iPhone"
TYPE="${HR_SIM_DEVICE_TYPE:-iPhone-18-Pro}"
WAIT_SECONDS="${HR_SIM_WAIT_SECONDS:-$(( ${HR_SIM_WAIT_MIN:-30} * 60 ))}"
IDLE_SECONDS="${HR_SIM_IDLE_SECONDS:-$(( ${HR_SIM_IDLE_MIN:-20} * 60 ))}"
POLL="${HR_SIM_POLL_SECONDS:-10}"
LIMIT="${HR_SIM_LIMIT_SECONDS:-1200}"
PROJECT="$(dirname "$SELF")/../HealthRoadmap.xcodeproj/project.pbxproj"
OWN=0 CHILD="" UDID="" TOKEN="$$-$(date +%s)"

die() { echo "sim-run: $*" >&2; exit "${2:-1}"; }
now() { date +%s; }
lstart() { ps -o lstart= -p "$1" 2>/dev/null | sed 's/^ *//'; }
field() { sed -n "s/^$1=//p" "$LEASE/holder" 2>/dev/null | head -1; }
ago() { local s=$(( $(now) - $1 )); [ "$s" -lt 3600 ] && echo "$((s / 60))m$((s % 60))s" || echo "$((s / 3600))h$((s % 3600 / 60))m"; }
# A holder is alive while its pid runs and started when the lease says (a reused pid starts later).
alive() { [ -n "$1" ] && kill -0 "$1" 2>/dev/null && { [ -z "$2" ] || [ "$(lstart "$1")" = "$2" ]; }; }

write_holder() {
  local tmp="$HOME_DIR/holder.$$"
  printf 'pid=%s\nlstart=%s\ntoken=%s\nstarted=%s\ncwd=%s\ncommand=%s\n' \
    "$$" "$(lstart $$)" "$TOKEN" "$(now)" "$PWD" "$(printf '%s ' "$@" | tr '\n' ' ' | cut -c1-300)" > "$tmp"
  mv "$tmp" "$LEASE/holder"
}

# Removes a lease judged stale, unless it changed hands meanwhile. A second mkdir lock keeps two
# waiters from both removing it, the second removing the first one's fresh lease.
take_over() {
  if ! mkdir "$HOME_DIR/takeover" 2>/dev/null; then
    [ $(( $(now) - $(stat -f %m "$HOME_DIR/takeover" 2>/dev/null || now) )) -gt 60 ] && rmdir "$HOME_DIR/takeover" 2>/dev/null
    return
  fi
  if [ "$(field token)" = "$1" ]; then
    echo "sim-run: took over a stale lease (pid ${2:-unknown} is gone)" >&2
    rm -rf "$LEASE"
  fi
  rmdir "$HOME_DIR/takeover"
}

acquire() {
  local deadline=$(( $(now) + WAIT_SECONDS )) said="" pid token
  mkdir -p "$HOME_DIR" || die "cannot make $HOME_DIR"
  while :; do
    if mkdir "$LEASE" 2>/dev/null; then OWN=1; write_holder "$@"; return; fi
    pid=$(field pid) token=$(field token)
    if [ -z "$pid" ]; then
      # mkdir done, holder file not yet written: a live caller writes it at once.
      [ $(( $(now) - $(stat -f %m "$LEASE" 2>/dev/null || now) )) -gt 10 ] && take_over ""
    elif ! alive "$pid" "$(field lstart)"; then
      take_over "$token" "$pid"; continue
    else
      [ "$(now)" -ge "$deadline" ] && die "gave up after ${WAIT_SECONDS}s: the simulator is still held by pid $pid ($(field cwd)): $(field command)" 75
      if [ "$said" != "$token" ]; then
        echo "sim-run: the shared simulator is in use by pid $pid for $(ago "$(field started)") ($(field cwd)): $(field command)" >&2
        echo "sim-run: waiting up to $((WAIT_SECONDS / 60))m (HR_SIM_WAIT_MIN), checking every ${POLL}s" >&2
        said=$token
      fi
    fi
    sleep "$POLL"
  done
}

# Frees the lease and arms the idle shutdown: a detached sleep that shuts the device down only if
# no one has taken and released the lease since (last-release still holds this release's stamp).
release() {
  [ "$OWN" = 1 ] || return 0
  OWN=0
  [ "$(field token)" = "$TOKEN" ] && rm -rf "$LEASE"
  [ "${IDLE_RUN:-}" = 1 ] && return 0
  local stamp="$(now)-$$"
  echo "$stamp" > "$HOME_DIR/last-release"
  [ "$IDLE_SECONDS" -gt 0 ] 2>/dev/null || return 0
  # fork + setsid: the sleeper leaves this session's process group, so it outlives the caller's shell.
  perl -MPOSIX -e 'fork and exit; POSIX::setsid(); exec @ARGV' "$SELF" _idle "$stamp" </dev/null >/dev/null 2>&1
}

idle_shutdown() {
  sleep "$IDLE_SECONDS"
  [ "$(cat "$HOME_DIR/last-release" 2>/dev/null)" = "$1" ] || exit 0
  mkdir "$LEASE" 2>/dev/null || exit 0
  OWN=1 IDLE_RUN=1
  trap release EXIT
  write_holder idle shutdown
  UDID=$(cat "$HOME_DIR/udid" 2>/dev/null)
  [ "$(cat "$HOME_DIR/last-release" 2>/dev/null)" = "$1" ] && [ -n "$UDID" ] && xcrun simctl shutdown "$UDID" >/dev/null 2>&1
  exit 0
}

# The shared device's UDID: the one recorded, else one named HR Shared iPhone, else a new one on the
# newest iOS runtime (a device-specific runtime such as iOS-27-2-iPhone19-4 is skipped). Boots nothing.
ensure_device() {
  local list runtime
  list=$(xcrun simctl list devices) || die "xcrun simctl list devices failed"
  UDID=$(cat "$HOME_DIR/udid" 2>/dev/null)
  if [ -z "$UDID" ] || ! printf '%s\n' "$list" | grep -qF "($UDID)"; then
    UDID=$(printf '%s\n' "$list" | grep -F "    $NAME (" | head -1 | sed -E 's/.*\(([0-9A-F-]{36})\).*/\1/')
  fi
  if [ -z "$UDID" ]; then
    runtime=$(xcrun simctl list runtimes | grep -v unavailable |
      sed -n -E 's/.* - (com\.apple\.CoreSimulator\.SimRuntime\.iOS-[0-9-]+)[[:space:]]*$/\1/p' |
      sort -t- -k2,2n -k3,3n -k4,4n | tail -1)
    [ -n "$runtime" ] || die "no iOS simulator runtime is installed"
    UDID=$(xcrun simctl create "$NAME" "com.apple.CoreSimulator.SimDeviceType.$TYPE" "$runtime") || die "could not create $NAME"
    echo "sim-run: created $NAME ($UDID) on $runtime" >&2
  fi
  echo "$UDID" > "$HOME_DIR/udid"
}

device_state() { xcrun simctl list devices | sed -n -E "s/.*\($1\) \(([A-Za-z]+)\).*/\1/p" | head -1; }

# A direct xcodebuild runs on the shared device by id, under a time limit. Test actions get:
#   -parallel-testing-enabled NO: parallel testing clones the simulator per test runner; the clones
#     fill the disk and the process table (docs/gotchas.md 2026-10-24, 2026-10-26).
#   -maximum-concurrent-test-simulator-destinations 1: never test on two simulators at once. Xcode
#     27.2 has no -disable-concurrent-destination-testing; this is its flag for the same thing.
prepare_xcodebuild() {
  local a prev="" dest="" testing=0 parallel=0 maxdest=0
  for a in "$@"; do
    [ "$prev" = -destination ] && dest="$a"
    [ "$prev" = -parallel-testing-enabled ] && { [ "$a" = NO ] || die "the shared simulator runs tests with -parallel-testing-enabled NO only" 64; parallel=1; }
    [ "$a" = -maximum-concurrent-test-simulator-destinations ] && maxdest=1
    case "$a" in test|test-without-building|build-for-testing) testing=1;; esac
    prev="$a"
  done
  [ -z "$dest" ] || [ "$dest" = "id=$UDID" ] || case "$dest" in generic/*) ;; *)
    die "runs on the shared simulator only: drop -destination '$dest' (sim-run adds id=$UDID)" 64;; esac
  CMD=(perl -e 'alarm shift; exec @ARGV' "$LIMIT" "$@")
  [ -n "$dest" ] || CMD+=(-destination "id=$UDID")
  [ "$testing" = 1 ] && [ "$parallel" = 0 ] && CMD+=(-parallel-testing-enabled NO)
  [ "$testing" = 1 ] && [ "$maxdest" = 0 ] && CMD+=(-maximum-concurrent-test-simulator-destinations 1)
  # build-for-testing alone needs no booted device.
  NEEDS_BOOT=$([ "$testing" = 1 ] && printf '%s\n' "$@" | grep -qxE 'test|test-without-building' && echo 1 || echo 0)
}

status() {
  local udid state booted pid procs orphans
  udid=$(cat "$HOME_DIR/udid" 2>/dev/null)
  state=$([ -n "$udid" ] && device_state "$udid")
  echo "Shared device: $NAME ${udid:+($udid) }${state:-not created yet}"
  booted=$(xcrun simctl list devices booted | grep -E '\(Booted\)' | sed 's/^ */  /')
  echo "Booted simulators:"
  echo "${booted:-  none}"
  pid=$(field pid)
  if [ -d "$LEASE" ] && [ -n "$pid" ]; then
    echo "Lease: held by pid $pid ($(alive "$pid" "$(field lstart)" && echo running || echo gone, the next caller takes over)) for $(ago "$(field started)")"
    echo "  $(field cwd): $(field command)"
  else
    echo "Lease: free (idle shutdown $((IDLE_SECONDS / 60))m after the last release)"
  fi
  procs=$(ps -axo pid=,ppid=,etime=,command= | grep 'simruntime/Contents/Resources/RuntimeRoot' | grep -v grep)
  orphans=$(printf '%s\n' "$procs" | awk 'NF && $2 == 1' | wc -l | tr -d ' ')
  echo "Simulator-runtime processes: $(printf '%s\n' "$procs" | awk NF | wc -l | tr -d ' ') ($orphans with parent pid 1)"
  # Counted by runtime and age in days (ps etime is [[dd-]hh:]mm:ss).
  printf '%s\n' "$procs" | awk 'NF { d = index($3, "-") ? substr($3, 1, index($3, "-") - 1) : 0
      rt = match($0, /iOS [0-9.]+\.simruntime/) ? substr($0, RSTART, RLENGTH - 11) : "?"
      n[rt " | up " d " days"]++ } END { for (k in n) print "  " n[k] " x " k }' | sort -t'|' -k2 -r
  if [ -z "$booted" ]; then
    [ -n "$procs" ] && echo "No device is booted, so these are leftovers. To clean up, run it yourself:" &&
      echo "  pkill -f 'simruntime/Contents/Resources/RuntimeRoot'"
  else
    echo "To clean up, run it yourself while the lease is free (it stops any session's run):"
    echo "  xcrun simctl shutdown all && pkill -f 'simruntime/Contents/Resources/RuntimeRoot'"
  fi
  echo "Parallel-test clones (if any): ios/scripts/clean-test-clones.sh"
}

case "${1:-}" in
  status) status; exit 0;;
  _idle) idle_shutdown "$2";;
esac

RESET=0
while [ $# -gt 0 ]; do
  case "$1" in
    --reset-app) RESET=1; shift;;
    --) shift; break;;
    *) die "usage: sim-run.sh [--reset-app] -- <command...> | sim-run.sh status" 64;;
  esac
done
[ $# -gt 0 ] || die "usage: sim-run.sh [--reset-app] -- <command...> | sim-run.sh status" 64

# A call from inside a run (a script under the lease calling sim-run again) uses the lease it holds.
NESTED=0
[ -n "${HR_SIM_LEASE:-}" ] && [ "$HR_SIM_LEASE" = "$(field token)" ] && NESTED=1 TOKEN=$HR_SIM_LEASE

# A signal stops the command, and its children (a script's xcodebuild), before the lease is freed.
on_signal() { [ -n "$CHILD" ] && { pkill -TERM -P "$CHILD" 2>/dev/null; kill -TERM "$CHILD" 2>/dev/null; }; exit "$1"; }
trap release EXIT
trap 'on_signal 130' INT
trap 'on_signal 143' TERM
trap 'on_signal 129' HUP
[ "$NESTED" = 1 ] || acquire "$@"
ensure_device

ARGS=()
for a in "$@"; do ARGS+=("${a//\{udid\}/$UDID}"); done
set -- "${ARGS[@]}"
[ "$1" = xcrun ] && [ "${2:-}" = xcodebuild ] && shift
NEEDS_BOOT=1 CMD=("$@")
[ "$(basename "$1")" = xcodebuild ] && prepare_xcodebuild "$@"
[ "$RESET" = 1 ] && NEEDS_BOOT=1  # simctl uninstall needs a booted device

if [ "$NEEDS_BOOT" = 1 ] && [ "$(device_state "$UDID")" != Booted ]; then
  echo "sim-run: booting $NAME ($UDID)" >&2
  xcrun simctl bootstatus "$UDID" -b >/dev/null || die "could not boot $UDID"
fi
if [ "$RESET" = 1 ]; then
  BUNDLE=$(sed -n -E 's/.*PRODUCT_BUNDLE_IDENTIFIER = ([A-Za-z0-9.-]+);/\1/p' "$PROJECT" | grep -vE '\.(ui)?tests$' | head -1)
  [ -n "$BUNDLE" ] || die "no app bundle id in $PROJECT"
  xcrun simctl uninstall "$UDID" "$BUNDLE" 2>/dev/null || true
fi

# In the background so a signal reaches the trap at once (bash defers traps while a foreground
# child runs); <&0 keeps stdin, which a background job would otherwise lose.
HR_SIM_LEASE="$TOKEN" SIM_UDID="$UDID" "${CMD[@]}" <&0 &
CHILD=$!
wait "$CHILD"
RC=$?
CHILD=""
exit "$RC"
