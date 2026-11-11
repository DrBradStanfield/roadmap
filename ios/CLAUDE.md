# ios/CLAUDE.md

Rules for agents working under `ios/`. **Budget: ≤100 lines, one-in-one-out.** A new rule replaces or
tightens an old one; detail goes to [architecture.md](architecture.md) or [docs/gotchas.md](../docs/gotchas.md).

The root [CLAUDE.md](../CLAUDE.md) applies in full (worktrees, reviews, delegation, stories, security).
This file adds only what is specific to the iPhone app.

## Where things are decided

- Every decision and its why: [architecture.md](architecture.md). Read the section you touch; keep it current.
- Release and store steps: [launch-checklist.md](launch-checklist.md), [app-store.md](app-store.md).
- Over-the-air engine updates: [engine-updates.md](engine-updates.md).

## Both clients, one engine

- Every UI change lands on both clients, the iPhone app and the web widget, in the same task (Brad 2026-11-02). Name the
  iOS twin (`ios/HealthRoadmap/...`) and the web twin (`widget-src/src/components/...`). Ship both, or
  say which side waits and why. When Brad's request names one app's layout, ask before mirroring it.
- Shared logic lives once, in health-core, which the app runs as the bundled engine. Never re-implement
  it in Swift.

## Build

- Build the engine first: `node ios/scripts/build-engine.mjs`. Its outputs (the engine bundle, its
  `health-engine.json` sidecar, `HealthRoadmapTests/Fixtures/`) are generated and gitignored.
- Silent trap: an Xcode build does not rebuild the engine. After a health-core change, a build from
  Xcode runs the old engine until `build-engine.mjs` or `ios/scripts/test.sh` runs.
- Keep DerivedData outside `~/Documents` (`-derivedDataPath <scratch>/dd`): the repo sits in an
  iCloud-synced folder, Finder adds xattrs to build products, and codesign refuses them.
- Never name a source file `*backup*`: `.gitignore` hides it on this case-blind Mac, and Xcode still
  builds it, so a fresh clone breaks. Check an unlisted new file with `git check-ignore -v <path>`.

## xcodebuild and simulators (shared by every session on this Mac)

- One simulator for every session (US-71 AC7): "HR Shared iPhone", reached only through
  `ios/scripts/sim-run.sh -- <command>` (xcodebuild test, build-for-testing, test-without-building;
  simctl install, launch, io screenshot; `{udid}` in the command is the device). It holds a lease: a
  second caller waits, naming the holder (30 min, `HR_SIM_WAIT_MIN`). It adds the device,
  `-parallel-testing-enabled NO` and a time limit, keeps the device booted, and shuts it down after
  20 idle minutes. Check your work, then release by finishing the command; never hold it while coding.
- `--reset-app` uninstalls the app first, so one session's data cannot leak into the next.
- The iOS Simulator MCP tool is outside the guard. A session using it takes the lease first with
  `ios/scripts/sim-run.sh hold` (it prints the UDID) and gives it back with `sim-run.sh release`.
- A lease wait can last 30 minutes, longer than the Bash tool's 10-minute limit, which would kill it.
  Run a sim-run command that may wait in the background (`run_in_background`).
- `ios/scripts/sim-run.sh status`: the device, the lease holder, leftover simulator processes, and
  the cleanup command for Brad to run (never kill simulator processes yourself).
- Any other `xcodebuild` (archive, plain build): `pgrep -fl xcodebuild` first; if one runs, report
  back. Time-limit it: `perl -e 'alarm shift; exec @ARGV' 1200 xcodebuild ...`. A long-open Xcode app
  is the likely cause of hung builds; quit it.
- The guard `.claude/hooks/simulator-guard.cjs` denies simulator use outside sim-run.sh, an
  `xcodebuild test` without `-parallel-testing-enabled NO`, and `simctl create|clone` once two are
  booted (`ALLOW_EXTRA_SIMULATOR=1` for a demo on another simulator). It cannot see inside scripts.
- Scripts (all through sim-run.sh): `test.sh` (engine, then unit tests in two time zones),
  `ui-test.sh` (UI tests, each on a fresh install), `fresh-sim.sh` (a true new install, onboarding
  from the start; it frees the lease and leaves the device booted for the demo). Test scripts run `clean-test-clones.sh` on exit.

## Devices and data

- No test data on a real device (Brad 2026-11-02). Demos, seeded records and UI-testing launches run in the simulator.
  Installing a build on a phone is fine; TestFlight is preferred.
- iPhone Mirroring can send a phantom mouse press before a tap. A tap-timing bug seen only through
  Mirroring is not proof of a user bug; a finger tap on the phone is (docs/gotchas.md, 2026-11-10).
- The simulator lies about some things: launch time (time it on a real iPhone, Release, cold) and
  background HealthKit delivery (the simulator never wakes the app). Some failures show only on a
  reinstall over an old install (the Keychain survives deleting the app).

## Release

- Submit a ready build to TestFlight and App Review together, in one go; no phone test first (Brad 2026-11-09).
- An agent shell cannot upload (no App Store Connect token): it archives with `xcodebuild archive`, then the
  session uploads from Xcode Organizer. Full steps: [launch-checklist.md](launch-checklist.md).

## Gotchas

Silent ones to know before you start (full entries in [docs/gotchas.md](../docs/gotchas.md)):
- 2026-11-02: `HKCorrelationType` is not supported for background delivery; observe the quantity types.
- 2026-10-23: `simctl spawn ... defaults write` survives an uninstall; `fresh-sim.sh` deletes it too.
- 2026-11-09: a stale App Attest key in the Keychain broke uploads and chat after a reinstall.

Search docs/gotchas.md for "iOS", "iPhone", "simulator" and "xcodebuild" for the rest.
