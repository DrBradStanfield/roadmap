#!/bin/sh
# Builds the engine and runs the iOS tests once per pinned time zone (US-25 AC1).
# The zone is fixed at process launch because JavaScriptCore reads it once.
# A skipped parity test fails the run: a skip would mean the zone pin was lost.
# Each zone's run takes the shared simulator's lock (sim-run.sh, US-71 AC7).
# A failed zone does not stop the other: both run, and the script fails if either did.
# A failed zone outranks a later zone's 75 or 76: the script then reports the failure and exits 1.
#   ios/scripts/test.sh
set -eu
cd "$(dirname "$0")/.."
node scripts/build-engine.mjs
LOG="build/test-output.txt"
STATUS="build/sim-run-status"
# DerivedData outside the repo, one folder per checkout: a repo in an iCloud-synced
# ~/Documents gets Finder xattrs on its build products, and codesign refuses them.
DERIVED="${HR_DERIVED_DATA:-${TMPDIR:-/tmp}/HealthRoadmap-$(pwd | shasum | cut -c1-8)}"
mkdir -p build
trap scripts/clean-test-clones.sh EXIT
FAILED=""
LOGS=""
report_failed() { [ -z "$FAILED" ] || { echo "iOS tests FAILED in:$FAILED (logs:$LOGS)"; exit 1; }; }
for ZONE in UTC Pacific/Auckland; do
  echo "== tests in $ZONE"
  # A failed zone's log is copied here, since the next zone's run overwrites $LOG.
  ZLOG="build/test-output-$(echo "$ZONE" | tr / -).txt"
  rm -f "$STATUS" "$ZLOG"
  # sim-run adds the shared device, -parallel-testing-enabled NO and a time limit. Its exit code is
  # kept in $STATUS: the pipe drops it. 75 means it refused or gave up waiting, so no test ran (US-71
  # AC7, AC8); 76 means another simulator booted during the run and it stopped (AC7).
  { TEST_RUNNER_TZ="$ZONE" scripts/sim-run.sh -- xcodebuild test \
    -project HealthRoadmap.xcodeproj -scheme HealthRoadmap \
    -skip-testing:HealthRoadmapUITests \
    -derivedDataPath "$DERIVED" 2>&1 || echo $? > "$STATUS"; } | tee "$LOG" | grep -E "Test case|error:|TEST (SUCCEEDED|FAILED)|sim-run:" || true
  case "$(cat "$STATUS" 2>/dev/null)" in
    75) echo "NOT RUN in $ZONE: sim-run refused or gave up; see its line above (not a test failure)"; report_failed; exit 75;;
    76) echo "STOPPED in $ZONE: another simulator booted during the run; see sim-run's line above (not a test failure)"; report_failed; exit 76;;
  esac
  if ! grep -q "TEST SUCCEEDED" "$LOG"; then
    cp "$LOG" "$ZLOG"; echo "FAILED in $ZONE (log: ios/$ZLOG)"; FAILED="$FAILED $ZONE"; LOGS="$LOGS ios/$ZLOG"
  elif grep -q "testEveryFixtureMatchesTheSourceInThisZone().*skipped" "$LOG"; then
    cp "$LOG" "$ZLOG"
    echo "FAILED: the parity test skipped in $ZONE, so the zone pin did not reach it (log: ios/$ZLOG)"; FAILED="$FAILED $ZONE"; LOGS="$LOGS ios/$ZLOG"
  else
    echo "passed in $ZONE"
  fi
done
report_failed
echo "All iOS tests passed in UTC and Pacific/Auckland."
