#!/bin/sh
# Builds the engine and runs the iOS tests once per pinned time zone (US-25 AC1).
# The zone is fixed at process launch because JavaScriptCore reads it once.
# A skipped parity test fails the run: a skip would mean the zone pin was lost.
#   ios/scripts/test.sh ["iPhone 17 Pro"]
set -eu
cd "$(dirname "$0")/.."
node scripts/build-engine.mjs
DEVICE="${1:-iPhone 17 Pro}"
LOG="build/test-output.txt"
# DerivedData outside the repo, one folder per checkout: a repo in an iCloud-synced
# ~/Documents gets Finder xattrs on its build products, and codesign refuses them.
DERIVED="${HR_DERIVED_DATA:-${TMPDIR:-/tmp}/HealthRoadmap-$(pwd | shasum | cut -c1-8)}"
mkdir -p build
trap scripts/clean-test-clones.sh EXIT
for ZONE in UTC Pacific/Auckland; do
  echo "== tests in $ZONE"
  TEST_RUNNER_TZ="$ZONE" xcodebuild test \
    -project HealthRoadmap.xcodeproj -scheme HealthRoadmap \
    -destination "platform=iOS Simulator,name=$DEVICE" \
    -skip-testing:HealthRoadmapUITests \
    -derivedDataPath "$DERIVED" 2>&1 | tee "$LOG" | grep -E "Test case|error:|TEST (SUCCEEDED|FAILED)" || true
  grep -q "TEST SUCCEEDED" "$LOG" || { echo "FAILED in $ZONE"; exit 1; }
  if grep -q "testEveryFixtureMatchesTheSourceInThisZone().*skipped" "$LOG"; then
    echo "FAILED: the parity test skipped in $ZONE, so the zone pin did not reach it"; exit 1
  fi
done
echo "All iOS tests passed in UTC and Pacific/Auckland."
