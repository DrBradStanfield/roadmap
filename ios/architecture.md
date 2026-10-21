# iOS app — architecture and decisions

Status: **Phase 1 spike started** (2026-10-21): the shared engine runs in the app and
matches Node byte for byte (US-25 AC1, AC2). This file records what we decided for the
native iPhone app and why. It is the entry point for anyone, human or agent, working in
`ios/`.

**Keep it current (HARD).** Any change to an architectural decision below updates this file
in the same commit: the decision, the date, who made it and why. A decision reversed stays
here, struck through, with the reason it fell. The story behind the app is US-25 in
[docs/user-stories.md](../docs/user-stories.md); the web's system map is
[docs/architecture-v2.md](../docs/architecture-v2.md).

The repo is open source under the MIT license, and so is this app.

## What the app is

The Health Roadmap tool on the iPhone, built native for speed. It is the constitution's
"architectural destination" (US-25): reminders with no server, Apple Health instead of
typing, storage that a browser cannot wipe. It reads and writes the same
`health-roadmap.json` the website, the CLI and the hosted MCP use, so a user can move
between phone and web on one record.

## Decisions

### D1 · Native SwiftUI for everything the user touches (Brad, 2026-10-21)

Every screen, gesture, Apple Health call, notification, Keychain item, file write and
network call is Swift. No web view and no web UI. Brad's requirement: native, fast.

### D2 · One clinical and merge engine: health-core, run in JavaScriptCore (Brad, 2026-10-21)

The pure computation (plan, suggestions, evidence, units, validation, lab catalogue, merge,
migrate, schema) stays the TypeScript in `packages/health-core`. The app bundles it and
runs it in-process in Apple's JavaScriptCore. No WebView.

Why not a Swift rewrite:
- **The phone and the website write the same file.** Two merge implementations that differ
  in one tie-break lose rows silently between devices, the bug class US-10 spent months
  closing.
- **Advice must match.** A threshold fixed in TypeScript and missed in Swift would give a
  phone user different advice from the web. The three-file clinical sync rule would become
  four files.
- **Clinical fixes can ship over the air** (D3). Compiled Swift cannot.

Speed, measured 2026-10-21 (Node 22, esbuild bundle, an Intel iMac, the sample record
padded to 526 rows; `--jitless` stands in for an app's JavaScriptCore, which runs without a
JIT): build the plan 1.3 ms with JIT, 1.6 ms without; merge two copies 3.2 ms vs 4.6 ms.
Bundle 368 KB with merge included (the app's bundle, plan and layout only, is 335 KB). A frame is 16 ms, so the cost is invisible. Re-measure on a real iPhone in
the spike; the limit is 100 ms for plan plus merge, 300 ms for a cold engine load.

The runtime needs a bridge for what a bare JSContext lacks: `fetch`, `Response`, `Headers`,
`URL`, `AbortController` with `AbortSignal.timeout`/`any`, `Blob`, `TextEncoder`/`Decoder`,
`crypto.getRandomValues`/`randomUUID`, `setTimeout` (adapter.ts, drive-rest.ts,
dropbox-rest.ts use them). The spike picks one of two shapes: a polyfill over URLSession,
or a Swift `StorageAdapter` that keeps `SyncManager` and merge in JavaScript. The second is
preferred: less bridge, and the merge stays single. JavaScriptCore is single-threaded, so
every callback returns on one serial queue.

Bridged so far: `console` (silenced, so no health value reaches a log) and
`crypto.randomUUID` (the phone's `UUID`; health-core gives every new row one, and without
it the first saved value failed with "Can't find variable: crypto"). The bundle is 432 KB
since the My data writes joined it (`updateProfile` brings the connector's tool module).

### D3 · Clinical fixes ship over the air, signed (Brad, 2026-10-21)

The engine bundle can be updated without an App Store release. Apple's developer agreement
allows an app to download interpreted code if it does not change the app's advertised
purpose; Expo Updates and CodePush rely on the same rule. Conditions we hold ourselves to:

- **Signed.** Each bundle is signed with an offline key; the app checks the signature
  (CryptoKit) before it runs a byte. An unsigned or mismatched bundle is refused.
- **Engine only.** An update changes computation and text, never what the app can reach:
  the native bridge is fixed in the binary.
- **Safe fallback.** The app ships with a bundled engine and keeps the last good update. A
  bundle that fails its self-test on load is dropped and the previous one runs.
- **Versioned.** A bundle declares the minimum app version it needs. An app too old for a
  required fix says "update the app".
- **Disclosed.** The update check is a request to a static host and carries no health data.
  The privacy text says it exists.

This is security work: its design gets a fresh adversary and a Codex review before it is
built.

### D4 · Shared store logic moves into health-core (Brad, 2026-10-21)

Part of the sync logic is not in health-core. It lives in the web widget's
`widget-src/src/storage/roadmap-store.ts`: the erase-epoch arithmetic, the erased-rows
list (US-09 AC23), adopting another device's erase, saves that never overlap, and merging a
guest's data on cloud connect. Some clinical hint text sits in `InputPanel.tsx`. The app
needs all of it.

Proposal: move the parts with no browser in them into health-core, so both clients run the
same code and both get the over-the-air fixes. The web's speed does not change: it is the
same TypeScript in another folder. The alternative, a Swift copy, brings back the two-engine
problem D2 exists to avoid.

**Confirmed by Brad on 2026-10-21:** "the sync and erase logic should go into the shared
engine." His earlier speed objection is answered by measurement: it is the same TypeScript,
and moving it grew the web bundle (`health-plan-v2.js`) by about 2.1 KB, 1.1 KB gzipped,
on 871 KB (steps 1 to 5 of branch `claude/d4-engine-move` and their review fix); steps 6 to 8
added 1.8 KB more, 0.5 KB gzipped. The engine now holds the erase (`erase.ts`), the record
session with its save loop, re-read, erase order and erase guard (`record-session.ts`), the
re-read timing (`live-refresh.ts`, driven by `visible()`, `hidden()` and `pushed()`), the lift
on connect and the copy-down (`record-transfer.ts`), chat history (`chat-session.ts`), the
host interface the app implements (`record-host.ts`) and the storage self-test
(`storage-self-test.ts`). `engine-portability.test.ts` runs them in an empty JavaScript
context, as JavaScriptCore will. Still to move: the row-write rules (D4b). The My data
tab (`ios/engine/my-data.ts`) writes through health-core's `record-edits` directly today,
one pure edit per call; once the app keeps a session open it should run each edit through
`RecordSession.edit` with the page's erase stamp, so its writes get the save loop, the
merge on conflict and the erase guard.

### D5 · Storage: on the phone by default, Dropbox or Google Drive optional (Brad, 2026-10-21)

- **Default: a file in the app's container**, with iOS Data Protection. Built 2026-10-21
  (`MyData/RecordStore.swift`): `Application Support/health-roadmap.json`, the web's schema,
  written atomically, and only after the engine accepted the edit. Data protection is
  "until first unlock", Apple's default (the strictest class, which HealthKit uses, would
  fail when iOS pre-launches the app before the user unlocks; a read that fails still
  stays failed until the next launch). Open for Brad: keep this, or the strictest class
  with a re-read when the phone unlocks. The first record is staged beside the file and moved into
  place, which fails if a file is already there. A record the app cannot open or read,
  including JSON that fails health-core's record shape check, is kept as it is and never written over.
  Dates are always Gregorian and numbers are read by health-core's
  `parseLocalisedNumber`, whatever the phone's calendar and number format. Gotcha (2026-10-21): `URL.path()`
  percent-encodes, so the existence check on "Application Support" looked for
  "Application%20Support", missed the file, and a relaunch started an empty record over
  the user's data; the check uses `path(percentEncoded: false)`, and the store's tests run
  in a folder with a space in its name.
- **Dropbox:** OAuth with PKCE through `ASWebAuthenticationSession`, the same Dropbox app as
  the web (the `/Apps/Health Plan by Dr Brad` app folder), so the phone sees the web's file.
  The Dropbox app need not be installed. Tokens live in the Keychain, this-device-only.
- **Google Drive:** PKCE with an iOS client in the **same** Google Cloud project as the web,
  because `drive.file` only shows files the project created. No server token exchange.
- **Not the iOS Files picker.** File Provider writes have no version check, which breaks
  US-10 AC4 (two overlapping saves must keep both rows).
- **iCloud: open.** A website cannot read iCloud Drive, so an iCloud user could not use the
  web app (CloudKit JS would need its own sign-in and work). App Review has also restricted
  health data in iCloud (guideline 5.1.3). Brad is checking. Same question for iOS device
  backups of the app's file: today the backup includes it (standard iCloud Backup is not
  end-to-end encrypted unless the user turns on Advanced Data Protection), and My data
  says "Saved on this iPhone and in its backups". Excluding it (`isExcludedFromBackup`)
  keeps it off Apple's servers but loses it when the user moves to a new phone without
  cloud sync. Codex raised it 2026-10-21; Brad's call.
- **Erase (US-11)** runs as on the web, and also deletes the samples this app wrote to
  Apple Health and cancels its notifications. A phone that takes in an erase made on another
  device does the same.

### D6 · Apple Health (Brad, 2026-10-21, import deletions ignored)

**Reading.** Vitals HealthKit models (weight, height, waist, blood pressure, glucose; the
exact list matched to `types.ts` in the spike).

- Each sample becomes an appended row with `source: apple_health` and its HealthKit UUID as
  `externalId` (the field exists, roadmap-file.ts). Dedup checks ALL rows, entered-in-error
  included, so a sample is never imported twice.
- The importer only fills an empty (metric, day) slot or corrects a slot whose active row
  came from Apple Health. It never supersedes a value a person typed or corrected.
  Otherwise a scale re-sync would undo a user's correction every time.
- **A sample deleted in the Health app is ignored.** The row stays. The record is
  append-only (FHIR; Brad 2026-09-24): we never remove or retract a value.
- After taking in an erase, the importer skips samples older than the erase. The import
  anchor is kept outside the record.
- Merge orders rows by when they were written, not when they were measured. Rules such as
  "the latest reading of the day wins across devices" would need the sample time in the
  record and a merge change: merge-class work, adversary plus Codex.

**Built 2026-10-21 (engine).** The rules above are health-core code, so Swift only reads
HealthKit and hands readings over: `device-import.ts` (`importDeviceSamples`, the My data
edit `appleHealth`) and `device-export.ts` (`deviceWrites`, the door `healthWritesJson`).
Decisions made building it (agent, 2026-10-21; Brad to confirm):
- **The row's `recordedAt` carries the reading's wall-clock time**, in the web's
  local-day shape (`2026-10-21T08:30:00.000Z` is 8:30 on the phone's clock, not UTC), so
  `dayOf` gives the day the person lived and the time orders a day's readings. Within a
  day the latest reading wins: a later reading replaces an earlier Apple Health row (a
  correction), an earlier one is skipped. Without the time, the winner would depend on
  arrival order and a full re-import could swap it.
- **Height** is the profile's: Apple Health fills an empty height and never replaces one.
  It is not written back: the profile has no source, so an imported height would echo.
- **Blood glucose is not read.** It is a catalogue lab value, and lab rows have no
  `externalId` to dedup on; it waits for the Health Records work. HbA1c has no HealthKit
  quantity type.
- **Blood pressure** is written as one correlation per day, both halves present, keyed by
  the systolic chain's root; a day with an imported half is not written.

**Blood tests** mostly are not HealthKit quantity types. They arrive as Health Records
(`HKClinicalRecord`), which needs Apple's entitlement and, to our knowledge, works only in
the US, UK and Canada (verify). Records come in FHIR DSTU2 or R4: decode by version, with
fixtures for both, and refuse others visibly. Lab rows have no `externalId`, so dedup stays
on (metric, recorded_at). The LOINC-to-catalogue map is clinical-adjacent code.

**Writing.** Values typed in the app go to Apple Health. The sync identifier is the root id
of the correction chain, with a rising version, so a correction replaces our sample instead
of adding a second. Only the active row of a slot is written, and rows that came from Apple
Health are never written back.

**Background.** Observer queries recompute the plan and reschedule reminders when data
lands. HealthKit is unreadable while the phone is locked, and a background import must not
race a foreground save: both are handled, not assumed.

### D7 · Reminders: on-device notifications only (Brad, 2026-10-21)

App users get local notifications computed from `reminder-schedule.ts`, with no server and
no email. iOS holds at most 64 pending notifications, so the app schedules the next batch
and refills on launch and on new data. What a lock-screen notification says ("Colonoscopy
due") is visible to anyone holding the phone: the wording is a decision for the build.

### D8 · Chat: wanted; no user sign-in, but the app proves itself (proposed)

Brad wants chat in the app. Chat runs on Brad's server, because it calls Anthropic with a
key the phone must never hold. The user does not sign in. But "it runs on iOS" does not
secure the server: the endpoint is on the public internet, and anyone who copies its address
could spend the Anthropic budget. The web stops that with Shopify's app-proxy signature,
which the app cannot have.

Proposed: Apple's **App Attest**. The phone proves each request comes from a genuine copy of
this app on a real Apple device, with no account. Add a per-device rate limit on the server.
Before the first message, a consent screen names Anthropic and what is sent (App Review
5.1.2(i), November 2025). This is security design: written up, then adversary plus Codex,
before code. Lab upload follows the same path, later.

### D9 · No server telemetry (Brad, 2026-10-21)

The app sends no product events to Brad's server. The usage signal is App Store Connect
analytics (installs, sessions, retention, crashes, from users who opt in). Stated limit: it
cannot see "viewed a plan". Health values never enter any telemetry.

The plan screen says "No health data left your device". That is true only while the app
has no network code. The first network call (D3's update check, D5's sync, D8's chat)
must re-derive that sentence in the same commit.

### D10 · Old app versions stay safe

Any change to merge behaviour bumps the schema version, so an older app refuses the file
(`SchemaTooNewError`) and asks for an update instead of merging the old way. Over-the-air
engine updates (D3) close most of this gap; the bump covers what they cannot reach.

## Build and test

**Layout.**
- `engine/entry.ts`: the one door Swift calls, JSON in and out: `planJson`,
  `sectionsJson`, and for My data `newRecordJson`, `myDataJson`, `applyEditJson`,
  `numberJson`. Every door reads the record through health-core's `ROADMAP_DOC.migrate`
  (shape check, then migration), as the web, CLI and connector do.
- `engine/my-data.ts`: what the My data tab shows and every write it makes, each one
  health-core's own (`createEmptyFile`, `updateProfile`, `stampProfile`,
  `appendMeasurement`, `correctValue`, `upsertMedication`, `upsertSupplement`), with
  values in the user's units (US-25 AC7). Not yet through `RecordSession.edit` (D4). Tested in Node by
  `engine/my-data.test.ts`, which the web's `test:all` runs.
- `scripts/build-engine.mjs`: bundles health-core with esbuild (target Safari 17, iOS 17's
  JavaScriptCore) into `HealthRoadmap/Engine/health-engine.js`, and writes the parity
  goldens. Run it before any Xcode build: `node ios/scripts/build-engine.mjs`. Its outputs
  are generated and ignored by git.
- `scripts/test.sh`: builds the engine and runs the tests once in UTC and once in
  Pacific/Auckland. Gotcha (2026-10-21): JavaScriptCore reads the time zone once per
  process, so `setenv("TZ")` inside a test does not reach the engine; the first
  parity test passed in Auckland and failed in UTC for that reason. The zone is set at
  launch with `TEST_RUNNER_TZ`, and a zone with no golden skips (a Tokyo run proved
  the pin reaches the test).
- `HealthRoadmap.xcodeproj`: hand-written, using Xcode's synchronized folders, so a file
  added to `HealthRoadmap/` or `HealthRoadmapTests/` joins its target with no project edit.
  No project generator, so no new dependency.
- `HealthRoadmap/`: the SwiftUI app, one folder per feature:
  - `App/`: the entry point (`AppParts` makes the engine and the record once) and
    `RootView`, the two tabs: My data first, then My plan, the web's mobile order.
  - `Engine/`: `HealthEngine.swift` loads the bundle into a `JSContext`; the generated
    bundle sits beside it.
  - `MyData/`: the record and its tab. `RecordStore` keeps the file and applies edits
    through the engine; `MyData.swift` is the engine's view of the record and the
    `RecordEdit` the tab sends; `MyDataView`, `ValueEntrySheet` and `DayText` draw it.
  - `Plan/`: the plan screen, planned from the stored record whenever it changes.
    `Plan.swift` is the slice of the engine's JSON the app reads, evidence included. The layout (sections, card order, grouped cards) is not
    Swift: it is health-core's `planSections` (packages/health-core/src/plan-sections.ts),
    which the web's results panel calls too. `PlanView.swift` and `PlanCardView.swift`
    draw it.
- `engine/fixtures.mjs`: the parity records (the sample, an urgent value reached by a
  correction, a minor, an excluded value, no height). `engine/golden.ts` runs the engine
  from source on each to make the goldens.
- `HealthRoadmapTests/`: XCTest. `EngineParityTests` is US-25 AC1 (every fixture, plan and
  layout, byte for byte); `PlanLayoutTests` pins the sample's web layout and checks that
  no card loses its evidence or ingredients; `RecordEditTests` runs the My data writes in
  JavaScriptCore; `RecordStoreTests` covers the file (AC4) and the plan following it
  (AC6); `DayTextTests` pins the local day.

**Code for AI agents to read (HARD, Brad 2026-10-21).** This app is written and maintained
by AI agents, so the code is shaped for a reader with no memory of how it got here:
- **One feature per folder, one main type per file**, named for what it holds. A file
  over ~200 lines is split.
- **Every type opens with a doc comment** saying what it is for and, when it serves a
  story, the US-id. Comments say why, not what.
- **Point at the web's twin.** Where Swift mirrors web behaviour (grouping, labels,
  order), the comment names the web file, and a test pins the match.
- **No clever code.** Plain SwiftUI and Foundation, no third-party packages without a
  decision recorded here, no custom operators, no deep generics, no global state. Logic
  that can be a pure function is one, so a test can call it.
- **Clinical logic never lives in Swift.** If a screen needs a clinical rule, the engine
  provides it; Swift only renders.
- **This file is the map.** A new folder or a moved responsibility updates the layout
  above in the same commit.

**Bundle ID:** `com.drbrad.healthroadmap` is a placeholder until the Apple Developer
account exists; it is permanent once the app is on the App Store. Enrolment: DR BRAD, INC.
under brad@drstanfield.com, Enrollment ID 726UVSY5YZ, waiting on Apple's check of signing
authority (2026-10-21). The 2015 team (Caddy Limited, b.d.stanfield@gmail.com) expired in
2020 and is not used.

**Measured 2026-10-21 in macOS JavaScriptCore** (the same engine iOS ships): the bundle
gives Node's plan byte for byte in UTC and Pacific/Auckland, at a pinned instant that
falls on different calendar days in the two zones. First plan 10 ms (parse and warm-up),
then about 1 ms each.

- **Tools:** Xcode 26 (required for App Store uploads since 28 April 2026), the iOS
  Simulator, and a real iPhone. Claude Code builds with `xcodebuild`, drives simulators with
  `simctl`, and runs XCTest and XCUITest. Signing, App Store Connect, background HealthKit
  delivery and real performance need the phone and Brad's account.
- **Conformance tests:** `build-engine.mjs` runs each fixture through the engine's source
  (tsx) and through the bundle (Node), and fails if they differ; the app's JavaScriptCore
  must then match the source's goldens byte for byte, with `now` and the time zone pinned.
  Known gap: an Xcode build does not rebuild the bundle, so a build from Xcode after a
  health-core change runs the old engine until `build-engine.mjs` or `test.sh` runs.
- **Stories first:** each feature gets a US-id with acceptance criteria before code (Lane
  B). Tests cite the id.
- **CI:** a macOS runner job. Workflow files are Brad-only.
- **Minimum iOS:** 17 (proposed).

## Phases

0. **Readiness (Brad, in progress 2026-10-21):** macOS upgrade, Xcode 26, Apple Developer
   Program as the company (D-U-N-S), a test iPhone.
1. **Spike, go/no-go:** engine in JavaScriptCore on the phone; Dropbox and Drive sync
   against the scratch record; Apple Health read and write; the over-the-air update path.
2. **TestFlight:** entry, plan, corrections, units, sync, erase, notifications, Apple
   Health, then chat behind App Attest.
3. **Health Records labs and camera lab upload.**
4. **App Store submission.**

## Open questions and risks

- **Regulatory: we don't know.** Personalised medication and screening suggestions may count
  as software as a medical device in some markets (FDA, MHRA, EU MDR, NZ). Get advice before
  submission. App Review 1.4.1 asks medical apps to disclose their method.
- **D4** confirmed by Brad 2026-10-21; the move is under way (see D4). **iCloud** (D5) awaits the guideline check.
- **Hardware:** the build Mac is Intel. macOS 26 is the last Intel release, so a later
  required Xcode may need Apple silicon.
- **Two release paths:** binary changes still go through App Review; plan for it.
