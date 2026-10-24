#!/bin/sh
# Deletes the simulator clones Xcode makes for parallel testing (~/Library/Developer/XCTestDevices).
# Xcode never removes them: 116 clones had filled the disk by 2026-10-24. Only shut-down clones go,
# so a test run in another session keeps the booted clones it is using. The test scripts run this on exit.
#   ios/scripts/clean-test-clones.sh
xcrun simctl --set testing list devices 2>/dev/null |
  sed -n -E 's/.*\(([0-9A-F-]{36})\) \(Shutdown\).*/\1/p' |
  while read -r ID; do xcrun simctl --set testing delete "$ID" 2>/dev/null || true; done
