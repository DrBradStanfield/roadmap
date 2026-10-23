#!/bin/bash
# Builds the app and starts it in the simulator as a brand-new install, so
# onboarding runs from its first screen (Brad 2026-10-23). It removes the app,
# its settings and its privacy answers (Health, camera, photos), and resets the
# simulator's whole keychain (every app's, on that simulator only), then installs
# and launches. Usage: ios/scripts/fresh-sim.sh [simulator name or UDID]
set -euo pipefail
cd "$(dirname "$0")/.."

device="${1:-iPhone 18 Pro}"
bundle=com.drbrad.healthroadmap
derived="${HR_DERIVED_DATA:-$TMPDIR/HealthRoadmap-sim}"

xcrun simctl boot "$device" 2>/dev/null || true
node scripts/build-engine.mjs >/dev/null
# xcodebuild takes a UDID only as id=, a name only as name=.
if [[ "$device" =~ ^[0-9A-F-]{36}$ ]]; then where="id=$device"; else where="platform=iOS Simulator,name=$device"; fi
xcodebuild -project HealthRoadmap.xcodeproj -scheme HealthRoadmap \
  -destination "$where" -derivedDataPath "$derived" build -quiet

xcrun simctl uninstall "$device" "$bundle" 2>/dev/null || true
xcrun simctl keychain "$device" reset
# Settings written with `simctl spawn defaults` (app-store-shots.sh) sit outside the app and survive an uninstall.
xcrun simctl spawn "$device" defaults delete "$bundle" 2>/dev/null || true
xcrun simctl install "$device" "$derived/Build/Products/Debug-iphonesimulator/HealthRoadmap.app"
xcrun simctl privacy "$device" reset all "$bundle"
xcrun simctl launch "$device" "$bundle"
