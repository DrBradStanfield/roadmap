#!/bin/bash
# Builds the app and starts it in the simulator as a brand-new install, so
# onboarding runs from its first screen (Brad 2026-10-23). It removes the app,
# its settings and its privacy answers (Health, camera, photos), and resets the
# simulator's whole keychain (every app's, on that simulator only), then installs
# and launches.
# Demos run on their own device, "HR Demo iPhone" (made once, by name), never on the shared one
# sim-run.sh lends out (US-71 AC7: a demo holding the shared device was tried and dropped). It is a
# second booted simulator, so it runs only with the escape hatch ios/CLAUDE.md documents for demos.
# It stays booted for the demo; `ios/scripts/sim-run.sh status` shows it, its age and how to shut it down.
# Usage: see ios/CLAUDE.md (xcodebuild and simulators)
set -euo pipefail
cd "$(dirname "$0")/.."
[ "${ALLOW_EXTRA_SIMULATOR:-}" = other-device ] || { echo "fresh-sim boots a second simulator for a demo; see ios/CLAUDE.md for how to run it." >&2; exit 64; }

name="HR Demo iPhone"
bundle=com.drstanfield.healthroadmap
derived="${HR_DERIVED_DATA:-$TMPDIR/HealthRoadmap-sim}"
cache="${HR_SIM_HOME:-$HOME/Library/Caches/health-roadmap-sim}"

node scripts/build-engine.mjs >/dev/null
# A generic destination builds for any simulator and needs none booted.
xcodebuild -project HealthRoadmap.xcodeproj -scheme HealthRoadmap \
  -destination "generic/platform=iOS Simulator" -derivedDataPath "$derived" build -quiet

device=$(xcrun simctl list devices available | grep -F "    $name (" | head -1 | sed -E 's/.*\(([0-9A-F-]{36})\).*/\1/')
[ -n "$device" ] || device=$(xcrun simctl create "$name" com.apple.CoreSimulator.SimDeviceType.iPhone-18-Pro)
if ! xcrun simctl list devices booted | grep -qF "($device)"; then
  xcrun simctl bootstatus "$device" -b >/dev/null
  mkdir -p "$cache" && date +%s > "$cache/demo-booted"
fi

xcrun simctl uninstall "$device" "$bundle" 2>/dev/null || true
xcrun simctl keychain "$device" reset
# Settings written with `simctl spawn defaults` (app-store-shots.sh) sit outside the app and survive an uninstall.
xcrun simctl spawn "$device" defaults delete "$bundle" 2>/dev/null || true
xcrun simctl install "$device" "$derived/Build/Products/Debug-iphonesimulator/HealthRoadmap.app"
xcrun simctl privacy "$device" reset all "$bundle"
xcrun simctl launch "$device" "$bundle"
