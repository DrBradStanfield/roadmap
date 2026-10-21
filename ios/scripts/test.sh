#!/bin/sh
# Builds the engine and runs the iOS tests once per pinned time zone (US-25 AC1).
# The zone is fixed at process launch because JavaScriptCore reads it once.
#   ios/scripts/test.sh ["iPhone 17 Pro"]
set -eu
cd "$(dirname "$0")/.."
node scripts/build-engine.mjs
DEVICE="${1:-iPhone 17 Pro}"
for ZONE in UTC Pacific/Auckland; do
  echo "== tests in $ZONE"
  TEST_RUNNER_TZ="$ZONE" xcodebuild test \
    -project HealthRoadmap.xcodeproj -scheme HealthRoadmap \
    -destination "platform=iOS Simulator,name=$DEVICE" \
    -derivedDataPath build/DerivedData -quiet
done
