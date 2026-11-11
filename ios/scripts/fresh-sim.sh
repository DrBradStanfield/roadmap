#!/bin/bash
# Builds the app and starts it in the simulator as a brand-new install, so
# onboarding runs from its first screen (Brad 2026-10-23). It removes the app,
# its settings and its privacy answers (Health, camera, photos), and resets the
# simulator's whole keychain (every app's, on that simulator only), then installs
# and launches, on the shared simulator under its lease (sim-run.sh, US-71 AC7). The
# device then stays booted for the demo (no idle shutdown until the next run's release).
# Usage: ios/scripts/fresh-sim.sh
set -euo pipefail
cd "$(dirname "$0")/.."
[ -n "${HR_SIM_LEASE:-}" ] || HR_SIM_IDLE_MIN=0 exec scripts/sim-run.sh -- scripts/fresh-sim.sh

device=$SIM_UDID
bundle=com.drstanfield.healthroadmap
derived="${HR_DERIVED_DATA:-$TMPDIR/HealthRoadmap-sim}"

node scripts/build-engine.mjs >/dev/null
xcodebuild -project HealthRoadmap.xcodeproj -scheme HealthRoadmap \
  -destination "id=$device" -derivedDataPath "$derived" build -quiet

xcrun simctl uninstall "$device" "$bundle" 2>/dev/null || true
xcrun simctl keychain "$device" reset
# Settings written with `simctl spawn defaults` (app-store-shots.sh) sit outside the app and survive an uninstall.
xcrun simctl spawn "$device" defaults delete "$bundle" 2>/dev/null || true
xcrun simctl install "$device" "$derived/Build/Products/Debug-iphonesimulator/HealthRoadmap.app"
xcrun simctl privacy "$device" reset all "$bundle"
xcrun simctl launch "$device" "$bundle"
