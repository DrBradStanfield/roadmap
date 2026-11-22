#!/bin/sh
# Screenshots of the screens whose words name a medicine or a range, for reading the wording on
# the real screens: the BMI, HbA1c and eGFR pages, every plan step that names a medicine (opened
# to its sources), the medication questions, Chat's consent before agreeing, the lab upload's
# first screen and Settings. Installs the app fresh, seeds the fictional sample record with the
# values in fixtures/review-shots.values.json, skips the welcome and onboarding, then runs the
# opt-in ReviewScreenshots UI test and saves its pictures by name.
# Nothing is sent: the test never agrees to Chat or the lab read, and the app's server points at
# a closed local port. Runs on the shared simulator under its lock (sim-run.sh, US-71 AC7), and
# uninstalls the app there first.
#   ios/scripts/review-shots.sh [output folder]     (default ios/build/review-shots)
set -eu
cd "$(dirname "$0")/.."
[ "${HR_SIM_INNER:-}" = "$$" ] || exec scripts/sim-run.sh -- scripts/review-shots.sh "$@"
APP_ID=com.drstanfield.healthroadmap
DERIVED="${HR_DERIVED_DATA:-${TMPDIR:-/tmp}/HealthRoadmap-$(pwd | shasum | cut -c1-8)}"
OUT="${1:-build/review-shots}"
ID=$SIM_UDID

node scripts/build-engine.mjs >/dev/null
xcodebuild build-for-testing -project HealthRoadmap.xcodeproj -scheme HealthRoadmap \
  -destination "id=$ID" -derivedDataPath "$DERIVED" -quiet
APP="$DERIVED/Build/Products/Debug-iphonesimulator/HealthRoadmap.app"
echo "Built version: $(/usr/libexec/PlistBuddy -c 'Print CFBundleShortVersionString' "$APP/Info.plist") ($(/usr/libexec/PlistBuddy -c 'Print CFBundleVersion' "$APP/Info.plist"))"
xcrun simctl bootstatus "$ID" -b >/dev/null
# The skip settings (outside the app, they survive an uninstall) and the status bar: undone however the run ends.
trap 'xcrun simctl status_bar "$ID" clear; xcrun simctl spawn "$ID" defaults delete "$APP_ID" 2>/dev/null || true; scripts/clean-test-clones.sh' EXIT
xcrun simctl uninstall "$ID" "$APP_ID" 2>/dev/null || true
xcrun simctl install "$ID" "$APP"

# A first launch makes the app's folders; then the seeded record replaces its empty one.
xcrun simctl launch "$ID" "$APP_ID" --ui-testing >/dev/null
DATA=$(xcrun simctl get_app_container "$ID" "$APP_ID" data)
for _ in 1 2 3 4 5 6 7 8 9 10; do [ -d "$DATA/Library/Application Support/Record" ] && break; sleep 1; done
xcrun simctl terminate "$ID" "$APP_ID"
node -e '
const fs = require("fs");
const record = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const values = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
Object.assign(record.profile, values.profile);
record.measurements = values.measurements.map(([metricType, value, day]) => ({ source: "manual", status: "active", correctsId: null,
  externalId: null, id: `review-${metricType}-${day}`, metricType, value, recordedAt: day, createdAt: `${day}T08:00:00Z` }));
record.medications = [];
fs.writeFileSync(process.argv[3], JSON.stringify(record));
' ../docs/examples/health-roadmap.sample.json scripts/fixtures/review-shots.values.json "$DATA/Library/Application Support/Record/health-roadmap.json"
xcrun simctl spawn "$ID" defaults write "$APP_ID" welcomed -bool YES
xcrun simctl spawn "$ID" defaults write "$APP_ID" onboarded -bool YES
# A still clock, so the test can tell when a drag no longer moves the screen.
xcrun simctl status_bar "$ID" override --time 9:41

RESULT="$DERIVED/review-shots.xcresult"
rm -rf "$RESULT"
# The test's own record of what it could not reach is in its notes; a miss never fails the run here.
TEST_RUNNER_REVIEW_SHOTS=1 xcodebuild test-without-building -project HealthRoadmap.xcodeproj \
  -scheme HealthRoadmap -destination "id=$ID" -derivedDataPath "$DERIVED" \
  -parallel-testing-enabled NO -resultBundlePath "$RESULT" \
  -only-testing:HealthRoadmapUITests/ReviewScreenshots -quiet || echo "The test reported a failure; its pictures are still exported."

rm -rf "$OUT" && mkdir -p "$OUT"
xcrun xcresulttool export attachments --path "$RESULT" --output-path "$OUT" >/dev/null
# Name each picture by its step ("01 settings.png", ...).
node -e '
const fs = require("fs"), path = require("path"), dir = process.argv[1];
for (const test of JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8")))
  for (const a of test.attachments) {
    const name = a.suggestedHumanReadableName.replace(/_\d+_[0-9A-F-]+(\.\w+)$/i, "$1");
    fs.renameSync(path.join(dir, a.exportedFileName), path.join(dir, name));
  }
fs.rmSync(path.join(dir, "manifest.json"));
' "$OUT"
ls "$OUT"
