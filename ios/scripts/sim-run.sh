#!/bin/bash
# The one door to the iOS simulator on this Mac (Brad 2026-11-11: "ideally there would be only one
# simulator"). Every session takes turns on one shared device, "HR Shared iPhone", under a lock:
# a session checks its work, lets the command finish, and goes back to coding while the next one runs.
#   ios/scripts/sim-run.sh [--reset-app] -- <command...>   run a command on the shared device
#   ios/scripts/sim-run.sh status                           device, holder, leftover processes
#   ios/scripts/sim-run.sh hold [--demo] | release          hold the device across tool calls (the iOS
#     Simulator MCP tool, a demo): a detached keeper holds it until release or 30 minutes
#     (HR_SIM_HOLD_MIN); hold again from the same folder to renew. It prints the exports to use.
# In the command, {udid} becomes the device's UDID, and SIM_UDID is set for scripts.
#   ios/scripts/sim-run.sh -- xcodebuild test -project HealthRoadmap.xcodeproj -scheme HealthRoadmap
#   ios/scripts/sim-run.sh --reset-app -- xcrun simctl install {udid} <path>.app
# The lock is the kernel's: lockf on an open file in ~/Library/Caches/health-roadmap-sim. The kernel
# frees it when its holder exits, however it exits, so there is no stale lock to take over. The
# holder file there is information for status and waiting messages, never the lock. A call made
# with HR_SIM_LEASE set to the holder's token (a script under the lock, or a session holding it)
# runs without taking it again. The device stays booted between runs and shuts down after
# HR_SIM_IDLE_MIN minutes with no holder (a detached sleep, no daemon).
# Settings: HR_SIM_WAIT_MIN (30), HR_SIM_IDLE_MIN (20; 0 keeps it booted), HR_SIM_HOLD_MIN (30),
# HR_SIM_RUN_LIMIT_SECONDS (1800, a whole run's time limit), HR_SIM_DEVICE_TYPE (iPhone-18-Pro, the
# 6.3-inch size App Store Connect takes), HR_SIM_HOME. Tests: ios/scripts/sim-run.test.ts.

SELF="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
HOME_DIR="${HR_SIM_HOME:-$HOME/Library/Caches/health-roadmap-sim}"
LOCK="$HOME_DIR/lock"
INFO="$HOME_DIR/holder"
NAME="HR Shared iPhone"
TYPE="${HR_SIM_DEVICE_TYPE:-iPhone-18-Pro}"
WAIT_SECONDS="${HR_SIM_WAIT_SECONDS:-$(( ${HR_SIM_WAIT_MIN:-30} * 60 ))}"
IDLE_SECONDS="${HR_SIM_IDLE_SECONDS:-$(( ${HR_SIM_IDLE_MIN:-20} * 60 ))}"
HOLD_SECONDS="${HR_SIM_HOLD_SECONDS:-$(( ${HR_SIM_HOLD_MIN:-30} * 60 ))}"
RUN_LIMIT="${HR_SIM_RUN_LIMIT_SECONDS:-1800}"
KILL_SECONDS="${HR_SIM_KILL_SECONDS:-20}"
PROJECT="$(dirname "$SELF")/../HealthRoadmap.xcodeproj/project.pbxproj"
OWN=0 CHILD="" WATCHDOG="" UDID="" TOKEN="$$-$(date +%s)"

die() { echo "sim-run: $*" >&2; exit "${2:-1}"; }
now() { date +%s; }
hhmm() { date -r "$1" +%H:%M; }
lstart() { ps -o lstart= -p "$1" 2>/dev/null | sed 's/^ *//'; }
field() { sed -n "s/^$1=//p" "$INFO" 2>/dev/null | head -1; }
ago() { local s=$(( $(now) - $1 )); [ "$s" -lt 3600 ] && echo "$((s / 60))m$((s % 60))s" || echo "$((s / 3600))h$((s % 3600 / 60))m"; }
# True while some process holds the lock (a probe on its own open file, released at once).
held() { mkdir -p "$HOME_DIR"; ! ( exec 8>>"$LOCK"; lockf -s -t 0 8 ); }
# The recorded holder is that same process: its pid runs and started when recorded. A ps that
# fails or prints nothing cannot prove otherwise, so it counts as the same process.
same_holder() {
  local pid=$(field pid) was=$(field lstart) is
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null || return 1
  is=$(lstart "$pid")
  [ -z "$is" ] || [ -z "$was" ] || [ "$is" = "$was" ]
}

write_info() {  # $1: run, hold or demo; $2: until (epoch or empty); the rest: the command
  local kind=$1 until=$2 tmp="$HOME_DIR/holder.$$"
  shift 2
  printf 'pid=%s\nlstart=%s\ntoken=%s\nkind=%s\nstarted=%s\nuntil=%s\ncwd=%s\ncommand=%s\n' "$$" "$(lstart $$)" \
    "$TOKEN" "$kind" "$(now)" "$until" "$PWD" "$(printf '%s ' "$@" | tr '\n' ' ' | cut -c1-300)" > "$tmp"
  mv "$tmp" "$INFO"
}

describe() {
  case "$(field kind)" in
    demo) echo "held for a demo until $(hhmm "$(field until)") ($(field cwd))";;
    hold) echo "held until $(hhmm "$(field until)") by a session in $(field cwd)";;
    *) echo "in use by pid $(field pid) for $(ago "$(field started)") ($(field cwd)): $(field command)";;
  esac
}

# Takes the lock on fd 9, waiting up to WAIT_SECONDS with one line naming the holder.
take_lock() {
  mkdir -p "$HOME_DIR" || die "cannot make $HOME_DIR"
  exec 9>>"$LOCK"
  if ! lockf -s -t 0 9; then
    echo "sim-run: the shared simulator is $(describe)" >&2
    echo "sim-run: waiting up to $((WAIT_SECONDS / 60))m (HR_SIM_WAIT_MIN)" >&2
    lockf -s -t "$WAIT_SECONDS" 9 || die "gave up after ${WAIT_SECONDS}s: the simulator is still $(describe)" 75
  fi
  OWN=1
}

# On the holder's exit: arm the idle shutdown, a detached sleep that shuts the device down only if no
# one has held the device since (last-release still holds this stamp). The sleeper gets no fd 9,
# so it never holds the lock. The kernel frees the lock when this process exits.
on_exit() {
  [ -n "$WATCHDOG" ] && kill "$WATCHDOG" 2>/dev/null
  [ "$OWN" = 1 ] || return 0
  local stamp="$(now)-$$"
  echo "$stamp" > "$HOME_DIR/last-release"
  [ "$IDLE_SECONDS" -gt 0 ] 2>/dev/null || return 0
  # fork + setsid: the sleeper leaves this session's process group, so it outlives the caller's shell.
  perl -MPOSIX -e 'fork and exit; POSIX::setsid(); exec @ARGV' "$SELF" _idle "$stamp" </dev/null >/dev/null 2>&1 9>&-
}

idle_shutdown() {
  sleep "$IDLE_SECONDS"
  [ "$(cat "$HOME_DIR/last-release" 2>/dev/null)" = "$1" ] || exit 0
  exec 9>>"$LOCK"
  lockf -s -t 0 9 || exit 0
  [ "$(cat "$HOME_DIR/last-release" 2>/dev/null)" = "$1" ] || exit 0
  write_info run "" idle shutdown
  UDID=$(cat "$HOME_DIR/udid" 2>/dev/null)
  [ -n "$UDID" ] && xcrun simctl shutdown "$UDID" >/dev/null 2>&1
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

boot_if_down() {
  [ "$(device_state "$UDID")" = Booted ] && return
  echo "sim-run: booting $NAME ($UDID)" >&2
  xcrun simctl bootstatus "$UDID" -b >/dev/null || die "could not boot $UDID"
}

# hold [--demo]: take the lock (waiting like any caller), boot the device, and pass the lock to a
# detached keeper that inherits fd 9: the lock never leaves a holder. Hold again from the same
# folder to renew. Prints the exports a session uses to run under the hold.
hold() {
  local kind=hold
  [ "${1:-}" = --demo ] && kind=demo
  mkdir -p "$HOME_DIR"
  if held && case "$(field kind)" in hold|demo) true;; *) false;; esac && [ "$(field cwd)" = "$PWD" ] && same_holder; then
    kill -USR1 "$(field pid)"
    sleep 0.5
    echo "sim-run: renewed; $(describe)" >&2
    printf 'export HR_SIM_LEASE=%s\nexport SIM_UDID=%s\n' "$(field token)" "$(cat "$HOME_DIR/udid")"
    return
  fi
  take_lock
  write_info "$kind" "" hold
  ensure_device
  boot_if_down
  perl -MPOSIX -e 'fork and exit; POSIX::setsid(); exec @ARGV' "$SELF" _keep "$TOKEN" "$kind" </dev/null >/dev/null 2>&1
  for _ in $(seq 50); do [ "$(field pid)" != "$$" ] && break; sleep 0.1; done
  [ "$(field pid)" != "$$" ] || die "the keeper did not start"
  echo "sim-run: $(describe); give it back with: ios/scripts/sim-run.sh release" >&2
  printf 'export HR_SIM_LEASE=%s\nexport SIM_UDID=%s\n' "$TOKEN" "$UDID"
}

keep() {
  TOKEN=$1 OWN=1
  local kind=$2 until=$(( $(now) + HOLD_SECONDS ))
  write_info "$kind" "$until" hold
  trap 'until=$(( $(now) + HOLD_SECONDS )); write_info "$kind" "$until" hold' USR1
  trap 'exit 0' TERM
  trap on_exit EXIT
  while [ "$(now)" -lt "$until" ]; do sleep 1 9>&- & wait $!; done
  exit 0
}

# release: ends a hold taken from this folder (--force, for a person: from any folder). A running
# command's lock is never released here; it goes when the command ends. Only the recorded keeper is
# signalled, and only once it is proven to be that process.
release_hold() {
  held || { echo "sim-run: nothing holds the simulator" >&2; return 0; }
  case "$(field kind)" in hold|demo) ;; *) die "the simulator is $(describe); it is freed when that command ends";; esac
  [ "$(field cwd)" = "$PWD" ] || [ "${1:-}" = --force ] || die "that hold was taken in $(field cwd); release it from there"
  [ -n "$(lstart "$(field pid)")" ] && same_holder || die "cannot confirm that pid $(field pid) is the keeper; nothing was signalled"
  kill -TERM "$(field pid)"
  for _ in $(seq 50); do held || break; sleep 0.1; done
  echo "sim-run: released" >&2
}

# A direct xcodebuild runs on the shared device by id. Any destination naming another simulator,
# wherever it appears, is refused; a physical device or generic/ destination is left alone. Tests get:
#   -parallel-testing-enabled NO: parallel testing clones the simulator per test runner; the clones
#     fill the disk and the process table (docs/gotchas.md 2026-10-24, 2026-10-26).
#   -maximum-concurrent-test-simulator-destinations 1: never test on two simulators at once. Xcode
#     27.2 has no -disable-concurrent-destination-testing; this is its flag for the same thing.
is_sim_dest() {
  case "$1" in generic/*) return 1;; *Simulator*) return 0;; esac
  printf '%s' "$1" | grep -qiE '(^|,)id=[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(,|$)'
}
prepare_xcodebuild() {
  local a prev="" dests=0 sims=0 testing=0 parallel=0 maxdest=0
  for a in "$@"; do
    case "$prev" in
      -destination) dests=$((dests + 1))
        if is_sim_dest "$a"; then
          sims=$((sims + 1))
          case ",$a," in *",id=$UDID,"*) ;; *) die "runs on the shared simulator only: drop -destination '$a' (sim-run adds id=$UDID)" 64;; esac
        fi;;
      -parallel-testing-enabled) [ "$a" = NO ] || die "the shared simulator runs tests with -parallel-testing-enabled NO only" 64; parallel=1;;
      -maximum-concurrent-test-simulator-destinations) [ "$a" = 1 ] || die "the shared simulator takes -maximum-concurrent-test-simulator-destinations 1 only" 64; maxdest=1;;
    esac
    case "$a" in test|test-without-building|build-for-testing) testing=1;; esac
    prev="$a"
  done
  CMD=("$@")
  [ "$dests" -gt 0 ] || { CMD+=(-destination "id=$UDID"); sims=1; }
  [ "$testing" = 1 ] && [ "$parallel" = 0 ] && CMD+=(-parallel-testing-enabled NO)
  [ "$testing" = 1 ] && [ "$maxdest" = 0 ] && CMD+=(-maximum-concurrent-test-simulator-destinations 1)
  # Only running tests on the simulator needs it booted; a build, or build-for-testing, does not.
  NEEDS_BOOT=0
  [ "$sims" -gt 0 ] && printf '%s\n' "$@" | grep -qxE 'test|test-without-building' && NEEDS_BOOT=1
}

status() {
  local udid state booted procs orphans
  udid=$(cat "$HOME_DIR/udid" 2>/dev/null)
  state=$([ -n "$udid" ] && device_state "$udid")
  echo "Shared device: $NAME ${udid:+($udid) }${state:-not created yet}"
  booted=$(xcrun simctl list devices booted | grep -E '\(Booted\)' | sed 's/^ */  /')
  echo "Booted simulators:"
  echo "${booted:-  none}"
  if held; then
    echo "Holder: $(describe), pid $(field pid) ($(same_holder && echo running || echo not running)), since $(ago "$(field started)") ago"
  else
    echo "Holder: none (idle shutdown $((IDLE_SECONDS / 60))m after the last holder lets go)"
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
    echo "To clean up, run it yourself while nothing holds the simulator (it stops any session's run):"
    echo "  xcrun simctl shutdown all && pkill -f 'simruntime/Contents/Resources/RuntimeRoot'"
  fi
  echo "Parallel-test clones (if any): ios/scripts/clean-test-clones.sh"
}

case "${1:-}" in
  status) status; exit 0;;
  hold) hold "${2:-}"; exit 0;;
  release) release_hold "${2:-}"; exit 0;;
  _keep) keep "$2" "$3";;
  _idle) idle_shutdown "$2";;
esac

RESET=0
while [ $# -gt 0 ]; do
  case "$1" in
    --reset-app) RESET=1; shift;;
    --) shift; break;;
    *) die "usage: sim-run.sh [--reset-app] -- <command...> | status | hold [--demo] | release" 64;;
  esac
done
[ $# -gt 0 ] || die "usage: sim-run.sh [--reset-app] -- <command...> | status | hold [--demo] | release" 64

# Stops the command's whole process group (a script's xcodebuild too): TERM, up to KILL_SECONDS for
# it to go, then KILL. This process, and so the lock, outlives the group.
group_alive() { kill -0 -- "-$CHILD" 2>/dev/null; }
stop_command() {
  [ -n "$CHILD" ] || return 0
  kill -TERM -- "-$CHILD" 2>/dev/null
  for _ in $(seq $((KILL_SECONDS * 10))); do group_alive || return 0; sleep 0.1; done
  kill -KILL -- "-$CHILD" 2>/dev/null
  for _ in $(seq 50); do group_alive || return 0; sleep 0.1; done
}
on_signal() { stop_command; exit "$1"; }
trap on_exit EXIT
trap 'on_signal 130' INT
trap 'on_signal 143' TERM
trap 'on_signal 129' HUP
trap 'echo "sim-run: stopped at the time limit (${RUN_LIMIT}s, HR_SIM_RUN_LIMIT_SECONDS)" >&2; on_signal 124' USR1

# A call from inside a run, or from a session holding the simulator, has the holder's token.
if [ -n "${HR_SIM_LEASE:-}" ] && [ "$HR_SIM_LEASE" = "$(field token)" ] && held; then
  TOKEN=$HR_SIM_LEASE
else
  take_lock
  write_info run "" "$@"
  # Signals only its own parent: if this process is gone, the pid may be someone else's.
  perl -e 'sleep $ARGV[0]; kill "USR1", $ARGV[1] if getppid() == $ARGV[1]' "$RUN_LIMIT" $$ </dev/null >/dev/null 2>&1 9>&- &
  WATCHDOG=$!
fi
ensure_device

ARGS=()
for a in "$@"; do ARGS+=("${a//\{udid\}/$UDID}"); done
set -- "${ARGS[@]}"
[ "$1" = xcrun ] && [ "${2:-}" = xcodebuild ] && shift
NEEDS_BOOT=1 CMD=("$@")
[ "$(basename "$1")" = xcodebuild ] && prepare_xcodebuild "$@"
[ "$RESET" = 1 ] && NEEDS_BOOT=1  # simctl uninstall needs a booted device

[ "$NEEDS_BOOT" = 1 ] && boot_if_down
if [ "$RESET" = 1 ]; then
  BUNDLE=$(sed -n -E 's/.*PRODUCT_BUNDLE_IDENTIFIER = ([A-Za-z0-9.-]+);/\1/p' "$PROJECT" | grep -vE '\.(ui)?tests$' | head -1)
  [ -n "$BUNDLE" ] || die "no app bundle id in $PROJECT"
  xcrun simctl uninstall "$UDID" "$BUNDLE" 2>/dev/null || true
  # Settings written with `simctl spawn defaults` (welcomed, onboarded) live outside the app and survive it.
  xcrun simctl spawn "$UDID" defaults delete "$BUNDLE" 2>/dev/null || true
fi

# In its own process group (so a stop reaches all of it), in the background (bash defers traps while
# a foreground child runs), without fd 9 (a helper it leaves behind cannot keep the lock), and with
# stdin kept (a background job would lose it). HR_SIM_INNER is the command's own pid, so a script
# that re-runs itself through sim-run knows it is the command and not a stray child.
HR_SIM_LEASE="$TOKEN" SIM_UDID="$UDID" perl -e '$ENV{HR_SIM_INNER} = $$; setpgrp(0, 0); exec { $ARGV[0] } @ARGV or die "sim-run: $ARGV[0]: $!\n"' "${CMD[@]}" <&0 9>&- &
CHILD=$!
wait "$CHILD"
RC=$?
CHILD=""
exit "$RC"
