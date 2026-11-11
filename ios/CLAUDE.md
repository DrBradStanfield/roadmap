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
  simctl device commands; `{udid}` in the command is the device). It holds a kernel lock (lockf) for
  the run: a second caller waits, naming the holder (30 min, `HR_SIM_WAIT_MIN`). It adds the device and
  `-parallel-testing-enabled NO`, stops a run after 30 minutes, keeps the device booted, and shuts it
  down after 20 idle minutes. Check your work and let the command finish; never hold it while coding.
- `--reset-app` uninstalls the app and clears its simulator settings, so no data leaks between sessions.
- Demos and the iOS Simulator MCP tool (outside the guard) use the demo device, "HR Demo iPhone", never
  the shared one: `ALLOW_EXTRA_SIMULATOR=other-device ios/scripts/fresh-sim.sh` makes, boots and fills it.
  Or wrap all the steps in one script run through sim-run. Shut the demo device down when done.
- A wait can last 30 minutes, longer than the Bash tool's 10-minute limit, which would kill it.
  Run a sim-run command that may wait in the background (`run_in_background`); it also waits while the load is 8+ or two Codex reviews run.
- `ios/scripts/sim-run.sh status`: both devices, the holder, leftover simulator processes, and the
  cleanup commands for Brad to run (never kill simulator processes yourself). Its tests need macOS
  (lockf), so CI skips them: run `npx vitest run ios/scripts/sim-run.test.ts` after changing it.
- Any other `xcodebuild` (archive, plain build): `pgrep -fl xcodebuild` first; if one runs, report
  back. Time-limit it: `perl -e 'alarm shift; exec @ARGV' 1200 xcodebuild ...`. A long-open Xcode app
  is the likely cause of hung builds; quit it.
- The guard `.claude/hooks/simulator-guard.cjs` denies simulator use outside sim-run.sh, an
  `xcodebuild test` without `-parallel-testing-enabled NO`, and `simctl create|clone` once two are
  booted. It is a seat belt, not a wall: it reads one command line, not scripts or every shell trick.
  Only for a demo device, prefix `ALLOW_EXTRA_SIMULATOR=other-device`; its messages never offer this.
- Scripts: `test.sh` (engine, then unit tests in two time zones) and `ui-test.sh` (UI tests, each on a
  fresh install) run through sim-run.sh and `clean-test-clones.sh` on exit; `fresh-sim.sh` (a true new
  install, onboarding from the start) runs on the demo device.

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
