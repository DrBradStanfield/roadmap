#!/bin/sh
# Runs the UI tests (HealthRoadmapUITests, US-54) on the simulator, one test at a time,
# each on a fresh install: every test starts from the welcome screen, and a test that
# finishes onboarding would leave the next one past it. The unit tests are test.sh.
# Uninstalls the app from that simulator, so never point it at one holding a real record.
#   ios/scripts/ui-test.sh ["iPhone 17 Pro"]
set -eu
cd "$(dirname "$0")/.."
DEVICE="${1:-iPhone 17 Pro}"
DERIVED="${HR_DERIVED_DATA:-${TMPDIR:-/tmp}/HealthRoadmap-$(pwd | shasum | cut -c1-8)}"
ID=$(xcrun simctl list devices available | grep -F "    $DEVICE (" | head -1 | sed -E 's/.*\(([0-9A-F-]{36})\).*/\1/')
[ -n "$ID" ] || { echo "No simulator named $DEVICE"; exit 1; }
xcodebuild build-for-testing -project HealthRoadmap.xcodeproj -scheme HealthRoadmap \
  -destination "id=$ID" -derivedDataPath "$DERIVED" -quiet
TESTS=$(grep -h -o -E 'func (test[A-Za-z0-9_]+)\(' HealthRoadmapUITests/*.swift | sed -E 's/func (test[A-Za-z0-9_]+)\(/\1/')
trap scripts/clean-test-clones.sh EXIT
FAILED=0
for TEST in $TESTS; do
  CLASS=$(grep -l "func $TEST(" HealthRoadmapUITests/*.swift | head -1 | xargs basename | sed 's/\.swift$//')
  xcrun simctl boot "$ID" 2>/dev/null || true
  xcrun simctl bootstatus "$ID" -b >/dev/null
  xcrun simctl uninstall "$ID" com.drstanfield.healthroadmap 2>/dev/null || true
  if xcodebuild test-without-building -project HealthRoadmap.xcodeproj -scheme HealthRoadmap \
      -destination "id=$ID" -derivedDataPath "$DERIVED" -parallel-testing-enabled NO \
      -only-testing:"HealthRoadmapUITests/$CLASS/$TEST" 2>&1 | grep -q "TEST EXECUTE SUCCEEDED"; then
    echo "passed: $CLASS.$TEST"
  else
    echo "FAILED: $CLASS.$TEST"
    FAILED=1
  fi
done
[ "$FAILED" = 0 ] && echo "All UI tests passed." || exit 1
