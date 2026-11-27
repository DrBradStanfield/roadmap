# Sourced, not run: does a PR need the ios-compile check? (US-64 AC43; on 2026-11-27 a PR changing a Swift test
# merged while that check still ran.) `printf '%s\n' "$paths" | ios_compile_paths` reads the PR's paths, one a line,
# and exits 0 when one feeds the iOS compile job's build (.github/workflows/ios-compile.yml, xcodebuild
# build-for-testing): any Swift file under ios/, the Xcode project, the three synchronized folders it builds (app,
# unit tests, UI tests), the app's Info.plist and entitlements. It exits 1 when none does, so the check stays
# advisory; any other exit is an error. Case is ignored: macOS disks fold case, so IOS/x.swift builds as
# ios/x.swift. The one rule, shared by tools/merge-gated.sh and tools/wait-run.sh. The job builds no engine
# bundle, so nothing outside ios/ feeds it.
ios_compile_paths() {
  grep -Eiq '^ios/(.*\.swift|HealthRoadmap(Tests|UITests)?/.*|HealthRoadmap\.xcodeproj/.*|HealthRoadmap-Info\.plist|HealthRoadmap\.entitlements)$'
}
