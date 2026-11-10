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

- Before any `xcodebuild`, run `pgrep -fl xcodebuild`. If another is running, report back; do not wait.
- Run it under a time limit: `perl -e 'alarm shift; exec @ARGV' 1200 xcodebuild ...`. A hung run blocks
  every other session's builds: stop it and report. If builds keep hanging, a long-open Xcode app is
  the likely cause; quit it.
- A direct `xcodebuild test` call always carries `-parallel-testing-enabled NO` (the guard below denies
  one without it). Parallel testing clones simulators that fill the disk and the process table.
  `ios/scripts/test.sh` passes no such flag; it deletes its shut-down clones on exit.
- One simulator per session. Shut it down when done (`xcrun simctl shutdown <udid>`).
- Check the Mac's load first: `uptime` and `xcrun simctl list devices booted`.
- The guard `.claude/hooks/simulator-guard.cjs` denies `xcodebuild test` without
  `-parallel-testing-enabled NO`, and denies `simctl boot|create|clone` once two simulators are booted
  (`ALLOW_EXTRA_SIMULATOR=1` for a demo). It cannot see commands inside `ios/scripts/*.sh`;
  `test.sh`, `ui-test.sh` and `app-store-shots.sh` run `ios/scripts/clean-test-clones.sh` on exit.
- Scripts: `test.sh` (engine, then unit tests in two time zones), `ui-test.sh` (UI tests, each on a
  fresh install), `fresh-sim.sh [device]` (a true new install, so onboarding runs from the start).

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
