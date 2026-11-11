#!/bin/sh
# Builds the engine and runs the iOS tests once per pinned time zone (US-25 AC1).
# The zone is fixed at process launch because JavaScriptCore reads it once.
# A skipped parity test fails the run: a skip would mean the zone pin was lost.
# Each zone's run takes the shared simulator's lock (sim-run.sh, US-71 AC7).
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
for ZONE in UTC Pacific/Auckland; do
  echo "== tests in $ZONE"
  rm -f "$STATUS"
  # sim-run adds the shared device, -parallel-testing-enabled NO and a time limit. Its exit code is
  # kept in $STATUS: the pipe drops it, and 75 means it gave up waiting, so no test ran (US-71 AC8).
  { TEST_RUNNER_TZ="$ZONE" scripts/sim-run.sh -- xcodebuild test \
    -project HealthRoadmap.xcodeproj -scheme HealthRoadmap \
    -skip-testing:HealthRoadmapUITests \
    -derivedDataPath "$DERIVED" 2>&1 || echo $? > "$STATUS"; } | tee "$LOG" | grep -E "Test case|error:|TEST (SUCCEEDED|FAILED)|sim-run:" || true
  if [ "$(cat "$STATUS" 2>/dev/null)" = 75 ]; then
    echo "NOT RUN in $ZONE: sim-run gave up waiting (not a test failure)"; exit 75
  fi
  grep -q "TEST SUCCEEDED" "$LOG" || { echo "FAILED in $ZONE"; exit 1; }
  if grep -q "testEveryFixtureMatchesTheSourceInThisZone().*skipped" "$LOG"; then
    echo "FAILED: the parity test skipped in $ZONE, so the zone pin did not reach it"; exit 1
  fi
done
echo "All iOS tests passed in UTC and Pacific/Auckland."
