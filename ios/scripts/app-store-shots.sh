#!/bin/sh
# Takes the App Store screenshots (ios/app-store.md step 6) on a 6.9-inch simulator:
# installs the app fresh, seeds docs/examples/health-roadmap.sample.json as the record,
# skips the welcome and onboarding, sets Apple's 9:41 status bar, then runs the opt-in
# AppStoreScreenshots UI test and saves its pictures in ios/build/app-store-shots/.
# Uninstalls the app from that simulator first.
#   ios/scripts/app-store-shots.sh ["iPhone 18 Pro Max"]
set -eu
cd "$(dirname "$0")/.."
DEVICE="${1:-iPhone 18 Pro Max}"
APP_ID=com.drbrad.healthroadmap
DERIVED="${HR_DERIVED_DATA:-${TMPDIR:-/tmp}/HealthRoadmap-$(pwd | shasum | cut -c1-8)}"
OUT=build/app-store-shots
ID=$(xcrun simctl list devices available | grep -F "    $DEVICE (" | head -1 | sed -E 's/.*\(([0-9A-F-]{36})\).*/\1/')
[ -n "$ID" ] || { echo "No simulator named $DEVICE"; exit 1; }

node scripts/build-engine.mjs >/dev/null
xcodebuild build-for-testing -project HealthRoadmap.xcodeproj -scheme HealthRoadmap \
  -destination "id=$ID" -derivedDataPath "$DERIVED" -quiet
xcrun simctl boot "$ID" 2>/dev/null || true
xcrun simctl bootstatus "$ID" -b >/dev/null
xcrun simctl uninstall "$ID" "$APP_ID" 2>/dev/null || true
xcrun simctl install "$ID" "$DERIVED/Build/Products/Debug-iphonesimulator/HealthRoadmap.app"

# A first launch makes the app's folders; then the sample record replaces its empty one.
xcrun simctl launch "$ID" "$APP_ID" --ui-testing >/dev/null
DATA=$(xcrun simctl get_app_container "$ID" "$APP_ID" data)
for _ in 1 2 3 4 5 6 7 8 9 10; do [ -d "$DATA/Library/Application Support/Record" ] && break; sleep 1; done
xcrun simctl terminate "$ID" "$APP_ID"
# The fictional sample record (docs/examples/README.md), plus five earlier weights so the
# value page shows a trend. The sample itself is untouched: tests pin it.
node -e '
const fs = require("fs");
const record = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const weights = [["2026-03-02", 73.4], ["2026-04-06", 72.1], ["2026-05-12", 71.0], ["2026-06-15", 70.2], ["2026-07-20", 69.3]];
for (const [day, value] of weights) record.measurements.push({ source: "manual", status: "active", correctsId: null, externalId: null,
  id: `sample-weight-${day}`, metricType: "weight", value, recordedAt: day, createdAt: `${day}T08:00:00Z` });
fs.writeFileSync(process.argv[2], JSON.stringify(record));
' ../docs/examples/health-roadmap.sample.json "$DATA/Library/Application Support/Record/health-roadmap.json"
xcrun simctl spawn "$ID" defaults write "$APP_ID" welcomed -bool YES
xcrun simctl spawn "$ID" defaults write "$APP_ID" onboarded -bool YES
xcrun simctl status_bar "$ID" override --time 9:41 --dataNetwork wifi --wifiBars 3 --cellularMode active --cellularBars 4 --batteryState charged --batteryLevel 100
# The skip settings live outside the app and survive an uninstall: take them away after.
trap 'xcrun simctl status_bar "$ID" clear; xcrun simctl spawn "$ID" defaults delete "$APP_ID" 2>/dev/null || true' EXIT

RESULT="$DERIVED/app-store-shots.xcresult"
rm -rf "$RESULT"
TEST_RUNNER_APP_STORE_SHOTS=1 xcodebuild test-without-building -project HealthRoadmap.xcodeproj \
  -scheme HealthRoadmap -destination "id=$ID" -derivedDataPath "$DERIVED" \
  -parallel-testing-enabled NO -resultBundlePath "$RESULT" \
  -only-testing:HealthRoadmapUITests/AppStoreScreenshots -quiet

rm -rf "$OUT" && mkdir -p "$OUT"
xcrun xcresulttool export attachments --path "$RESULT" --output-path "$OUT" >/dev/null
# Name each picture by its step ("1 my data.png", ...).
node -e '
const fs = require("fs"), path = require("path"), dir = process.argv[1];
for (const test of JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8")))
  for (const a of test.attachments) {
    const name = a.suggestedHumanReadableName.replace(/_\d+_[0-9A-F-]+\.png$/i, "") + ".png";
    fs.renameSync(path.join(dir, a.exportedFileName), path.join(dir, name));
  }
fs.rmSync(path.join(dir, "manifest.json"));
' "$OUT"
ls "$OUT"
