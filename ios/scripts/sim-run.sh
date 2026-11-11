#!/bin/bash
# The one door to the shared iOS simulator on this Mac (Brad 2026-11-11: "ideally there would be only
# one simulator"). Every session takes turns on one device, "HR Shared iPhone", under a lock: a session
# checks its work, lets the command finish, and goes back to coding while the next one runs.
#   ios/scripts/sim-run.sh [--reset-app] -- <command...>   run a command on the shared device
#   ios/scripts/sim-run.sh status                           devices, holder, leftover processes
# In the command, {udid} becomes the device's UDID, and SIM_UDID is set for scripts.
#   ios/scripts/sim-run.sh -- xcodebuild test -project HealthRoadmap.xcodeproj -scheme HealthRoadmap
#   ios/scripts/sim-run.sh --reset-app -- xcrun simctl install {udid} <path>.app
# The lock is the kernel's: lockf on a file descriptor (fd 9) opened on ~/Library/Caches/health-roadmap-sim/
# lock. The kernel frees it when every holder of that descriptor has exited, however it exited. The
# holder file there is information for status and waiting messages, never the lock. A call carrying the
# holder's token in HR_SIM_LEASE (a script under the lock calling sim-run again) runs without locking.
# The command runs under a small perl shim that keeps fd 9 while the command (in its own process group,
# without fd 9) runs, and stops the whole group at the run's time limit, on a signal, or when this
# script dies, even by SIGKILL; only then is the lock free. The device stays booted between runs and
# shuts down after HR_SIM_IDLE_MIN minutes with no holder (a detached sleep, no daemon).
# Settings: HR_SIM_WAIT_MIN (30), HR_SIM_IDLE_MIN (20; 0 keeps it booted), HR_SIM_RUN_LIMIT_SECONDS
# (1800), HR_SIM_DEVICE_TYPE (iPhone-18-Pro, the 6.3-inch size App Store Connect takes), HR_SIM_HOME.
# Load guard: before the lock, and once more after taking it, a run waits while the 1-minute load is at
# least HR_SIM_MAX_LOAD (8) or two Codex reviews run (node tools/codex-review.mjs, not --codex fakes),
# polling every HR_SIM_GUARD_POLL_SECONDS (30), never holding the device; HR_SIM_IGNORE_LOAD=1 skips it.
# Guard and lock waits share HR_SIM_WAIT_MIN; giving up on the guard exits 75. status and lease calls
# skip it; an unreadable load fails open.
# Tests: ios/scripts/sim-run.test.ts (macOS only: lockf).

SELF="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
HOME_DIR="${HR_SIM_HOME:-$HOME/Library/Caches/health-roadmap-sim}"
LOCK="$HOME_DIR/lock"
INFO="$HOME_DIR/holder"
NAME="HR Shared iPhone"
DEMO="HR Demo iPhone"
TYPE="${HR_SIM_DEVICE_TYPE:-iPhone-18-Pro}"
WAIT_SECONDS="${HR_SIM_WAIT_SECONDS:-$(( ${HR_SIM_WAIT_MIN:-30} * 60 ))}"
IDLE_SECONDS="${HR_SIM_IDLE_SECONDS:-$(( ${HR_SIM_IDLE_MIN:-20} * 60 ))}"
RUN_LIMIT="${HR_SIM_RUN_LIMIT_SECONDS:-1800}"
KILL_SECONDS="${HR_SIM_KILL_SECONDS:-20}"
MAX_LOAD="${HR_SIM_MAX_LOAD:-8}"
POLL="${HR_SIM_GUARD_POLL_SECONDS:-30}"
START=$(date +%s) REASON="" WARNED=0
PROJECT="$(dirname "$SELF")/../HealthRoadmap.xcodeproj/project.pbxproj"
OWN=0 SHIM="" UDID="" TOKEN="$$-$(date +%s)"

die() { echo "sim-run: $*" >&2; exit "${2:-1}"; }
now() { date +%s; }
field() { sed -n "s/^$1=//p" "$INFO" 2>/dev/null | head -1; }
ago() { local s=$(( $(now) - $1 )); [ "$s" -lt 3600 ] && echo "$((s / 60))m$((s % 60))s" || echo "$((s / 3600))h$((s % 3600 / 60))m"; }
# True while some process holds the lock (a probe on its own open file, let go at once).
held() { mkdir -p "$HOME_DIR"; ! ( exec 8>>"$LOCK"; lockf -s -t 0 8 ); }

write_info() {
  local tmp="$HOME_DIR/holder.$$"
  printf 'pid=%s\ntoken=%s\nstarted=%s\ncwd=%s\ncommand=%s\n' "$$" "$TOKEN" "$(now)" "$PWD" \
    "$(printf '%s ' "$@" | tr '\n' ' ' | cut -c1-300)" > "$tmp"
  mv "$tmp" "$INFO"
}
describe() { echo "in use by pid $(field pid) for $(ago "$(field started)") ($(field cwd)): $(field command)"; }

left() { local r=$(( WAIT_SECONDS - ($(now) - START) )); [ "$r" -gt 0 ] && echo "$r" || echo 0; }

# True when the load guard trips, with REASON saying why. A Codex review is a process whose argv[0]
# is node and a later argument ends in tools/codex-review.mjs, without --codex (the test suite's fake).
# Fails open: an unreadable sysctl or ps never makes a run wait.
guard_tripped() {
  local load out codex
  [ "${HR_SIM_IGNORE_LOAD:-}" = 1 ] && return 1
  load=$(sysctl -n vm.loadavg 2>/dev/null | awk '{ print $2 }')
  if ! [[ "$load" =~ ^[0-9]+(\.[0-9]+)?$ ]] || ! out=$(ps -axo pid=,command= 2>/dev/null) || [ -z "$out" ]; then
    [ "$WARNED" = 1 ] || echo "sim-run: load guard could not read the load; not waiting" >&2
    WARNED=1
    return 1
  fi
  codex=$(printf '%s\n' "$out" | awk -v me=$$ '$1 != me { a = $2; sub(/.*\//, "", a); if (a != "node") next
      hit = 0; for (i = 3; i <= NF; i++) { if ($i ~ /^--codex(=|$)/) next; if ($i ~ /(^|\/)tools\/codex-review\.mjs$/) hit = 1 }
      n += hit } END { print n + 0 }')
  REASON=""
  awk -v l="$load" -v m="$MAX_LOAD" 'BEGIN { exit !(l + 0 >= m + 0) }' && REASON="1-minute load $load is over $MAX_LOAD"
  [ "$codex" -ge 2 ] && REASON="${REASON:+$REASON; }$codex Codex reviews running"
  [ -n "$REASON" ]
}

# Waits while the guard trips, one line a minute, within what is left of WAIT_SECONDS.
wait_guard() {
  local last=-60 rem
  while guard_tripped; do
    rem=$(left)
    [ "$rem" -gt 0 ] || die "gave up after $(ago "$START") (load guard, not the lock): $REASON" 75
    if [ $(( $(now) - last )) -ge 60 ]; then
      echo "sim-run: waiting (load guard): $REASON (HR_SIM_IGNORE_LOAD=1 skips this)" >&2
      last=$(now)
    fi
    sleep "$(awk -v p="$POLL" -v r="$rem" 'BEGIN { print (p + 0 < r + 0) ? p : r }')"
  done
}

# Takes the lock on fd 9, waiting what is left of WAIT_SECONDS with one line naming the holder.
take_lock() {
  mkdir -p "$HOME_DIR" || die "cannot make $HOME_DIR"
  exec 9>>"$LOCK"
  if ! lockf -s -t 0 9; then
    echo "sim-run: the shared simulator is $(describe)" >&2
    echo "sim-run: waiting up to $(( $(left) / 60 ))m (HR_SIM_WAIT_MIN)" >&2
    lockf -s -t "$(left)" 9 || die "gave up after ${WAIT_SECONDS}s: the simulator is still $(describe)" 75
  fi
  OWN=1
}

# Arms the idle shutdown: a detached sleeper, without fd 9, that shuts the device down only if no one
# has held it since (last-release still holds this stamp). The shim does the same if this script is
# killed outright, so a holder's death never leaves the device booted for good.
arm_idle() {
  local stamp="$(now)-$$"
  echo "$stamp" > "$HOME_DIR/last-release"
  [ "$IDLE_SECONDS" -gt 0 ] 2>/dev/null || return 0
  perl -MPOSIX -e 'fork and exit; POSIX::setsid(); exec @ARGV' "$SELF" _idle "$stamp" </dev/null >/dev/null 2>&1 9>&-
}

# The sleeper waits a few seconds for the lock rather than none, so a status probe holding it for a
# moment cannot cancel the shutdown; a run that holds it longer released after this stamp, so it does.
idle_shutdown() {
  sleep "$IDLE_SECONDS"
  [ "$(cat "$HOME_DIR/last-release" 2>/dev/null)" = "$1" ] || exit 0
  exec 9>>"$LOCK"
  lockf -s -t 5 9 || exit 0
  [ "$(cat "$HOME_DIR/last-release" 2>/dev/null)" = "$1" ] || exit 0
  write_info idle shutdown
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

# The index in "$@" of the real tool, past words that pass a command on: VAR=value, env (its options
# and VAR=value), time, nohup, exec, command, nice and xcrun with their options. exec and command are
# shell builtins, so the command line drops them; a leading VAR=value goes through env.
tool_index() {
  local i=1 n=$#
  while [ "$i" -le "$n" ]; do
    [[ "${!i}" =~ ^[A-Za-z_][A-Za-z0-9_]*= ]] && { i=$((i + 1)); continue; }
    case "$(basename "${!i}")" in
      env) i=$((i + 1))
        while [ "$i" -le "$n" ]; do case "${!i}" in -u|-P|-S) i=$((i + 2));; -*|*=*) i=$((i + 1));; *) break;; esac; done;;
      time) i=$((i + 1)); [ "${!i:-}" = -p ] && i=$((i + 1));;
      nohup|exec|command) i=$((i + 1));;
      nice) i=$((i + 1)); case "${!i:-}" in -n) i=$((i + 2));; -[0-9]*) i=$((i + 1));; esac;;
      xcrun) i=$((i + 1))
        while [ "$i" -le "$n" ]; do case "${!i}" in --sdk|-sdk|--toolchain|-toolchain) i=$((i + 2));; -*) i=$((i + 1));; *) break;; esac; done;;
      *) break;;
    esac
  done
  echo "$i"
}

# A direct xcodebuild runs on the shared device by id. A destination must be id=<the shared UDID>
# (or platform=iOS Simulator,id=<it>), generic/..., or a physical device (platform=iOS,id=...); a
# name= form or another simulator is refused. Tests get:
#   -parallel-testing-enabled NO: parallel testing clones the simulator per test runner; the clones
#     fill the disk and the process table (docs/gotchas.md 2026-10-24, 2026-10-26).
#   -maximum-concurrent-test-simulator-destinations 1: never test on two simulators at once. Xcode
#     27.2 has no -disable-concurrent-destination-testing; this is its flag for the same thing.
prepare_xcodebuild() {
  local a prev="" dests=0 sims=0 testing=0 parallel=0 maxdest=0
  for a in "$@"; do
    case "$prev" in
      -destination) dests=$((dests + 1))
        case "$a" in
          "id=$UDID"|"platform=iOS Simulator,id=$UDID") sims=$((sims + 1));;
          generic/*) ;;
          platform=iOS,id=*) case "$a" in *,name=*) die "refused -destination '$a': name a device by id" 64;; esac;;
          *) die "runs on the shared simulator only: drop -destination '$a' (sim-run adds id=$UDID)" 64;;
        esac;;
      -parallel-testing-enabled) [ "$a" = NO ] || die "the shared simulator runs tests with -parallel-testing-enabled NO only" 64; parallel=1;;
      -maximum-concurrent-test-simulator-destinations) [ "$a" = 1 ] || die "the shared simulator takes -maximum-concurrent-test-simulator-destinations 1 only" 64; maxdest=1;;
    esac
    case "$a" in test|test-without-building|build-for-testing) testing=1;; esac
    prev="$a"
  done
  XCB=("$@")
  [ "$dests" -gt 0 ] || { XCB+=(-destination "id=$UDID"); sims=1; }
  [ "$testing" = 1 ] && [ "$parallel" = 0 ] && XCB+=(-parallel-testing-enabled NO)
  [ "$testing" = 1 ] && [ "$maxdest" = 0 ] && XCB+=(-maximum-concurrent-test-simulator-destinations 1)
  # Only running tests on the simulator needs it booted; a build, or build-for-testing, does not.
  NEEDS_BOOT=0
  [ "$sims" -gt 0 ] && printf '%s\n' "$@" | grep -qxE 'test|test-without-building' && NEEDS_BOOT=1
}

# Inside the shim's process group: everything that touches the device (creating, booting, the reset)
# and then the command itself, so the time limit and a stop reach all of it.
inner() {
  local reset=$1 i a
  shift
  ensure_device
  local args=()
  for a in "$@"; do args+=("${a//\{udid\}/$UDID}"); done
  set -- "${args[@]}"
  i=$(tool_index "$@")
  CMD=() NEEDS_BOOT=1
  local envd=0
  for a in "${@:1:i-1}"; do
    case "$(basename "$a")" in
      exec|command) ;;
      env) envd=1; CMD+=("$a");;
      *) [[ "$a" =~ ^[A-Za-z_][A-Za-z0-9_]*= ]] && [ "$envd" = 0 ] && { CMD+=(env); envd=1; }; CMD+=("$a");;
    esac
  done
  case "$(basename "${!i:-}")" in
    xcodebuild) prepare_xcodebuild "${@:i}"; CMD+=("${XCB[@]}");;
    bash|sh|zsh|dash)
      local j=$((i + 1)) k=$((i + 2))
      case "${!j:-}" in -*c*) printf '%s' "${!k:-}" | grep -qwE 'xcodebuild' &&
        die "run xcodebuild directly through sim-run: it cannot add its flags inside a shell string" 64;; esac
      CMD+=("${@:i}");;
    *) CMD+=("${@:i}");;
  esac
  [ "$reset" = 1 ] && NEEDS_BOOT=1  # simctl uninstall needs a booted device
  if [ "$NEEDS_BOOT" = 1 ] && [ "$(device_state "$UDID")" != Booted ]; then
    echo "sim-run: booting $NAME ($UDID)" >&2
    xcrun simctl bootstatus "$UDID" -b >/dev/null || die "could not boot $UDID"
  fi
  if [ "$reset" = 1 ]; then
    local bundle
    bundle=$(sed -n -E 's/.*PRODUCT_BUNDLE_IDENTIFIER = ([A-Za-z0-9.-]+);/\1/p' "$PROJECT" | grep -vE '\.(ui)?tests$' | head -1)
    [ -n "$bundle" ] || die "no app bundle id in $PROJECT"
    xcrun simctl uninstall "$UDID" "$bundle" 2>/dev/null || true
    # Settings written with `simctl spawn defaults` (welcomed, onboarded) live outside the app and survive it.
    xcrun simctl spawn "$UDID" defaults delete "$bundle" 2>/dev/null || true
  fi
  # HR_SIM_INNER is the command's own pid (exec keeps it): a script that re-runs itself through
  # sim-run knows it is the command, not a stray child.
  export SIM_UDID="$UDID" HR_SIM_INNER=$$
  exec "${CMD[@]}"
}

status() {
  local udid state booted procs orphans demo dstate
  udid=$(cat "$HOME_DIR/udid" 2>/dev/null)
  state=$([ -n "$udid" ] && device_state "$udid")
  echo "Shared device: $NAME ${udid:+($udid) }${state:-not created yet}"
  demo=$(xcrun simctl list devices | grep -F "    $DEMO (" | head -1 | sed -E 's/.*\(([0-9A-F-]{36})\).*/\1/')
  if [ -n "$demo" ]; then
    dstate=$(device_state "$demo")
    if [ "$dstate" = Booted ]; then
      echo "Demo device: $DEMO ($demo) Booted$( [ -f "$HOME_DIR/demo-booted" ] && echo " for $(ago "$(cat "$HOME_DIR/demo-booted")")")"
      echo "  To shut it down when the demo is over: xcrun simctl shutdown $demo"
    else
      echo "Demo device: $DEMO ($demo) ${dstate:-?}"
    fi
  fi
  booted=$(xcrun simctl list devices booted | grep -E '\(Booted\)' | sed 's/^ */  /')
  echo "Booted simulators:"
  echo "${booted:-  none}"
  if held; then echo "Holder: $(describe)"; else echo "Holder: none (idle shutdown $((IDLE_SECONDS / 60))m after the last run)"; fi
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

# The shim: forks; the child leaves fd 9, takes its own process group and runs the rest; the parent
# keeps fd 9 (the lock) and waits. On the time limit, a signal, or this script's death (its parent pid
# changes), it sends the group TERM, then KILL after KILL_SECONDS, and exits only once the group is gone.
SHIM='use POSIX ":sys_wait_h";
my ($limit, $grace, $self, $home, $idle) = splice(@ARGV, 0, 5);
my $parent = getppid();
my $pid = fork() // die "sim-run: fork: $!\n";
if (!$pid) { POSIX::close(9); setpgrp(0, 0); exec { $ARGV[0] } @ARGV or die "sim-run: $ARGV[0]: $!\n"; }
my $why = "";
$SIG{$_} = sub { $why ||= "signal" } for qw(INT TERM HUP);
my $start = time;
sub nap { select(undef, undef, undef, $_[0]) }
while (!$why) {
  if (waitpid($pid, WNOHANG) == $pid) { exit(($? & 127) ? 128 + ($? & 127) : $? >> 8) }
  $why = "orphan" if getppid() != $parent;
  $why = "limit" if !$why && time - $start >= $limit;
  nap(0.2) unless $why;
}
print STDERR "sim-run: stopped at the time limit (${limit}s, HR_SIM_RUN_LIMIT_SECONDS)\n" if $why eq "limit";
kill "TERM", -$pid;
for (1 .. $grace * 10) { waitpid($pid, WNOHANG); last unless kill 0, -$pid; nap(0.1) }
kill "KILL", -$pid if kill 0, -$pid;
for (1 .. 50) { waitpid($pid, WNOHANG); last unless kill 0, -$pid; nap(0.1) }
if ($why eq "orphan") {
  my $stamp = time . "-$$";
  my $f;
  if (open($f, ">", "$home/last-release")) { print $f "$stamp\n"; close($f) }
  if ($idle > 0 && !fork()) { POSIX::setsid(); POSIX::close(9); exec $self, "_idle", $stamp }
}
exit($why eq "limit" ? 124 : 143);'

case "${1:-}" in
  status) status; exit 0;;
  _idle) idle_shutdown "$2";;
  _inner) shift; inner "$@";;
esac

RESET=0
while [ $# -gt 0 ]; do
  case "$1" in
    --reset-app) RESET=1; shift;;
    --) shift; break;;
    *) die "usage: sim-run.sh [--reset-app] -- <command...> | status" 64;;
  esac
done
[ $# -gt 0 ] || die "usage: sim-run.sh [--reset-app] -- <command...> | status" 64

# A call from inside a run has the holder's token: it runs in the outer run's group, without locking.
if [ -n "${HR_SIM_LEASE:-}" ] && [ "$HR_SIM_LEASE" = "$(field token)" ] && held; then
  exec "$SELF" _inner "$RESET" "$@"
fi

on_exit() { [ "$OWN" = 1 ] && arm_idle; }
# A signal goes to the shim, which stops the command's group; this script waits for it, then exits.
on_signal() { [ -n "$SHIM" ] && { kill -TERM "$SHIM" 2>/dev/null; wait "$SHIM"; }; exit "$1"; }
trap on_exit EXIT
trap 'on_signal 130' INT
trap 'on_signal 143' TERM
trap 'on_signal 129' HUP
# Never wait on the guard while holding the device: if it trips after the lock is taken, let go.
while :; do
  wait_guard
  take_lock
  guard_tripped || break
  exec 9>&-
  OWN=0
done
write_info "$@"
# In the background so a signal reaches the trap at once (bash defers traps while a foreground child
# runs), with stdin kept (a background job would otherwise lose it).
HR_SIM_LEASE="$TOKEN" perl -e "$SHIM" "$RUN_LIMIT" "$KILL_SECONDS" "$SELF" "$HOME_DIR" "$IDLE_SECONDS" \
  "$SELF" _inner "$RESET" "$@" <&0 &
SHIM=$!
wait "$SHIM"
RC=$?
SHIM=""
exit "$RC"
