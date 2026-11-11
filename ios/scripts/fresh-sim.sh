#!/bin/bash
# Builds the app and starts it in the simulator as a brand-new install, so
# onboarding runs from its first screen (Brad 2026-10-23). It removes the app,
# its settings and its privacy answers (Health, camera, photos), and resets the
# simulator's whole keychain (every app's, on that simulator only), then installs
# and launches, on the shared simulator (sim-run.sh, US-71 AC7). It builds first, then takes
# `sim-run.sh hold --demo`: the device is the demo's for 30 minutes (others wait, told so), and
# `sim-run.sh release` from this folder gives it back sooner. A failed run gives it back at once.
# Usage: ios/scripts/fresh-sim.sh
set -euo pipefail
cd "$(dirname "$0")/.."

bundle=com.drstanfield.healthroadmap
derived="${HR_DERIVED_DATA:-$TMPDIR/HealthRoadmap-sim}"

node scripts/build-engine.mjs >/dev/null
# A generic destination builds for any simulator and needs none booted, so no hold yet.
xcodebuild -project HealthRoadmap.xcodeproj -scheme HealthRoadmap \
  -destination "generic/platform=iOS Simulator" -derivedDataPath "$derived" build -quiet

exports=$(scripts/sim-run.sh hold --demo)  # stops here (set -e) if the hold cannot be had
eval "$exports"
trap '[ $? = 0 ] || scripts/sim-run.sh release' EXIT
device=$SIM_UDID

xcrun simctl uninstall "$device" "$bundle" 2>/dev/null || true
xcrun simctl keychain "$device" reset
# Settings written with `simctl spawn defaults` (app-store-shots.sh) sit outside the app and survive an uninstall.
xcrun simctl spawn "$device" defaults delete "$bundle" 2>/dev/null || true
xcrun simctl install "$device" "$derived/Build/Products/Debug-iphonesimulator/HealthRoadmap.app"
xcrun simctl privacy "$device" reset all "$bundle"
xcrun simctl launch "$device" "$bundle"
