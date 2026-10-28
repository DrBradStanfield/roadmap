#!/bin/sh
# Records the App Store videos' footage and builds both drafts (ios/app-store.md):
#   1. an app preview, 886 × 1920, with a silent stereo track: 29 s with the Chat clip, 25 s without;
#   2. the product-page header video, 3840 × 1646, plus its still and a 3:2 search still.
# Like app-store-shots.sh: installs the app fresh on its own simulator ("Video iPhone 18 Pro",
# made if missing), seeds the fictional sample record, skips welcome and onboarding, sets the
# 9:41 status bar. Then it adds a fictional lab report to Photos, starts the local lab reader
# (app-store-video-lab-server.mts: the real extraction, the simulator's dev header, US-52 AC3),
# records the screen while the AppStoreVideo UI test runs, and cuts the recording at the
# test's VIDEO-MARK lines.
#   ios/scripts/app-store-video.sh                 record, then build both videos
#   ios/scripts/app-store-video.sh --record-only   record only
#   ios/scripts/app-store-video.sh --compose-only  rebuild from the last recording
# Chat: the simulator cannot answer, so its beat is a screen recording from an iPhone on the
# same record, light mode: ios/build/app-store-assets/device/chat-iphone.mov (or video/chat.mov
# or .mp4). When one is there the preview ends on it under "Ask about your results": the tap on
# a starter question, then, the wait for the answer cut, the answer arriving. Without one the
# preview ends on the plan's evidence. Run --compose-only after dropping a new clip.
set -eu
cd "$(dirname "$0")/.."
OUT=build/app-store-assets/video
WORK=$OUT/work
mkdir -p "$WORK"
SCRATCH="${TMPDIR:-/tmp}/app-store-video"
mkdir -p "$SCRATCH"
if [ "${1:-}" != "--compose-only" ]; then
  DEVICE="Video iPhone 18 Pro"
  APP_ID=com.drstanfield.healthroadmap
  DERIVED="${TMPDIR:-/tmp}/HealthRoadmap-video-$(pwd | shasum | cut -c1-8)"
  ID=$(xcrun simctl list devices available | grep -F "    $DEVICE (" | head -1 | sed -E 's/.*\(([0-9A-F-]{36})\).*/\1/')
  [ -n "$ID" ] || ID=$(xcrun simctl create "$DEVICE" com.apple.CoreSimulator.SimDeviceType.iPhone-18-Pro)

  node scripts/build-engine.mjs >/dev/null
  xcodebuild build-for-testing -project HealthRoadmap.xcodeproj -scheme HealthRoadmap \
    -destination "id=$ID" -derivedDataPath "$DERIVED" -quiet
  xcrun simctl boot "$ID" 2>/dev/null || true
  xcrun simctl bootstatus "$ID" -b >/dev/null
  xcrun simctl uninstall "$ID" "$APP_ID" 2>/dev/null || true
  xcrun simctl install "$ID" "$DERIVED/Build/Products/Debug-iphonesimulator/HealthRoadmap.app"

  xcrun simctl launch "$ID" "$APP_ID" --ui-testing >/dev/null
  DATA=$(xcrun simctl get_app_container "$ID" "$APP_ID" data)
  for _ in 1 2 3 4 5 6 7 8 9 10; do [ -d "$DATA/Library/Application Support/Record" ] && break; sleep 1; done
  xcrun simctl terminate "$ID" "$APP_ID"
  # The sample record plus five earlier weights and the waist, as app-store-shots.sh seeds it;
  # the fictional report then adds that script's other blood tests, so the record ends where
  # the screenshots and the Chat clip are.
  node -e '
const fs = require("fs");
const record = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const weights = [["2026-03-02", 73.4], ["2026-04-06", 72.1], ["2026-05-12", 71.0], ["2026-06-15", 70.2], ["2026-07-20", 69.3]];
for (const [day, value] of weights) record.measurements.push({ source: "manual", status: "active", correctsId: null, externalId: null,
  id: `sample-weight-${day}`, metricType: "weight", value, recordedAt: day, createdAt: `${day}T08:00:00Z` });
record.measurements.push({ source: "manual", status: "active", correctsId: null, externalId: null,
  id: "sample-waist-2026-08-18", metricType: "waist", value: 79, recordedAt: "2026-08-18", createdAt: "2026-08-18T08:00:00Z" });
fs.writeFileSync(process.argv[2], JSON.stringify(record));
' ../docs/examples/health-roadmap.sample.json "$DATA/Library/Application Support/Record/health-roadmap.json"
  xcrun simctl spawn "$ID" defaults write "$APP_ID" welcomed -bool YES
  xcrun simctl spawn "$ID" defaults write "$APP_ID" onboarded -bool YES
  xcrun simctl status_bar "$ID" override --time 9:41 --dataNetwork wifi --wifiBars 3 --cellularMode active --cellularBars 4 --batteryState discharging --batteryLevel 100

  swift scripts/app-store-video-report.swift "$WORK/report.png" >/dev/null
  xcrun simctl addmedia "$ID" "$WORK/report.png"

  (cd .. && exec npx tsx ios/scripts/app-store-video-lab-server.mts) > "$SCRATCH/lab-server.log" 2>&1 &
  SERVER=$!
  RECORDER=
  trap 'kill $SERVER 2>/dev/null || true; [ -n "$RECORDER" ] && kill -INT $RECORDER 2>/dev/null || true
        xcrun simctl status_bar "$ID" clear; xcrun simctl spawn "$ID" defaults delete "$APP_ID" 2>/dev/null || true
        scripts/clean-test-clones.sh' EXIT
  for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do grep -q "lab server on" "$SCRATCH/lab-server.log" && break; sleep 1; done
  grep -q "lab server on" "$SCRATCH/lab-server.log" || { echo "The local lab reader did not start:"; cat "$SCRATCH/lab-server.log"; exit 1; }

  rm -f "$WORK/raw.mp4"
  xcrun simctl io "$ID" recordVideo --codec=h264 --force "$WORK/raw.mp4" 2> "$SCRATCH/record.log" &
  RECORDER=$!
  for _ in $(seq 1 50); do grep -q "Recording started" "$SCRATCH/record.log" && break; sleep 0.2; done
  echo "VIDEO-MARK recording $(node -e 'console.log(Date.now() / 1000)')" > "$WORK/marks.txt"

  RESULT="$DERIVED/app-store-video.xcresult"
  rm -rf "$RESULT"
  TEST_RUNNER_APP_STORE_VIDEO=1 xcodebuild test-without-building -project HealthRoadmap.xcodeproj \
    -scheme HealthRoadmap -destination "id=$ID" -derivedDataPath "$DERIVED" \
    -parallel-testing-enabled NO -collect-test-diagnostics never -resultBundlePath "$RESULT" \
    -only-testing:HealthRoadmapUITests/AppStoreVideo > "$SCRATCH/test.log" 2>&1 && PASSED=1 || PASSED=0
  grep -o "VIDEO-MARK [a-z]* [0-9.]*" "$SCRATCH/test.log" | sort -u -k3 -n >> "$WORK/marks.txt"
  kill -INT $RECORDER; wait $RECORDER 2>/dev/null || true
  RECORDER=
  [ $PASSED = 1 ] || { grep -E "error|failed" "$SCRATCH/test.log" | tail -20; exit 1; }
  grep '"evt"' "$SCRATCH/lab-server.log" || true
fi
[ "${1:-}" = "--record-only" ] && exit 0

swiftc -O scripts/app-store-video-compose.swift -o "$SCRATCH/compose"
CHAT=
for c in build/app-store-assets/device/chat-iphone.mov "$OUT/chat.mov" "$OUT/chat.mp4"; do [ -f "$c" ] && CHAT=$c; done
"$SCRATCH/compose" preview "$WORK/raw.mp4" "$WORK/marks.txt" "$OUT/app-preview-886x1920.mp4" ${CHAT:+"$CHAT"}
[ -n "$CHAT" ] && "$SCRATCH/compose" preview "$WORK/raw.mp4" "$WORK/marks.txt" "$OUT/app-preview-no-chat-886x1920.mp4"
"$SCRATCH/compose" header "$WORK/raw.mp4" "$WORK/marks.txt" "$OUT"
ls -l "$OUT"
