# iOS app — architecture and decisions

Status: **feature complete in the simulator, waiting on Brad's accounts** (2026-10-21,
overnight). Built and on main: My data with medications, screenings, supplements and
history (US-25 AC5-AC9); the plan (AC1, AC2, AC6); welcome, rating prompt, icon (AC10);
Dropbox sync on the shared sync engine (AC11; Google Drive waits on its iOS client id);
reminders (AC12); Apple Health (AC13-AC15); erase and export (AC16); chat and lab upload
behind App Attest (US-52, server routes off until deployed with a team id); over-the-air
engine updates, signed (D3, AC18, 2026-10-22). What Brad must do before TestFlight:
[launch-checklist.md](launch-checklist.md). This file records what we decided for the
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

**The VO2 max fitness bands stay in the engine too (US-56 AC8, Brad 2026-10-26).** The table is
health-core's `vo2max-bands.ts` (FRIEND 2022 percentiles), recorded in `health_roadmap_algorithm.md`
with its reference in `evidence.ts` and `roadmap_text.html`. The engine serves the person's row on
My data (`vo2Bands`, from the profile's sex and `calculateAge`), as it serves the guides; Swift only
applies the three cut-points to a value (`AppleHealthMetrics/Vo2MaxBands.swift`). No VO2 max enters
the engine (US-56 AC1), and a fix ships over the air. An older engine sends none, and the app
shows no bands. **The row's meaning is in the bridge contract (2026-10-27, adversary R1, Codex
R1):** from 60 its `p20`, the Low line, is Apple's Low Cardio Fitness alert line and can exceed
`p50` (men 80 to 89), which an app built before it cannot draw. `screenJson`'s returns in
`bridge-contract.json` name the row and that meaning, so the bridge id moved to
`2d467ff50c66c42d` (D3) and an older app refuses any engine that serves it; `bridge.test.ts`
fails if the contract stops naming it.

**The engine without sex moves the bridge (2026-11-01, US-07 AC8, Codex R1 on PR 402).** The
engine's chat context gained a key, `labEgfrOutdated`: true when a creatinine newer than the
lab eGFR exists but cannot be used yet (no sex or no birth year), so the server's chat plan
withholds potassium advice as the engine's own plan does. The app forwards only the keys in
`ChatClient.contextKeys`. A binary built before the key would take the new engine over the air
and strip it, and its chat would give the advice the plan withheld. So `chatContextJson`'s
returns in `bridge-contract.json` name the key and the rule (an app whose allow-list lacks a
key the engine produces must not run it), the bridge id moved from `d0ffd9e53f8499b3` to
`dc156e7c19dc8573`, and `EngineRelease.bridge` and the allow-list moved with it. Older binaries
keep their bridge's engines and never read the new one's releases; the change needs an App
Store build. `ios/engine/chat-context-keys.test.ts` holds the previous binary's bridge and
allow-list, and fails if the engine produces a key that list lacks while the bridge id is
unchanged.
**Bridge moved again, 2026-11-01 (Brad: "We don't have any downloads yet, and we're still in
beta, so it's fine").** Main had kept `2d467ff50c66c42d` so US-61's engine (its optional
`isUS` and `usProducts`) could reach builds 3 and 4 over the air; merged with the change
above, the contract hashes to `8dee92d80c028ed3`, which `EngineRelease.bridge` and
`bridge.test.ts` now carry. Builds 3 and 4 stop receiving over-the-air engines: the US-61
engine and this one reach them only through the next App Store build.
**Bridge moved, 2026-11-02 (US-67, the chat's edits).** The new `chatEditsJson` door is one
an older app cannot serve. Merged with US-12 AC20's move below, the contract hashes to
`8ced272282162ff2`; `EngineRelease.bridge` and `bridge.test.ts` carry it. The chat's writes are new `Edit` kinds (`chatEdits`, `chatUndo`)
inside the existing `applyEditJson` and `cloudEdit`, so they need no door of their own.

**Bridge moved again, 2026-11-02 (US-12 AC20, D15).** `chatContextJson` now sends `limits`
(a lab result printed as a limit) and `ChatClient.contextKeys` takes it, so the contract
hashes to `49b2af86805825f0`. Build 5 (`8dee92d80c028ed3`) stops receiving over-the-air
engines from this release on. Had it kept them, its allow-list would drop `limits`; the
engine no longer sends a limit field's representative, so it would lose that value rather
than misreport it.

**Bridge moved a third time, 2026-11-02 (US-72, D10).** The contract now names the `healthRecords` edit, so
it hashes to `f4ba71cf3e7425f9`. A new app never runs an older over-the-air engine that lacks
the edit; earlier builds keep their own bridge and get the edit only through the App Store.

**Bridge moved, 2026-11-03 (merge of US-67 and US-72).** Main's `chatEditsJson` door
(`8ced272282162ff2`) and this branch's `healthRecords` edit (`f4ba71cf3e7425f9`) meet in
one contract, which hashes to `40fc97db4ca12547` with the story numbered US-72 in its text;
`EngineRelease.bridge` and `bridge.test.ts` carry it. The earlier ids `9bf2188d4f963385` and
`ad98aa80d4353126` never shipped.

Speed, measured 2026-10-21 (Node 22, esbuild bundle, an Intel iMac, the sample record
padded to 526 rows; `--jitless` stands in for an app's JavaScriptCore, which runs without a
JIT): build the plan 1.3 ms with JIT, 1.6 ms without; merge two copies 3.2 ms vs 4.6 ms.
Bundle 368 KB with merge included (the app's bundle, plan and layout only, is 335 KB). A frame is 16 ms, so the cost is invisible. Re-measure on a real iPhone in
the spike; the limit is 100 ms for plan plus merge, 300 ms for a cold engine load.

**Measured on an iPhone 15 Pro Max, 2026-10-22** (`HealthRoadmapTests/EngineSpeedTests`,
opt-in; daily weight and blood pressure plus quarterly labs). Cold load 25 ms. One year
(1,100 rows): each call 9 to 31 ms (merge the most). Three years (3,300 rows): 22 to 74
ms. Ten years (11,000 rows): 77 to 130 ms, merge 330 ms. Every call is linear in the
record's size, and each parses the whole record again. The first run found My data's
blood pressure history quadratic, 17 s at ten years; fixed (one pass, same output). A year
of daily readings already costs a frame or more per call on the main thread. Brad wants
engine work off the main thread (2026-10-22); stages 1 and 2 are built (below).

**A cold launch on an iPhone 15 Pro Max, 2026-10-26** (Release, Brad's 103 KB record, a cloud
connected; five true cold launches, the app killed and no process left before each, each with a new
pid and process start; temporary marks, removed). In ms from process start: app init 55 to 95;
launch view on screen 80 to 111; the JSContext made in 2 ms, the 759 KB bundle evaluated in 27 to 34
ms and the record drawn (`screenJson`) in 12 to 14 ms, all on the engine's queue; the parts handed to
the UI at 149 to 182; **My data on screen at 184 to 226**; then the first render holds the main
thread 105 to 121 ms, the only stall over 50 ms. Clarity's start takes about 1 ms and the update
check, not due, 3 ms, both after the first frame. The cloud record opens 1.4 to 2.2 s after start and
My data redraws once more. No downloaded engine was staged, so no self-test ran. The engine is
not what a person waits for; what showed was the launch view's logo, about 100 ms between the system
launch screen and My data, now a plain background (below, Launch). The simulator is no guide to
launch time: there, pre-main alone is 1.4 to 3 s (docs/reference.md gotcha).

**The parsed-record slot (2026-10-22, stage 1 of moving engine work off the main thread).** Every engine call took the record as text and parsed and migrated it; migration is most of a call's time (Node, ten years of rows: parse about 3 ms, migrate about 18 ms). `readRecord` (ios/engine/my-data.ts) now keeps one slot: the last text read, its device id and its parsed record, served again only for the identical text and device id. Metadata recovery uses a valid companion clock, or the latest valid stored row clock (epoch if none), never `now`; the slot no longer duplicates a metadata-shape predicate from migration. Only reads are kept, never a door's own output: a written record need not equal what its text reads back as, since migration clamps counters (Codex R1). The rule this binds every door, and every health-core function a door reaches, to: **a record from `readRecord` is read-only.** A function that writes in place gets a copy first (the phone document save copies before `saveDocuments`' commit). Under the tests the kept record is deep-frozen, so every engine test checks the rule on every branch it runs; never in the app. No bridge change.

**The engine off the main thread (2026-10-22, stage 2; US-25 AC21).** Brad: "we want the main/UI thread to only be for UI elements."
- `HealthEngine` is an actor whose executor is its own serial queue (`DispatchSerialQueue`, user-initiated). The JSContext is made on that queue and touched only there; DEBUG checks it in `callValue` and `settle`. Timers, URLSession answers and token answers land on that queue. Tokens come from the main actor and hop back with `queue.async`. The phone's file and the pending marker are plain files (`PhoneFiles`) read and written there. A phone edit made while a cloud is connected but not open sets the marker in the same engine step that writes it, before the write, so an app killed between the two never leaves an unmarked edit (a refused write puts back the generation it found, so a session holding it can still clear it), decided when its turn comes (an edit asked for before a first connect and landing after it is marked too).
- **The invariant: the engine's queue never waits on the main thread.** News goes to main with `DispatchQueue.main.async`, in order, never waited for. Nothing in the natives uses `main.sync` or `assumeIsolated` (EngineThreadTests greps for both). A cloud erase writes the chat tombstones on the engine queue, with a lock-guarded erase counter.
- **One ordered pipeline, and every record-level decision is a step in it.** Every record change in `RecordStore` (apply, applyNow, importLabs, saveDocument, showCloud, showPhone, switchUnits, the cloud erase's record) runs after the one before it (`chain`), so two quick edits land in order. On the phone, one engine call does the edit, My data and the atomic write; main then publishes the record, My data and the unit choices together (Codex R1). Three decisions are steps too:
  - **The cloud handover** (`handOver`): after an open resolves, one step decides whether to show it. Every edit asked for before that step has landed on the phone's file and been counted; if any came in, the app opens again, and that reopen merges the phone's file in whatever its marker says (`cloudOpen`'s `mergePhone`). An edit asked for after the step lands after the cloud record is shown. A record or a failure the opening session sends meanwhile is held and shown with it, not dropped, and the status is set in the same turn the session is shown: news after that turn is never overwritten by the open finishing.
  - **The phone erase** (`erasePhone`): the record is read, erased by the engine, the chat tombstones kept and the erase written, in one step, so an import accepted meanwhile lands after the erase, never under it. It is marked and counted like any phone edit, so a first connect that lifted the pre-erase file opens again and merges the erase in, whose higher eraseEpoch wins (US-09 AC23).
  - **The master units switch** holds entry while it lands, as a per-test switch does (`unitSwitches`).
- **The marker's generation (engine, cloud.ts).** The pending marker is a number that rises at every set. A session holds the generation it saw as it read the phone's file, or set itself, and clears only that one (`clear-if:<n>`; there is no plain clear), so a marker set after it read the phone (an edit during an open) outlives its save (adversary R1). Disconnect and erase remove the marker file directly. The set and restore pair (`myDataAndWrite`, `PhoneFiles.restore(_:ifStill:)`) is atomic only because every call runs on the engine's actor; Disconnect's remove (`CloudSync`, `files.remove(files.pending)`) takes no lock and is a known narrow exception, healed by the next open's get and clear-if.
- **The captured Screen.** A value sheet opened from My data or a metric page carries the row and the `Screen` taken at its tap, and its save is checked against that (`apply(_:as:)`), so its unit label and the units its value is read in agree; nothing is pinned at the tap. Every sheet that edits the record, these included, still pins on appear and unpins on disappear (`pinsRecord`); for these the carried Screen wins over the pin. A sheet's edit takes `pinned ?? screen` before it waits, and the erase check runs when its turn comes, so a sheet that closes mid-save still saves against the record it showed. An import (`applyNow`) reads the screen at its turn: the record as it is now, never a sheet's pin. On the phone, as in the cloud session (`dependsOnUnits`), a value or height typed before the record's units changed is refused.
- **Unit switches hold entry.** While a per-test or master switch, or an Lp(a) unit choice, is still landing (`unitSwitches`), the units menu, Add Data, corrections, height and My data's value rows wait.
- **A lab report's summary and its import are one step.** On the phone, both run against the record of that turn. In the cloud, one engine door (`cloudLabImport`) takes the summary against the session's working copy and runs the import on it in the same synchronous JavaScript step, so a value another device brought in is never counted as saved. Swift keeps no copy of the session's record.
- **The cloud stamp.** The engine queue stamps every cloud record it hands to Swift (open, edit, erase and document save as their Promise resolves, each notify as it is sent). An edit's answer can arrive after news of a re-read made before it, so the screen keeps the record with the higher stamp.
- Sheets set `saving` in the button action (`SheetSave`), hold Save and Cancel, refuse swipe-down while saving and dismiss only on a save; pickers that save at once wait while their edit lands, so a quick change back is never lost. PlanView asks the engine nothing: it draws the plan the store keeps (below).
- **One engine call draws both screens (2026-10-25, US-25 AC2; Brad: "one engine call that answers both My data and the plan").** Measured in the simulator with a temporary counter (removed): one edit on My data ran `applyEditJson` (a medication or screening answer plans inside it, in `applyFormEdit`; a value plans nothing), then `myDataJson`, whose medication and screening questions plan the record (`basisOf`, 1 computePlan), then `remindersJson` (none); opening My plan then ran `planViewJson`, a second computePlan of the same record and units, and every return to the tab ran it again, with no edit between. The door `screenJson` now reads the record once, plans it once and answers `{myData, plan}`: the plan half is `{sections, tiles, ms}`, or `{error, planError}` when the record cannot be planned, so a plan that throws never blanks My data and a tile that cannot be drawn never blanks the plan. My data that cannot be drawn still throws the whole call, on purpose: the store then shows the record's problem on both tabs (adversary R3), never a plan of a record My data cannot show. `ms` is the engine's own time from computePlan through the tiles and the layout (`planSections`), in whole milliseconds (JavaScriptCore has no finer clock), so the plan screen's "Worked out on this iPhone in N ms" is D2's plan budget, not My data's. `RecordStore` keeps one `drawn` from that call, set together with the record (`display`); `myData` and `plan` read it, so the two always show the same record revision. PlanView draws `store.plan` and never calls the engine. **Every return redraws (Codex R1):** the plan reads the time (ages, screening due dates, minor status), so `redraw` draws the same record again, in line (`chain`), each time the app becomes active, and at `.NSCalendarDayChanged` while active; between returns the tabs share the plan drawn. Not on a new calendar day only: health-core's minor-to-adult switch falls at midday UTC on the 1st of the birth month (`isKnownMinor` judges the date at UTC-12), so a calendar-day check missed it (RecordStoreTests `testAReturnWithinOneLocalDayCrossesTheMiddayUTCSwitchToAdult`). A draw takes about a millisecond. The trial confirms in `display`, from the same stored plan, so it needs no engine call either. After: one edit is `applyEditJson` then `screenJson` (one computePlan; a form answer's `applyFormEdit` plans once more inside `applyEditJson`), and the Plan tab adds none (RecordStoreTests `testOneEditDrawsMyDataAndThePlanInOneEngineCall`, engine `screen.test.ts`). `myDataJson`, `planViewJson`, `HealthEngine.planSections` and `EngineTrial.planned` went with it; the bridge id moved (D3), so a downloaded engine built before it is refused at its manifest check and the bundled engine runs. What still plans on its own: `historyJson` (a metric page and a value sheet, for the plan's `excluded` rows) and the self-test's `planJson`.
- `blocking` is a test-target extension (`EngineTestDoors.swift`), so app code cannot call it at all: the compiler is the rule. It runs its body on the engine's queue through a cast of the isolated closure (not `assumeIsolated`, whose dispatch-queue check needs iOS 18's `checkIsolated`; the app supports iOS 17) with `queue.async`, the waiting thread held on a semaphore, so the body never runs on the main thread. `enqueue` is the app's one copy of the cast.
- **Stages 3 and 4 (2026-10-23): nothing in the app waits on the engine.** `blocking` lives in the test target, so the app cannot call it; and wherever JavaScript runs (`callValue`, `settle`, `evaluate`), a DEBUG precondition checks it is on the engine's queue and not on the main queue, the real rule: no JavaScript on main. App code awaits an engine door or `perform` (a body run on the engine's actor). What moved:
  - **Launch.** `Launch` (HealthRoadmapApp.swift) starts `AppParts.build` from the app's init, not a view, so a background launch builds too, and shows `LaunchView` until it is done: My data's plain background, no mark, read as "Loading". The system launch screen has the same colour (`UILaunchScreen` > `UIColorName` = `LaunchBackground`, an asset equal to `systemGroupedBackground` in light and dark, normal and high contrast, set in `HealthRoadmap-Info.plist`, which the generated plist merges), and so does the welcome screen and the questions (`OnboardingView`); the first-run cover is presented without animation (`RootView.decideFirstRun`). So the opening never flashes: one background from the tap to My data, or to the welcome screen (Brad 2026-10-26; the logo showed for about 100 ms). The file reads run `@concurrent`; `EngineBoot` is no longer main-actor: its checks, both engine loads and the quarantined self-test run off main, and only the trial mark (`EngineTrial`) is set on main, before the parts are handed out; `RecordStore.open` awaits the first `loadPhone`, once, before the first screen. The notification delegate is set synchronously in `Launch.init`. `CloudSync.init` queues the attach with `engine.enqueue`: the engine's queue runs in order, so the attach lands before any engine call asked for after it, and `marksPending` is set before any edit can be asked for. Health's observer may be set after the app became active, so the build ends with one refresh when it is. Measured (simulator, iPhone 18 Pro Max, two-year record): first frame 150 ms after init, all blocked, before; launch screen at 50 ms and the app at 165 ms after, main free between.
  - **Typed numbers** are read in Swift, `TypedNumber.read`, the engine's `readNumber` rule (Arabic-Indic digits, JavaScript's trim, either mark, plain decimals only, -0 as 0; "1,234" read as thousands only inside the input range My data's `inputRanges` gives with the decimal reading below it, never as the decimal, else nil, with the screen's message line asking `TypedNumber.question`; grouped thousands only against a range, US-02 AC7, 2026-10-27); NumberReadingTests holds it to the engine's `numberJson` on 59 texts, and on them and four more under six ranges against the rule written once in the test over the engine's readings. The engine's door stays (tests only; no bridge change). It is in the binary: a change to health-core's number rule needs an app release (D3).
  - **A value's history** is `RecordStore.chart(for:) async`, read once per metric and record `revision` (a counter that moves with the record and the per-test units; the eGFR and waist-to-height series once per draw too, review round 3); a second ask for the same revision joins the read under way, so a page and the page above it make one engine call. The store keeps each answer with its chart inputs (`ChartData`: points, days, the first and last day and the range a page opens on, built once per history) and drops older revisions' as a newer one lands. A page draws `shownChart(for:)`, which may trail the record by one read, and asks again on `.task(id: store.revision)`; only `shownHistory(for:)`, the history read for the record and units as they are now, opens a correction, so Show All Data holds its taps while it trails (adversary R2). A correction's "Now" hint comes from that current history, and for Lp(a) only one read in the sheet's unit (`correctionHint`): never "100 mg/dL" from a 100 nmol/L row.
  - **Onboarding's conversions** (`TypedAnswer`) await the engine; a unit switch's conversion lands only if the box did not move meanwhile, so a box never shows text in units it no longer holds. A trial's confirm needs no engine call: the store confirms as it draws.
  - **Chat history** (`ChatHistoryStore`) awaits the engine for its list, messages, saves and deletes; each save or delete reads, changes and writes in one engine step. The app has one store, made at launch (`AppParts`) and shared by Chat and the eraser: `DataEraser` reads its list again after an erase, and opening History reads it again, so Chat shows what is on disk without a refresh of its own. Both erases now write the chat tombstones on the engine's queue (the phone erase's `keepChat` runs through `perform`), so neither lands between a save's read and write.
  - **Cloud news** is decoded on the engine's queue (`CloudNews`) before it goes to main.
  - **Photos and scans** are resized `@concurrent` (`LabFileReader.photo` takes the photo's bytes; `pictures` takes the scan's images, which are Sendable in the iOS 27 SDK).
- **The watchdog (DEBUG only, opt-in, US-25 AC21c).** `MainThreadWatchdog` runs only when the launch argument `-mainWatchdogLog <path>` names a log. It pings main every 50 ms from its own thread and appends "<timestamp> main stalled N ms" to that file when main took 100 ms or more to answer. It takes no stacks: a tool for timing by hand, not a test. `LaunchClock` logs the launch's milestones in ms since the process started.
- **Apple Health observers at launch (adversary R1).** `Launch.init`, which runs as the process starts, registers HealthKit's observer queries and background delivery at once (`AppleHealthSync.observeAtLaunch`), as Apple requires, while the parts are still being built. A delivery awaits the parts, then refreshes; HealthKit's completion is called after that refresh, or at once if the parts never come. `HealthKitClient.observe` registers once per process, so the sync's own `start` keeps the launch's queries. Coming on screen refreshes Health from `follow` (`AppleHealthSync.foreground`, which first asks for lab results where HealthKit says a request is needed, US-72), beside sync and the updater; the sync itself listens only for the phone unlocking.

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

**Shape chosen for sync (2026-10-21, cloud sync build): the polyfill.** The second shape (a
Swift `StorageAdapter`) would have kept merge in JavaScript but rewritten the Dropbox and
Drive request shapes, the conditional write and Drive's version check in Swift: the code
whose drift loses rows (dropbox-rest.ts's own header says so). The polyfill keeps all of
it shared, so a fix to `dropbox-rest.ts`, `drive-rest.ts`, `SyncManager` or
`RecordSession` reaches the phone with the next engine build. The bridge is small:
- Swift (`Engine/EngineNatives.swift`) supplies five primitives, installed as the global
  `__native` before the bundle runs: `http` (one URLSession request, body and answer as
  ArrayBuffers, headers as JSON) with `cancelHttp`, `setTimer`/`clearTimer` on the
  engine's queue, and `utf8Encode`/`utf8Decode`. Plus the cloud calls (`CloudPort`): an access
  token, the phone's record file, the pending marker, and `notify`.
- `ios/engine/shim.ts` builds on them exactly what the adapters touch: `fetch`,
  `Response`, `Headers`, `Blob`, `AbortController`, `AbortSignal` (`timeout`, `any`),
  `DOMException`, `setTimeout`/`clearTimeout`, `TextEncoder`/`TextDecoder`. A global the
  runtime already has is never replaced. Not shimmed, because nothing on the sync path
  uses them: `URL`, `URLSearchParams`, `atob`/`btoa`, `crypto.getRandomValues` (the token
  exchange is Swift's). Tested in Node (`shim.test.ts`, an empty vm context) and in
  JavaScriptCore (`ShimTests.swift`).
- Every JavaScript call, timer and answer runs on the engine's queue, never on main; URLSession
  answers hop there before they touch a JSValue. The invariant, from stages 2 to 4: the
  engine's queue never waits on the main thread (above: "The engine off the main thread",
  its invariant, and "Stages 3 and 4"). Async engine doors return Promises; `HealthEngine.callAsync` awaits
  them with a continuation, and JavaScriptCore runs the promise jobs when each call from
  Swift returns. The bundle is 510 KB with sync.

**Lp(a)'s unit (2026-10-23, US-25 AC20).** Lp(a) is shown and typed in nmol/L, mg/dL or mg/L,
as on the web (US-05 AC2). Unlike the per-test Metric/US choices (a device preference), the
unit is the record's `profile.lpaUnit`, so it syncs: the engine's `lpaUnit` edit writes it with
health-core's `stampProfile`, the web store's own write. The display and reading functions are
health-core's `cell-unit.ts` (`recordLpaUnit`, `cellText`, `cellFromSI`, `cellRange`), moved there
from the web's `blood-test-cell.ts` and `lpa-unit.ts` so both clients run one copy. The Screen a
sheet carries holds the Lp(a) unit it showed; a unit chosen in the sheet moves that Screen with it
(`ValueEntrySheet.lpaUnits`), and one changed elsewhere refuses an Lp(a) value or correction, on the phone's file in Swift and in the
cloud session in `cloudEdit`, whose new last argument (`shownLpaUnit`) changed the bridge id (D3).

### D3 · Clinical fixes ship over the air, signed (Brad, 2026-10-21; built 2026-10-22, US-25 AC18)

The engine bundle can be updated without an App Store release. Apple's developer agreement
allows an app to download interpreted code if it does not change the app's advertised
purpose; Expo Updates and CodePush rely on the same rule. Brad, 2026-10-22: "should
automatically come through if I update github". How to release: [engine-updates.md](engine-updates.md).

**What was built.** The release is three files in `ios/engine-release/bridge-<id>/` on
`main`: the bundle as `<sha256>.js`, `manifest.json` and `manifest.sig`. Two steps
write them, so no repo code runs next to a key (review R1, N3, N4): `npm run
engine:build` runs `env -u ENGINE_SIGNING_KEY node ios/scripts/release-engine.mjs`, a
first module that refuses if a key is still in its environment and only then imports
the build code (`release-build.mjs`: esbuild and the parity check; a test shows no build
module is loaded with a key present). Then `node ios/scripts/sign-engine.mjs`, run
directly, not through npm (Node's own modules and `engine-signing.mjs` only, the Keychain
read through `/usr/bin/security` by absolute path), checks the manifest and bundle on
disk and signs. The app reads them from
`raw.githubusercontent.com`. GitHub is a dumb host: trust comes only from the signature,
so a push to `main` by a loop or anyone else reaches no phone unless Brad's key signed it.
A signature means "the key holder approved this bundle", nothing more.

- **Signed, by pinned keys.** Ed25519 over `"health-roadmap-engine-manifest/v1\n"` plus
  the manifest's exact bytes (the prefix stops a signature made for anything else passing
  as a manifest's). Three keys, pinned by id in `EngineRelease.swift` and
  `ios/engine/signing-keys.json`: `daily` in Brad's login Keychain, trusted by no app, so
  every read asks him (adversary R9: not a 0600 file, which any process of his could
  read), and never anywhere else; `cold` in the Passwords app only, for a lost Mac; and `ci`,
  only in the GitHub `engine-signing` environment's secret, for the workflow (pinned
  2026-10-22 before any app shipped, so it cost no app update; orchestrator's call). Any pinned key verifies; the
  manifest's `keyId` must name the one that did. The manifest must be the one canonical
  spelling (keys sorted, no whitespace), so a duplicate or unknown key is refused (R5).
- **The manifest** (`format` 1): `appId`, `channel` "production", `bridge`,
  `schemaVersion`, `version` (UTC yyyymmddHHMM, at most one a minute), `issuedAt`,
  `notAfter` (30 days on), `minVersion`, `minAppBuild`, `sha256`, `size` (R2, R12). Checked
  in this order: signature before any parse, then the fields. `notAfter` and "no more than
  two days ahead of the phone's clock" apply only to installing, never to running a
  bundle already installed, so a phone with a wrong clock keeps working (R2). The version
  must beat both the bundled engine and the highest version this phone ever accepted
  (anti-rollback), and `minVersion` raises a floor the phone keeps, which kills a bad
  release.
- **The bridge is a hash (R7).** `bridge` is the first 16 hex digits of the SHA-256 of
  `ios/engine/bridge-contract.json`: the natives, the doors with their arguments, the
  events. `bridge.test.ts` (Node) and `EngineBridgeContractTests` (XCTest) fail if either
  side drifts from the file, so an engine that needs a new native cannot reach an app
  without it: it lands in a new `bridge-<id>` folder that old apps never read.
  **Both-way additions keep the id (2026-10-31, US-61, D14):** `ios/engine/bridge-optional.json`,
  never hashed, holds only an optional trailing argument (an older app sends one fewer and
  the engine answers as before) or an optional return field (an older engine leaves it out
  and the app reads none). Both tests count a door's arity as its contract args plus its
  optional ones; `bridge.test.ts` also checks each optional argument trails the contract ones
  by name in `entry.ts`, and that every optional door, called with only its contract args,
  answers as it does with them undefined. A missing return field is tested per feature. Anything
  an older app cannot do without stays in the contract and moves the id.
  Second use (2026-11-02, US-62 AC8): My data rows' `target` and `previous`, read as none from
  an older engine (`MyDataLayoutTests.testARowReadsItsTargetAndPreviousValueFromTheEngine_US62`).
  Third (2026-11-02, D11): rows' `status` and `gradeWords`, and `labTests`
  (`MyDataLayoutTests.testARowReadsItsGradeFromTheEngine_US62`).
  Fourth use (2026-11-02, US-66 AC14): `screenJson`'s `movedRecord`, the record to write once
  when reading the phone's file moved its blood tests into one table. `loadPhone` writes it with
  the edit path's atomic write and no pending marker (the move changes no value; an open cloud
  writes its own copy, in `cloudOpen`, through `commit` as an edit does). A field, not a new
  door, so the bridge id stays: an older app ignores it, an older engine sends none.
  Fifth use (2026-11-05, US-73, PR B of the My health plan): `screenJson`'s `plan.topics`
  (health-core `topicSections`) and two new `historyJson` series, `egfr` and `whtr`. The add by
  name is a new edit kind, `labAddName` `{name, value, unit, day?}`, inside `editJson`, so no
  contract field moves; an older engine knows no such kind, and the edit fails as an error.
  **Optional doors (rule extension, 2026-11-05, orchestrator decision):** a third kind in
  `bridge-optional.json`, `optionalDoors`: a whole door `entry.ts` exports that the hashed contract
  leaves out, so adding it keeps the bridge id. An old app never calls a door it does not know.
  A new app normally runs an engine at least as new as its bundled one (an over-the-air version
  must beat the bundled engine's, the anti-rollback rule above), so the door is normally there.
  Safety does not rest on that: Swift reaches an optional door only through
  `HealthEngine.optionalCall`, which answers nil for a door the engine lacks (the feature
  unavailable, never a crash). That nil is the insurance, not the expected path. The frozen
  shapes are append-only (`bridge.test.ts` snapshots each door's arguments and answer), and
  `EngineSelfTest`'s door list never names one. Enforced:
  `bridge.test.ts` (every export is in the contract or an optional door, never both, with its
  arity and argument names) and `EngineBridgeContractTests` (outside the contract and the
  self-test list, in the bundled engine with its arity, and no Swift call to it but through
  `optionalCall`). First: `labSearchJson(text)`, the add sheet's name search (health-core
  `labSearch`, US-73 AC8), read in Swift as `HealthEngine.labSearch`. Second (2026-11-09, US-73
  AC12): `documentOriginal(id)`, the first that answers a Promise, of an ArrayBuffer; Swift reaches it
  through `optionalCall`'s async form (`read:`), and `bridge.test.ts` freezes its arguments and checks it
  refuses with no cloud open (its bytes answer is pinned in `cloud.test.ts`). Beside it, a sixth
  optional field: `screenJson`'s `myData.documents`.
  **Schema 3 (Brad 2026-11-02, US-66 AC15):** a record holding a core blood row is
  `schemaVersion` 3, so the engine's `schemaVersion` fact becomes 3. Build 3 bundles a
  schema-2 engine: it refuses a moved record with its "update the app" path (US-65 AC5) and
  writes nothing, and it refuses an over-the-air engine of schema 3 by the rule below (R7).
  The iPhone update ships the schema-3 engine in the binary.
- **The schema is the app's (R7).** A bundle whose record `schemaVersion` differs from the
  bundled engine's is refused. A schema change always needs an app update, so an over-the-
  air engine can never write a record the web or an older phone cannot read.
- **Typed numbers are read in the binary (US-25 AC21).** `TypedNumber.read` is Swift, a copy
  of health-core's `parseLocalisedNumber` rule, so typing never waits on the engine. An
  over-the-air engine does not change how the app reads a typed number: a change to that rule
  in health-core needs an app release too (NumberReadingTests holds the copy to the bundled
  engine's `numberJson`).
- **The bundled engine has a version** (`health-engine.json`, beside the bundle): the
  source commit's UTC minute, not the build time, so a release built later from the same
  source is newer, and an App Store update whose engine is newer deletes older downloads.
- **The check** (`EngineUpdater`): on coming on screen, launch included, at most once in 6
  hours. Two GETs (manifest, signature) on an ephemeral session: no cookies, no cache, a
  plain User-Agent, no redirects, 15 s timeouts, no health data, no device id. Only a
  verified manifest leads to the third GET, the bundle, read up to its declared size (8 MB
  cap) and refused unless its SHA-256 matches. It is staged in `Application
  Support/Engine` (left out of backups, as the record is) with its manifest and signature.
  Failures are silent and keep the current engine. The GETs, the signature and hash checks
  and the staging run off the main actor (US-25 AC21); both of the check's read-modify-writes
  of the state (stamping `lastCheck`, then recording the release) run on the main actor with
  no suspension inside, as `EngineTrial.confirm()` does, so the two are serialized and neither
  overwrites the other (review R1). The last write re-reads the state and changes only
  `highWater`, `floor` and `lastCheck`, so a trial confirmed during a download is kept (review R4).
- **The state file** (`state.json`) decodes a missing field as its default. `highWater`
  and `floor` are mirrored into the Keychain (`EngineWatermark`, this device only, after
  first unlock, only ever raised), and every read of the state is raised to them, so
  losing or damaging the file never lowers either (review N5). A file that reads but does
  not decode is corrupt, not locked: it is moved aside, every staged version is deleted
  (the record of which were bad went with it), and the state starts again with
  `highWater` at the higher of the Keychain's and the bundled engine's version and
  `floor` at the Keychain's (review R8, N5). One that cannot be read (before first
  unlock) is "not now".
- **Activation** (`EngineBoot`), only at a fresh launch, never mid-session. The staged file
  is read once; the signature and fields are checked again against today's pins (a key
  removed in an app update stops its bundles), and the hash against the bytes in memory,
  which are the bytes run (R6). Then a **quarantine** (R6, R11): the bundle loads in a
  JSContext whose natives refuse every request, hold no token and keep the phone file in
  memory, and `EngineSelfTest` runs: version, schema, every contract door, a new record,
  edits, My data, a plan and its layout, and merge goldens (no row lost or invented,
  entered-in-error sticky, the higher `eraseEpoch` wins). Only then is the real context
  built, from the same bytes. **The self-test catches accidents, not malice**: a hostile
  engine could pass it. The signature is what keeps hostile engines out.
- **Fallback.** A "trying" mark is written before a version's first foreground load and
  cleared once the engine has drawn the user's own record and planned it: the store
  confirms in one place, `RecordStore.display`, whenever a draw of the user's record
  (launch, an edit, a unit switch, a cloud record, a return to the app) planned it; orchestrator's
  call, 2026-10-22, moved into the store 2026-10-25. It confirms only when the plan worked
  or met health-core's own PlanError (no height; US-07 AC8), never when the engine threw
  (review R5, N1), and a later draw that plans re-checks a trial the first draw left open.
  So a crash or hang on the real record counts, not only one on the self-test's fixture,
  while quitting does not: the store draws the record before the first screen. What that
  no longer catches, since the mark clears before the first frame: a crash while SwiftUI
  first draws the screens, or a hang in a launch call made after that first draw. A
  release that breaks only those stays proven. Still there at the next foreground launch means
  that launch crashed or hung before the record was shown, and the version is marked
  bad. The cost that remains: a launch killed in that first moment, or a record the engine
  cannot draw, marks a good release bad on that phone,
  which then runs the bundled engine until the next release gets its own trial. A failed check or self-test marks it bad too. Bad
  versions are deleted and never tried again; the next staged version, or the bundled
  engine, runs. **Background launches (R8)** (a Health delivery) never try a new engine:
  they run only a version that passed a foreground launch, and an unreadable file there
  (before first unlock) means "not now", never "bad".
- **Swift holds the tokens; the network is fenced (R3, R4).** The engine's `accessToken`
  native answers the sentinel `native-token:<provider>`, never the token. Native `http`
  (`EngineHTTP`) sends only the allow-listed calls, method, host and path, of the provider
  the sentinel names: Dropbox `files/download` and `files/upload` (`files/list_folder`
  went 2026-10-25 with the lab list, US-52 AC11); Drive `files` list, create, get (metadata and media) and the upload
  create and update. Each route also lists its query parameters (Dropbox none; Drive
  only what drive-rest.ts sends on it: `q`, `spaces`, `fields`, `pageSize`, `pageToken`,
  `alt`, `uploadType`), and every call may carry only the adapters' headers
  (`Content-Type`, `Dropbox-API-Arg`, `Accept`, `Content-Length`) besides the sentinel;
  `access_token`, `authorization`, `oauth_token` and `key` in a query are refused in any
  case (review R2). It swaps the real token in there and nowhere else. Any other header,
  path (Dropbox `sharing/*`, `delete_v2`, Drive `permissions`), host (the app's own
  server included) or plain http is refused. The engine has its own ephemeral session,
  and every redirect is refused. So no engine, however changed, can
  send the record or a token anywhere new by itself. **One path remains, by design: the
  chat context** (review R7). The engine builds it from the record, and Swift sends it
  to our server when the user asks a question (US-52); the server rebuilds its prompt
  from it rather than passing it on as it is. Swift checks it is a JSON object with a
  unit system and under 512 KB, and sends only the top-level keys `chatContextOf` can
  produce (`ChatClient.contextKeys`; `chat-context-keys.test.ts` fails if health-core's
  set drifts), dropping any other (`ChatClient.body`, Codex R3). Derived from
  dropbox-rest.ts and drive-rest.ts on the app's path; `get_metadata` and longpoll are
  left off because the app never calls them (push is web-only). **Before Drive sync goes
  live, check that Drive's `alt=media` download answers directly, without a redirect**:
  a redirect (to googleusercontent.com, say) is refused, which would break Drive reads.
- **Disclosed (R13, R14).** The privacy policy says GitHub sees the phone's IP address
  when it checks and the check carries no health data; the App Review notes say updates
  change computation and text only (ios/app-store.md). The plan line ("Worked out on this
  iPhone", D9) stays true.
- **Automatic on GitHub.** Workflows are Brad's; with his permission (2026-10-25) an
  agent added `.github/workflows/engine-release.yml` (engine-updates.md, R1, R3, N2): a
  build job with no secret (`npm ci --ignore-scripts`) decides only whether to upload
  the artifact; a `verify` job, with no repo code and no npm, takes the commit from the
  Deploy event, computes the bridge itself, checks the artifact, and fails if `main`'s
  engine inputs moved since, then writes the manifest, sha256s and every file changed
  since the commit the last release was built from into its run summary, for Brad to
  read before he approves; then a signing job in a separate `engine-signing`
  environment (Brad the required reviewer, `main` only, the `ci` key) checks the same
  artifact again, repeats the main-moved check, refuses a floor below `main`'s, signs it
  with openssl, and commits only the new files (plus an unsigned `built-from` record), refusing to lower or replace a newer release on `main`. Neither of the
  last two runs repo code. It was pushed from Brad's account
  (the workflow-integrity tripwire disables workflow files pushed by anyone else) on
  2026-10-25, and the secret was set on 2026-10-26, so the CI path is live; each release
  still needs his approval. **Open check:** the first Engine release after a Deploy on
  `main` proves the secret is the pinned `ci` key (its sign job derives the public key
  and compares it with `signing-keys.json`). If that check fails, Brad sets the secret
  again; if no run starts on its own, he runs Actions › Engine release on `main`.
- **Where the keys live (2026-10-26).** Three Ed25519 keys, public halves pinned in
  `ios/engine/signing-keys.json` and `EngineRelease.swift`. **daily** `519a8365b02da897`:
  the iMac's login Keychain (service `health-roadmap-engine-signing`, account `daily`),
  the new Mac's Keychain if Brad added it, and Brad's Passwords app. **cold**
  `9a415581b0a54dbd`: Passwords only. **ci** `d6a343128471bae8`: Passwords and the
  GitHub secret `ENGINE_SIGNING_KEY` in the `engine-signing` environment (`main` only,
  Brad the required reviewer). The key files in `~/.config/health-roadmap/` were deleted
  with `rm -P` on 2026-10-22; `engine-keygen.mjs` and `signing-key-guard.test.ts` still
  name those paths on purpose (keygen writes them; the guard checks only while they
  exist). No agent has seen a private key.
- **Revocation needs the repo public** (review R10). Phones read releases without a
  sign-in; if the repo goes private, no phone can fetch a release that raises the floor
  to kill a bad one. The fallback is an App Store update, whose newer bundled engine
  makes phones delete older downloads.
- **Prewarm is unverified** (review R9). iOS may prewarm the app before the user opens
  it; whether that launch counts as foreground for the trial is unchecked on a real
  iPhone (ios/launch-checklist.md).
- **Usage signal:** engine-load failures in crash reports (App Store Connect); the app
  sends nothing (D9). A version refused at launch is in the device log (no health value).
- **DEBUG only, compiled out of Release:** launch arguments `-EngineUpdateBaseURL` (a
  local server) and `-EngineUpdateTestKey` (a throwaway key), for the end-to-end check.

**Checked end to end, 2026-10-22,** in the simulator against a local server (DEBUG base
URL and a throwaway key): the first launch fetched the manifest, signature and bundle and
staged release 202610212108; the next launch ran it after its self-test ("running
downloaded engine 202610212108", marked proven); with one byte of the staged file flipped,
the next launch refused it (hashMismatch), marked it bad and ran the bundled engine. With the
trial held until the record is shown (confirmed by the plan only), release 202610212136's
mark stayed through the welcome screen and My data and cleared when My plan opened. With
My data confirming too, release 202610212154 was proven within six seconds of launch,
before Get started was tapped: the welcome screen is a full-screen cover, and My data
draws the record beneath it.

**Known gaps.** Only names and arities of doors are drift-checked; their JSON shapes
are described in the contract and pinned by the self-test and the app's own tests.

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
tab (`ios/engine/my-data.ts`) writes through health-core's `record-edits` directly when the
record is the phone's file, one pure edit per call. **When a cloud is connected (built
2026-10-21):** each edit runs `applyEdit` on the session's working copy and then
`RecordSession.edit` with the erase stamp the screen showed (`ios/engine/cloud.ts`
`cloudEdit`; Swift keeps the stamp in `RecordStore.cloudErase`), so it gets the save loop,
the merge on conflict and the erase guard. The phone-file path stays outside a session:
the device tier has one writer, and a session there would add a second copy of the file in
memory for no gain. Revisit when Apple Health import becomes a second writer (D6).

**The form's questions moved too (2026-10-21, US-25 AC8).** The medication, screening and
supplement questions (labels, hints, option lists, show-when rules and what each answer
writes) lived as JSX in `InputPanel.tsx`. They now live in health-core's `input-form.ts`
as data (`medicationForm`, `screeningForm`, `medicationWrites`, `screeningWrites`); the web
form imports the text and write rules (net -204 lines there, DOM unchanged, a parity test
renders it against the descriptions) and the app renders the same descriptions natively.
Decided in the night session because the alternative, Swift or a second TypeScript copy of
the cascade steps, is the drift D2 exists to stop. The web still lays its fields out in
JSX: rendering the web from the descriptions too is a possible follow-up, not needed for parity.

### D5 · Storage: on the phone by default, Dropbox or Google Drive optional (Brad, 2026-10-21)

- **Default: a file in the app's container**, with iOS Data Protection. Built 2026-10-21
  (`MyData/RecordFile.swift`): `Application Support/Record/health-roadmap.json`, the web's schema,
  written atomically, and only after the engine accepted the edit. Data protection is
  "until first unlock", Apple's default (the strictest class, which HealthKit uses, would
  fail when iOS pre-launches the app before the user unlocks; a read that fails still
  stays failed until the next launch). Brad kept this class, 2026-10-21.
  **Not in backups (Brad, 2026-10-21):** the `Record` folder is marked
  `isExcludedFromBackup`, which asks iOS to leave the record out of an iCloud backup
  (standard iCloud Backup is not end-to-end encrypted) or a computer backup. The mark is on
  the folder because every save replaces the file. The cost: a user who moves to a new
  phone without Dropbox or Drive sync starts empty, and My data says so. To check on a real
  iPhone: whether Quick Start (direct phone-to-phone transfer) also leaves it out. The
  install's `deviceId` lives beside the record, in the same left-out folder (`device-id`),
  so a phone restored from a backup gets a new id and never writes a shared cloud record as
  the old phone (it was in UserDefaults, which is backed up; moved 2026-10-21). If the mark cannot be set, the app does not start (it
  fails closed); Brad may prefer a read-only record instead. The first record is staged beside the file and moved into
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
  The Dropbox app need not be installed. Tokens live in the Keychain, this-device-only
  (`kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`). Built 2026-10-21: app key
  `xf96vqvjotm5xhx` (the web's), redirect `db-xf96vqvjotm5xhx://2/token` (the Dropbox iOS
  SDK's convention), `token_access_type=offline`, no `scope` parameter (the web sends none
  either, so the token carries the app's registered scopes). The callback scheme is not
  registered in Info.plist: `ASWebAuthenticationSession` catches it itself, and a
  registered scheme would only let other apps and links open this app with a code.
- **Google Drive:** PKCE with an iOS client in the **same** Google Cloud project as the web,
  because `drive.file` only shows files the project created. No server token exchange.
  Built 2026-10-21 but off: `CloudProvider.googleIOSClientId` is empty until Brad creates
  the iOS client (project 687809032623); the redirect is the client's reversed id,
  `com.googleusercontent.apps.<id>:/oauth2redirect`. Scope `drive.file` only (the web also
  asks `openid email`, for server reminders the app does not use, D7). A grant without
  `drive.file` is refused at sign-in.
- **How sync runs (built 2026-10-21, US-25 AC11).** One cloud session at a time, health-core's
  own `RecordSession` over a `RecordHost` that `ios/engine/cloud.ts` builds: the store is the
  cloud through health-core's `DropboxAdapter`/`DriveAdapter`, re-made per access token
  (Swift refreshes the token; a 401 refreshes once and retries); the device mirror is the
  phone's own record file (`Record/health-roadmap.json`) through the natives, with the
  pending marker as a file beside it (`sync-pending`); the connected provider is a file
  there too (`sync-provider`), so a phone restored from a backup comes back unconnected,
  matching the Keychain's this-device-only tokens. First connect lifts the phone's record
  into the cloud (`liftDeviceCopy`, a merge). Launch and every return to the foreground
  re-read (`LiveRefresh.visible`), and a minute poll runs while on screen; going to the
  background flushes inside a background task. Disconnect flushes, merges the cloud down
  onto the phone (`copyCloudDown`), drops the tokens and goes back to the phone file; it
  does not revoke the token at Dropbox (the web does not either). A cloud that cannot be
  read at Disconnect does not stop it (the web stops a switch then): the phone already
  holds every edit made here, and the Sync screen says the newest changes from other
  devices may be missing. Erase from another device arrives through the merge (the higher
  `eraseEpoch` wins), and `RecordSession`'s erase guard refuses an edit typed against the
  pre-erase screen.
- **The phone keeps a copy while connected (decision, 2026-10-21, cloud sync build).** The
  web keeps nothing locally on a cloud except a failed save. The app does more, for two
  reasons: it must open with the user's data when there is no network, and an edit must
  survive the app being killed in the 800 ms before its save. So every edit is merged into
  the phone file and marks it pending before the save goes up (write-ahead); a successful
  save clears the marker (the session's own rule); every re-read or open that brings
  something in is merged into the phone file without the marker. A launch that cannot reach
  the cloud shows the phone copy, takes edits there (marking them pending), and the next
  open merges them up. All of it is health-core's merge, so rows are never lost and an
  erase still wins. Cost: the phone file holds the record while connected, under the same
  protection and backup exclusion as before. Brad may prefer the web's leaner rule.
- **Review fixes (2026-10-21, Codex R1-R6 and Opus adversary A3-A10).** Edit sheets pin the
  erase and the units they opened on (`MyData/RecordPin.swift`, `RecordStore.Screen`); the
  engine's `cloudEdit` refuses a value typed in units another device has since changed, and
  `RecordSession.refuses` refuses one typed before a remote erase. `cloudEdit` merges the edit
  into the phone's file synchronously and refuses it if the phone cannot write it, so
  "saved" is true on the phone before the save goes up. CloudSync tracks its session
  explicitly (`recordOpen`); a failed reopen falls back to the phone's file; a generation
  number makes a Disconnect beat an open still in flight; edits that land while the cloud
  opens make the open run again so the session merges them. Every re-read reports to Swift
  (`synced` or `failed` with its kind). A 403 whose reason is a rate limit is a retry, not a
  sign-in. The account a sign-in belongs to is kept (`sync-account`); signing in again as
  another account is refused, because merging would put one person's record into
  another's: the user disconnects first, then connects the other account (a fresh connect
  then lifts the phone's record, as any first connect does). After a Disconnect,
  `sync-history` remembers the cloud, and the words say a copy stays there. The background
  save has an expiration handler. Drive runs through the shim in Node against a fake
  Drive (`cloud.test.ts`), so its path is tested before the iOS client id exists.
  Re-check fixes, same day (F1-F7): each engine session has a number, carried on every
  event; Swift acts only on the session it shows. An open that finishes after a newer open
  or a close began closes itself and rejects ("superseded"), so two racing opens never
  orphan a session. "Synced" is said only when the pending marker is clear. A unit change
  refuses only edits whose number is in units (a value, a correction, a height). ~~A
  refusal re-pins the sheet so a corrected retry saves~~ (reversed by the second re-check:
  the sheet still showed the old unit and kept the typed number, so a second Save stored
  it in the new units). A refused sheet now keeps refusing until it closes, and says
  "Close this and enter the value again". After three opens interrupted by
  edits, the last session is closed and the app says why. Disconnect's copy-down reports
  only a real copy. Drive's storageQuotaExceeded says the Drive is full; dailyLimitExceeded
  retries.
  Second re-check (Codex, same day): an open takes its number before any await, so the
  order of the calls decides which open wins, never the order their awaits finish in.
  "Synced" has one rule (`CloudSync.settled`): the pending marker is clear. The marker is
  set before every edit is taken and cleared by the session only when a save has landed
  and verified, and the engine says 'synced' at that moment; until then the app says
  "Saving…", on open, after a write and after Sync now.
- **Not yet:** a push change signal. The web's Dropbox long-poll and Drive changes feed
  live in `widget-src/`, not health-core; moving them in would give the app push for free
  (US-34). Until then the app polls each minute while on screen.
- **Documents (US-52 AC13d, 2026-10-22):** the app files letters and lab originals
  through health-core's `saveDocuments`, the web's one path, with the shared adapters
  built `{ documents: 'write' }`. The rows commit like any cloud edit (phone copy and
  pending marker, then `RecordSession.edit` with the erase), one save at a time. Swift
  hashes each original with CryptoKit as it reads it (JavaScriptCore has no
  `crypto.subtle`) and checks the hash again at Save; the engine takes that hash as the
  row's `contentHash`. On Drive the originals go to the folder that holds the record, so
  web and phone share one archive. The app never reads an original back yet.
- **Not the iOS Files picker.** File Provider writes have no version check, which breaks
  US-10 AC4 (two overlapping saves must keep both rows).
- **iCloud: open.** A website cannot read iCloud Drive, so an iCloud user could not use the
  web app (CloudKit JS would need its own sign-in and work). App Review has also restricted
  health data in iCloud (guideline 5.1.3). Brad is checking. Same question for iOS device
  backups: decided, the record is excluded (above).
- **Erase (US-11)** runs as on the web, and also deletes the samples this app wrote to
  Apple Health and cancels its notifications. A phone that takes in an erase made on another
  device does the same.
  **Built 2026-10-21 (US-25 AC16)**, with "Export my record" beside it. Decisions taken
  while Brad slept, for him to revisit:
  - **One engine erase per mode.** No cloud: the phone's file through health-core's
    `buildErasedFile` (`ios/engine/erase.ts`; the stored record and the working copy are the
    same file, and there is no device mirror). A cloud open: `RecordSession.deleteAllData`
    (`cloudErase`), so the cloud file keeps the erase and the web's guard applies. A cloud
    connected but not open: refused, as the web refuses in its on-device fallback.
  - **An unreadable phone record refuses the erase.** The web's guest erase replaces a record
    it cannot read with the erased record, at the revision it found unreadable (US-11 AC9); the
    app has no working copy then, and never writes over a record it cannot read (US-25 AC4).
    The user sees why.
  - **After a cloud erase the phone copy is the erased record**, not absent: the session wipes
    the pre-erase copy and the pending marker, then the erased record goes in its place, so an
    offline launch opens on it, as every other cloud change reaches the phone copy.
  - **Chat history** (a phone-only file) is tombstoned by the engine's `ChatSession.eraseAll`
    and written only when that step ran. With a cloud open, the `chat-history.json` the
    website saved there is tombstoned first, by `ChatSession` on the cloud host, as the web's
    erase does (2026-10-22). It is best effort and reported on its own (`cloudChatErased`):
    a corrupt file or a newer website's schema never blocks the phone's chat erase
    (adversary R1). The confirmation names the website's chat in the cloud, and the result
    says whether it is gone or still there (R2): a provider that did not answer gets "Try
    again"; a file the app cannot read gets the way out, delete it on the website or in the
    cloud (M1). A refusal after the chat step names what was deleted (L1). Its writes send
    no sync status (R3). **Gap:** an erase made on the web reaches this
    phone's record and reminders but not its chat history. Closing it needs the phone to
    remember the erase epoch its chat last saw, as the reminders opt-in does; not built.
  - **Units are kept** (a setting; the web keeps its unit preference through an erase), the
    welcome flag and the AI consent are kept, the sync connection is kept.
  - **Reminders** need no step of their own: the opt-in ends when the epoch moves (D7).
  - **Apple Health** (merged in the same evening; disconnect 2026-11-11, D6): after the record
    erase, `AppleHealthSync.erased` disconnects Health and resets every import anchor, then
    deletes every sample this app wrote (HealthKit's source predicate, kinds it may write) and
    clears `HealthSyncMemory`'s written versions. Another device's erase disconnects the same
    way and deletes only the sync ids that memory lists (`deleteSamples(syncIds:)`). A refused
    delete never undoes the record erase; the words say so. Not checked on a real iPhone.
  - **Export** is the record as shown (`store.recordJSON`) through the share sheet, written by
    the share sheet itself (`RecordExport`, a `DataRepresentation`), so the app keeps no
    stray copy. The website has no "load a file" flow; that would be a web feature.

**On a real iPhone, 2026-10-22** (Brad's iPhone 15 Pro Max, iOS 27.0.1, driven through iPhone
Mirroring): Dropbox connected, synced and merged the website's lab values into the phone's record
(`health-roadmap.json` updated in Dropbox at the first sync); disconnecting and connecting Google
Drive carried the same 57 KB record into Drive › Health Plan by Dr Brad. Google refused the
Workspace password (brad@microvitamin.com) while "Try another way" signed in: the Workspace allows
any third-party app (Admin console › API controls), so the likely cause is a stale autofilled
password, not the app. The connect screens now show how sync works (`Sync/SyncDiagram.swift`,
US-25 AC11i): the person's cloud above this iPhone and the website, silver data flowing both ways,
no line to Dr Brad's server; still under Reduce Motion, capped at 30 frames a second.

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
- *Superseded 2026-11-11 (Brad's yes):* after taking in an erase, the importer skips
  samples older than the erase. The import anchor is kept outside the record.
- **An erase disconnects Apple Health (Brad 2026-11-11; US-72 AC10).** A local
  erase, or a newer erase taken in from another device on the same record source, disconnects
  Health and resets every import anchor, vitals and lab results alike. The first open of a
  record (a new cloud included) adopts its erase as seen and never disconnects. One stored
  value holds the erase seen and its source; a pure gate decides keep, disconnect or adopt.
  Order on a local erase: the record mark, the erase, then the disconnect. Connect reads
  everything from the start; the importers keep no erase rule. Anchors stay outside the record.
- Merge orders rows by when they were written, not when they were measured. Rules such as
  "the latest reading of the day wins across devices" would need the sample time in the
  record and a merge change: merge-class work, adversary plus Codex.

**Built 2026-10-21 (engine).** The rules above are health-core code, so Swift only reads
HealthKit and hands readings over: `device-import.ts` (`importDeviceSamples`, the My data
edit `appleHealth`) and `device-export.ts` (`deviceWrites`, the door `healthWritesJson`).
Decisions made building it (agent, 2026-10-21; Brad to confirm):
- **The row's `recordedAt` is the reading's real instant with the UTC offset of where it
  was taken** (`2026-10-21T08:30:00.000+13:00`), in the zone HealthKit recorded
  (`HKMetadataKeyTimeZone`), else the phone's. `dayOf` gives the day the person lived
  there; the web shows it as a moment (`formatShortDate` treats only `T00:00:00Z` as a day),
  so a viewer in another zone may see the neighbouring date. Within a day the latest
  reading wins, compared as instants: a later reading replaces an earlier Apple Health row
  (a correction with its own `recordedAt`, same day), an earlier one is skipped. Without
  the time, the winner would depend on arrival order and a full re-import could swap it.
  First built as wall-clock time labelled Z; the adversary review found the web showed it
  on the wrong day, so it fell before any real data (2026-10-21).
- **A blood pressure lands whole or not at all.** Its halves carry the correlation's id
  (`pairId`); a pair with a half refused (out of range, a typed half, a later reading) or
  missing (Health shows only the half the person allowed) lands neither.
- **Single device only.** These rules hold on one phone. Across devices the merge keeps the
  newest-written row of a slot, so a phone import written after a web-typed value for the
  same day can win the merge, and a later-written earlier reading can stay active. The write
  version (below) has the same limit: when a merge picks another device's correction with a
  shorter chain, its version does not rise, so Health keeps the old value. Fixing these is
  merge-class work for the cloud-sync slice (adversary plus Codex); a version of (chain
  length, write time) or a lamport clock would rise across both.
- **"Not yet happened" compares instants**, with five minutes for a device clock running
  ahead: a reading's day is the day where it was taken, which in a zone ahead of the phone's
  is already the phone's tomorrow (fix-scoped re-check, 2026-10-21).
- **Blood pressure is observed as its two halves** (2026-11-02): Apple refuses `HKCorrelationType` for background
  delivery, so `observe` registers the systolic and diastolic quantity types; the import still reads the correlation.
  One reading fires both observers, and `refresh` folds the second into the running import.
- **Height** is the profile's: Apple Health fills an empty height and never replaces one.
  It is not written back: the profile has no source, so an imported height would echo.
- **Blood glucose is not read.** It is a catalogue lab value, and lab rows have no
  `externalId` to dedup on; it waits for the Health Records work. HbA1c has no HealthKit
  quantity type.
- **Blood pressure** is written as one correlation per day, both halves present, keyed by
  the systolic chain's root; a day with an imported half is not written.
- **The write version is the correction chain's length** (the sum of both chains for a
  blood pressure), not a clock: a phone clock set back would otherwise give a correction a
  lower version, and Health would keep the old value (Codex review 2026-10-21).
- **Nothing the save path would refuse is written** (US-25 AC14b, break-it pass 2026-10-31):
  `deviceWrites` skips a row that fails `measurementValueFault`, the check typed values and
  imports already pass, so the ranges stay in health-core and Swift holds no copy. Skipped,
  never clamped: a clamped number would be a value the person never entered. A blood
  pressure the wrong way up (`pressureInverted`, US-02 AC8) is skipped too, both halves.
  When the newest version of a value turns bad, nothing is written for it, so Health keeps
  the earlier sample: skipped, never clamped or deleted. A record with
  thousands of typed days still writes each once on first connect; the per-version memory
  keeps later launches from writing them again.

**Built 2026-10-21 (app).** `HealthRoadmap/Health/`: `HealthKitClient` is the only file that
touches HealthKit (types, SI units, anchored queries, observer queries, saves), behind the
`HealthStoreClient` protocol so the tests run on a fake. `AppleHealthSync` keeps its state
on the main actor and awaits HealthKit and the engine. An import and a typed save never
overlap because an import goes through `RecordStore.applyNow`, in the store's one ordered
line (`chain`), not because of the main actor; a refresh asked for during one loops once more. Its decisions:
- **An import takes the typed values' path** (`RecordStore.applyNow`, 2026-10-21, after the
  merge with cloud sync): in the cloud it goes through `cloudEdit`, so the session's save
  loop, merge and erase guard apply. It is checked against the erase and units shown at
  that moment, not a sheet's pin (D5's sheet rule; an import is not a sheet). A refusal
  asks cloud sync to re-read and tries once more; a second keeps the anchor. A batch that
  changes nothing is not saved, on the phone or in the cloud (`cloudEdit` returns early).
- **Anchors and the written versions live in UserDefaults** (`HealthSyncMemory`), not the
  record: they are this phone's bookkeeping. An anchor moves only after the record holding
  that batch is on disk; a refused or failed save reads the batch again.
- **No anchor is kept until a kind has given a whole reading** (for blood pressure, both
  halves). iOS answers a refused read with an empty result, not an error; keeping that
  anchor would skip every older reading once the person allows it in Settings (found on the
  simulator 2026-10-21). Limits: a read turned off and on again later misses what arrived
  while it was off; a kind holding only our own samples re-reads its history each time
  (cost only); a reading the engine skips (out of range, or timed ahead of the phone) is not
  offered again; and once blood pressure has an anchor, readings that arrive while the
  person has turned one half off are refused as half pairs and not offered again.
  Simulator gotcha: versions written before the chain-length rule were milliseconds, so a
  simulator that ran an earlier build needs the app deleted before testing corrections.
- **Our own samples are never read back:** our bundle id, or our `healthroadmap:` sync
  identifier prefix (a sample our app wrote on the person's other iPhone, synced by Health).
- **Locked phone:** HealthKit's `errorDatabaseInaccessible` becomes "waiting for unlock";
  the anchor stays, and the next unlock (`protectedDataDidBecomeAvailable`) or return to
  the foreground retries. Observer queries with background delivery wake the app for new
  data; iOS is told the work is done only after the import saved (a refresh asked for
  during one waits for it).
- **Writes**: once per (sync id, version); a kind the person did not allow is skipped; one
  that Health refuses is retried next time and does not hold back the others. A typed
  value has a day, not a time, so Health gets noon of that day, or now if noon has not
  come. Height is read, never written, and the sheet does not ask to write it.
- **Blood pressure on the simulator (iOS 26.5): not checkable.** The app asks for both
  halves (HealthKit's log: "Requesting prompting authorization to share (…BloodPressure
  Diastolic…Systolic)"), but the simulator's permission sheet leaves them out ("Ordered
  read" lists only height, waist and weight), so blood pressure is neither read nor
  written there. Weight in and waist out were checked; blood pressure needs a real iPhone.
- **Erase (D5, US-25 AC16) deletes our samples from Health** (built 2026-10-21): every
  sample whose source is this app, which is every `healthroadmap:` sync id, and clears
  `HealthSyncMemory`'s written versions. Checked against a fake store only.

**Entitlement.** `ios/HealthRoadmap.entitlements` (HealthKit, with background delivery, and
`com.apple.developer.healthkit.access` = `health-records` since US-72) is set as
`CODE_SIGN_ENTITLEMENTS`; the purpose strings are `INFOPLIST_KEY_NSHealthShareUsageDescription`,
`...UpdateUsageDescription` and `...NSHealthClinicalHealthRecordsShareUsageDescription`. The simulator
build signs it locally with no team. **For Brad, once the Apple Developer team exists:** set
the team in Xcode (Signing & Capabilities), confirm the App ID `com.drstanfield.healthroadmap`
has the HealthKit capability (Xcode adds it when signing automatically), and test the
background delivery and blood pressure both ways on a real iPhone: the simulator shows
neither. App Store Connect's privacy answers must list Health data (read and written, not
linked to tracking, kept on the device), the review notes should say why the app reads
Health, and a HealthKit app needs a privacy policy URL. The read purpose string says the
values go only into the person's record, on the iPhone or in the Dropbox or Google Drive
they connect (changed at the cloud-sync merge, 2026-10-21). Health values reaching chat, as
part of the record's summary, are a guideline 5.1.3 disclosure question for the chat consent. Whether a device backup counts as "iCloud"
under 5.1.3 is the D5 backup question, still open.

**For Brad: Health Records (US-72).** In Xcode, target HealthRoadmap, Signing & Capabilities,
HealthKit: tick **Clinical Health Records** (it writes the `health-records` value already in
the entitlements file; Xcode then updates the App ID on the developer portal when signing
automatically). Then archive and upload as usual. App Store Connect: the privacy answers add
health records (read, not linked to tracking, kept on the device or the person's cloud), the
privacy policy says so, and the review notes say why the app reads lab results (the plan's
suggestions) and that the import sends nothing to Brad's server: the results stay in the
person's record, and go with a chat question only when the person uses the chat (US-72 AC11;
the purpose string says so). **Not confirmed (no developer
account access from here):** whether the App ID shows a separate Clinical Health Records
switch on developer.apple.com, whether Apple asks for any request or approval before a
health-records build is accepted, and whether an existing provisioning profile must be
regenerated by hand. Ship it in its own build, so a rejection holds back nothing else.

**Blood tests from Health Records (US-72, built 2026-11-02; plan:
[docs/drafts/apple-health-blood-tests.md](../docs/drafts/apple-health-blood-tests.md)).**
Apple offers Health Records in the US, UK and Canada; records are FHIR, read-only.
- **Asked only where it works:** `HKHealthStore.supportsHealthRecords()` true adds
  `labResultRecord` to the read set of the one request (D12's one step; Health shows it on
  its own sheet). Elsewhere nothing asks and no read runs.
- **Asked once on coming forward (review 2026-11-02; once only since 2026-11-09):** a person
  who connected before this build is never shown the sheet by the one request.
  `AppleHealthSync.foreground` (the app's `follow`, never a background wake, where no sheet
  can show) asks for lab results alone when Apple Health is connected, `supportsHealthRecords`
  and `statusForAuthorizationRequest` says `.shouldRequest`, then refreshes. It asks at most
  once per phone: a TestFlight tester with no Health Records account was asked on every open,
  because HealthKit stays at `.shouldRequest` when there is no account or the sheet is closed
  without a choice. `HealthSyncMemory.labResultsAsked` holds the date the lab results sheet was
  last shown (by connect, by coming forward or by Settings' row); once set, coming forward
  never asks. Someone upgrading from an earlier build has no date yet, so they may see the
  sheet once more on their first open after the update. "Ask Before Sharing" people get no
  automatic ask for later results. Settings' "Share new lab results" row (US-72 AC14, shown
  when connected and `supportsHealthRecords`) can still show Apple's sheet when HealthKit
  says one is needed, then refreshes. A deliberate connect can still show it too, but once
  connected the live cards' Turn On shows only while the live types are due. No screen of
  ours comes before the sheet (guideline 5.1.1).
- **Rules version:** `HealthSyncMemory.labResultsRulesVersion` (3 since 2026-11-10: results
  contained in a DiagnosticReport, US-72 AC15; 2 since 2026-11-02: results
  dated by `issued`, the MDRD eGFR and the import winning a conflict), stored beside the anchor.
  Bump it when the engine starts reading results it used to refuse (a new code or unit): a
  phone whose anchor was kept under another version drops it once and reads every result
  again. AC5's dedup by `externalId`, and its stale-version rule, make the re-read safe.
- **One blood-test table (US-66, merged 2026-11-03):** every result lands in `labValues`, a
  core test as a core row (`createCoreRow`: `core: true`, its key, its SI unit), so the
  record's own write stamp makes it `schemaVersion` 3; `measurements` gets nothing from the
  import. Its slots, identities, corrections and markers all live in `labValues`, where a
  typed core value now lives too.
- **Swift parses nothing (D2):** `HealthKitClient.labResults` is an anchored query; each
  record goes to the engine as `{ sourceId, resourceType, fhirVersion, json }` (the
  `healthRecords` edit). `sourceId` is the sample's source bundle id (`com.apple.public.health.clinical.<UUID>`,
  one per institution account; seen on the simulator 2026-11-02): Apple says a FHIR id is
  unique only per type and source. The institution's name stays out of the record. The engine (health-core) reads the JSON and decides what lands, with its counts
  (`added`, `corrected`, `withdrawn`, `alreadyInRecord`, `notRead`).
- **The import is the source of truth (Brad 2026-11-02, US-72 AC3, AC6, AC8, AC9):** the
  day is `effectiveDateTime`, else `effectivePeriod.start`, else `issued`. A result whose
  day holds a typed, uploaded, hand-corrected or Apple Health row with another value, unit
  or comparator corrects that row (FHIR correction, its day kept); the same value appends
  nothing. A version dated by `issued` alone keeps the day its result already holds: `issued`
  is that version's release, so an amendment's later one is not a move (AC3). A newer version
  with the same value, unit and comparator, and a lab's withdrawal, append a **version
  marker** (AC5): a `health_records` row born `entered-in-error` on the result's test and
  day, carrying the content of the version it records (the new version's value, unit,
  comparator and range; a withdrawal's marker keeps the withdrawn row's), the new version in
  its `externalId` and `correctsId: null` (merge reads no
  `correctsId`, so it flips nothing on any device). A marker's `externalId` ends `|m` after
  the version (`identity#version|m`), so it is known by its id, never guessed from its content
  (Codex R2, adversary R3). The record remembers the version, so an
  older one seen later is stale, and the person's rejection or hand edit stands; only another
  value, unit or comparator lifts a rejection or overrides. After the lab's own withdrawal,
  its newer version lands whatever its value (AC8). A withdrawal already in the record flips
  an active copy a merge brought back only when that copy is not newer (AC7). A version that
  moves the result to another test or day is not read, active row or not (AC6). The history
  (`metricHistory`) leaves markers out with health-core's `isVersionMarker(row)`; readers
  skip them as any `entered-in-error` row. Known limit (adversary R4): a result dated by its release day can
  sit on another day than the same draw typed on the draw day, so both stay active.
- **Same line, same anchor rules as vitals:** `RecordStore.applyNow(.healthRecords(_))`, its counts in `ApplyResult.saved`; the store's
  one ordered line; the anchor (`HealthSyncMemory.labResultsAnchor`) moves only after the
  record holding the batch is saved, and none is kept until a batch brought results (the
  empty-refusal rule above). Locked phone: as vitals. Deletions in Health are ignored.
- **Observer and background delivery** are registered for the clinical type beside the
  vitals. Whether iOS delivers in the background for clinical types is not documented, and
  the simulator does not run background delivery at all (Apple), so it is unchecked; the
  unlock and foreground refreshes cover it either way.
- **Usage signal (D9):** "Health Records asked" when HealthKit said the lab results request
  was needed (`statusForAuthorizationRequest` before asking), "Health Records imported" when
  a batch's `added + corrected > 0`.
- **Checked on the simulator 2026-11-02 (iOS 27, region US, Sample Institution A added in
  Health › Browse › Health Records › Add Account).** The one request shows Health Records'
  own sheet FIRST (how sharing works, the accounts, "You Should Know", Lab Results with our
  purpose string and Privacy Policy link, then "Automatically Share" or "Ask Before Sharing"
  for new records), then the vitals sheet. The app read 3 results, source
  `com.apple.public.health.clinical.<UUID>` (the record keeps the bundle id only; the
  institution's name, "Sample Location A", is left out), all DSTU2 Observations. None
  landed then: all three carry `issued` and no `effectiveDateTime`, which AC3 refused (one is a
  panel with no value). AC3 now reads `issued` (Brad 2026-11-02); "rows appear in My data" is
  not yet re-checked on the simulator.
- **Import before the cloud record: intended (adversary R3, 2026-11-02; Brad 2026-11-03:
  "remember that the Apple Health import is the source of truth. So if that brings back
  deleted values, that's fine.").** A phone that imports Health Records before it connects
  its cloud record writes those results with new row ids, and at first connect the cloud
  copy holds the same results under other ids. The merge then decides, not the import's
  rules: the newest-written row (`createdAt`) wins a slot. So the merge can bring back a
  result the person deleted or withdrew (a second active row of the same version), and an
  imported result can outrank a value typed on the same day. Both are meant: the import is
  the source of truth (AC9). A lab's re-sent result after its own withdrawal also beats the
  person's earlier deletion (AC8; Brad 2026-11-03: agreed). A result whose day a typed or
  uploaded row won in a merge (that row does not correct the result's newest landed version,
  through any chain of corrections) lost a merge, not a person's call: the lab's next version
  corrects that row when the value differs, and lands a marker when it matches (AC9,
  adversary R2). A correction of an older version that a merge put over the lab's amendment
  is such a lost merge too (adversary R1). Two explicit choices of the person look the same,
  so a lab version with another value overrides them: deleting the imported row then typing
  a value on that day, and moving another day's value onto the result's day (Brad: the
  import is the source of truth). **Still a known limit, beside
  Brad's rule:** an erase admits the lower-epoch side's rows written after it, so the merge
  can return results drawn before an erase (AC10); the fix is merge-class work, Brad's call.
  US-72 AC5, AC8, AC9 and AC10 claim their own rules only on a phone that already holds the record.
- **Gotcha:** an onboarding UI test that waits for the vitals sheet
  (`UIA.Health.AuthSheet.AllCategoryButton`) meets the Health Records sheet first on a
  simulator where `supportsHealthRecords()` is true (a US region, or an account added).

**Writing.** Values typed in the app go to Apple Health. The sync identifier is the root id
of the correction chain, with a rising version, so a correction replaces our sample instead
of adding a second. Only the active row of a slot is written, and rows that came from Apple
Health are never written back.

**Background.** Observer queries recompute the plan and reschedule reminders when data
lands. HealthKit is unreadable while the phone is locked, and a background import must not
race a foreground save: both are handled, not assumed.

**Checked 2026-10-22.** On the iPhone, iOS 27's Health sheet adds a second page ("how much data
would you like to share": past 30 days, or all recorded data); the app needs all. Onboarding then
preselected sex, birth month and year, height and weight, each labelled "From Apple Health".
Write-back checked on the simulator's own Health store: a typed 123/79 and 70 kg appeared in Health,
dated noon of the day (the record holds days, not times); height is never written back. **Next
(US-56, Brad 2026-10-23; replaces US-55):** heart rate, resting heart rate, sleep with Apple's
stages, VO2 max and steps, read live from HealthKit each time they show and never stored (since
2026-10-27 the cards' last readings are kept on the phone, below), so the
record, merge, website, chat and engine never see them. Display only; no heart rate variability.
Access is asked in onboarding's one Apple Health request, with D6's types (Brad 2026-10-26: "just
do it in one step"; it replaced asking later from a card on My data). Heart rate, resting heart rate
and sleep sit in Vitals under blood pressure; VO2 max and steps under a new Fitness heading. Since US-73 (2026-11-05) sleep sits under Sleep and VO2 max, resting heart rate and steps under Fitness; heart rate is gone (Brad dropped its card, round 4), so it is no longer read or kept, and a launch deletes its kept history once (`LiveHistory.forgetDropped`).
VO2 max shows FRIEND fitness bands for the person's age and sex (the bands note under D2).

**US-56, built 2026-10-25 (phases 1 and 2), on My data.** `HealthRoadmap/AppleHealthMetrics/`:
- `LiveHealthStore` is the protocol; `LiveHealthKitStore` the only code reading HealthKit for these
  four types, on its own `HKHealthStore` (heart rate dropped, US-73, 2026-11-05). It names exactly resting heart rate, sleep
  analysis, VO2 max and step count (`readTypes`), shares none, and never asks for them itself:
  **one request (Brad 2026-10-26):** `HealthKitClient.requested` is the union of D6's types, sex and
  date of birth, and `readTypes`, and `HealthKitClient.requestAuthorization` is the app's only Health
  request (`LiveHealthStore` has no request at all; an advisory source scan allows only it and
  the DEBUG seed). Both sets are `static let`, and all three share one `HKHealthStore.app`, as
  Apple recommends. So onboarding's Apple Health page (its Continue), My data's Apple Health row and the
  Turn On row all show one sheet; iOS lists only the types not yet asked, so a person connected
  before 2026-10-26 sees just the four. `AppleHealthSync.connect()` is the one connect: it holds the
  app's `LiveHealth` (given once, in `AppParts`), so the cards read as soon as the sheet is answered, beside the import. It uses
  `statusForAuthorizationRequest` on the four for the Turn On row; a status check that throws keeps
  the answer `LiveHealth` had, so the row never flashes (adversary R4). Every call is
  `@concurrent`: HealthKit and the maths run off the main thread. HealthKit's statistics collection
  queries do the daily and hourly maths, chosen by each metric's `aggregation` (`.sum` steps,
  `.mean` the others); sleep is a category sample query. The same field picks the headline, the
  mark, the y-scale and the audio graph's series. (`.range`, heart rate's min, max and average,
  and its newest-sample card went with heart rate, US-73 round 4.)
- **One calendar (adversary R2, 2026-10-25):** `Calendar.autoupdatingCurrent`, made once in
  `AppParts` and given to both `LiveHealthKitStore` (the statistics' day and hour anchor) and
  `LiveHealth` (days, nights, labels), so a trip to another zone never labels a day with the
  zone the app launched in.
- `LiveMaths` (pure, tested) buckets days into weeks and months, works out the headline in view,
  the cards' latest and trend, and sleep's nights. A night recorded only as "In Bed" shows its time
  in bed, on the card and the page (Codex R3). A night runs 6 pm to 6 pm in the phone's zone
  and is dated the morning it ends; the cut is the local hour (`component(.hour) >= 18`), not six
  hours of seconds, which a clock change at midnight shifts (America/Santiago, adversary R5). A
  night dated after today (a nap after 6 pm) stays off the card and off the night D opens on
  (`newestNight`, adversary R3). Several writers can record one night and Apple's source order
  is not readable, so the writer with the most staged time draws the stages; with none, every
  writer's "asleep" is joined; "In Bed" comes from all. Overlaps count once.
- `LiveHealth` (`@Observable`, main actor; one per app in `AppParts`, in the environment) holds only
  the access state and the cards. **The cards' last readings are kept on the phone (US-56 AC2, AC15;
  Brad 2026-10-27, option A).** Why: on a cold start My data drew the record, then 0.1 to 0.2 s later
  the cards arrived under blood pressure and pushed the blood tests down; Brad: "I don't want us to
  wait for anything." The cards (`[LiveMetric: LiveCard]` and a version) live in
  `Application Support/Apple Health/last-readings.json` (`LiveHealth.keptFile`), a folder made by
  `RecordStore.appFolder(named:)`, so it is left out of backups as the record's is, but apart from
  it: sync, export and the chat summary read only the record, so they never see it. Written
  atomically, `.completeFileProtectionUntilFirstUserAuthentication` (a launch after the first unlock
  reads it). Read synchronously in `init` (a few hundred bytes), so the first frame has the cards;
  a missing, damaged or other-version file is none. Kept cards count as access granted and read, so
  `LiveCardsSection.shown` draws them, never the Turn On or Open Settings row, until the first read. A read that
  changes the cards replaces the file (`keep`), one with none always deletes it (even a file the
  launch could not read, adversary R3), a locked or cancelled read changes nothing, a sheet due
  again deletes it, and `DataEraser` calls `forget()` (file gone, cards empty, nothing shown until
  the next read). `forget()` bumps a generation: a refresh begun before it, and one queued during
  it, keeps nothing (Codex R1, adversary R4). The file holds each card's trend values too (up to
  30 daily values, or the last seven readings), so the trend line draws in the first frame. Since 2026-11-03 each page's days, its last week of hours (D) and sleep's samples are kept too (`LiveHistory`, below). "Today",
  times and the VO2 max band are worked out at draw time from the card's date and `now`. The app
  has no Apple Health disconnect of its own (access is changed in Settings), so the erase and an
  empty read are the only other reset paths. Rejected: UserDefaults (it is backed up and is the
  app's settings), and drawing a placeholder per metric (it would show cards a person never had). Each card starts from the metric's newest sample
  however old (`LiveHealthStore.latest`), then reads the 30 days ending on it (sleep too, since
  2026-10-26); a fixed window back from today dropped a VO2 max from six weeks ago (Codex R2).
  The trend is the last 30 days' readings, or the last seven however old (US-56 AC14); only a
  card with fewer than two readings in its 30 days and fewer than seven read reads further back
  (400 days before its window; sleep, the 200 nights before today, or back to its first
  read's start when that is older), and a read-back that
  fails or finds nothing more keeps the first card.
  No record row, UserDefaults value, log or telemetry, and no file but the kept cards (a source-scan
  test enforces it). A
  locked phone's read keeps the cards. A return to the app (My data's `scenePhase`) or an unlock
  calls `wake()`, which bumps `wakes` and refreshes; an open page reads again on each wake (Codex
  R1). A second wake within about 2 s is the same one, and a refresh asked for under 2 s after a
  running read began is that read (E1); unchanged results are not written (E5).
- Views: `LiveCardsSection` (one view for Vitals' and Fitness's cards, reading `LiveHealth` from the
  environment), `LiveCardView` (on `CardShell`, the card a vital's `ValueRow`
  draws too; both write the day as Apple Health's cards do: Today, Yesterday, then the short date,
  `DayText.when`), `LiveMetricPage` (D, W, M, 6M, Y; bars, low-to-high bars or points; read-only) and
  `SleepPage` (D's stages over the night, W/M/6M stacked nights with stage averages, its chart its
  own view, E3). Both pages share `LivePageFrame` (picker, empty line, footnote, read, range
  reset), `ScrollingChart` (axes, scroll, scrub, haptic, calendar) with `SelectionRule`, and
  `PageHeadline`, which `MetricDetailView` uses too. Every metric page, MetricDetailView's included, takes `metricPageList` (inset grouped, inline title, an 8 pt top margin so the picker sits under the title; Brad 2026-10-25). While the sheet is still due for the four and Apple Health is connected (so only for someone connected before 2026-10-26) Vitals shows `LiveReconnectRow` with **Turn On** (US-56 AC5; the "Show from Apple Health" card is gone; not connected, My data's Apple Health row is the one way in), and after "Don't Allow" (or an empty Health) the same row with **Open Settings** (AC5b; "Reconnect" until 2026-11-01, AC5c). Turn On runs `connect()` on the known answer; Open Settings checks the status afresh and runs it while the sheet is due, else opens Settings (`LiveReconnectRow.action`); Settings opens at its top and iOS 27's app page there has no Health row, so the row names the path, chosen by OS (`LiveFooter.healthPath`: Settings › Apps › Health › Data Access & Devices › Health Roadmap from iOS 18, Settings › Health › … on iOS 17). **A page always shows its card's reading
  (Codex R2, adversary R7):** it holds the metric's whole history, from its oldest sample
  (`LiveHealthStore.earliest`, never before 2014), by day as HealthKit sums or averages it, so a
  decade is about 3,650 points; sleep keeps every night's samples. **Decision, 2026-11-03 (US-56
  AC7a): the histories are kept on the phone.** Why: Brad found VO2 max stopped a year back while
  Weight scrolled to its first reading, and reading a decade of resting heart rate or sleep each time a
  page opens is slow ("store it so that we can quickly load it and we don't have to keep fetching
  it. And that load needs to not be in the user interface main thread"). This reverses AC2's
  2026-10-27 line that pages are read fresh. How: the `LiveHistory` actor keeps one file per
  metric (`history-<metric>.json`, sleep's holding its samples) and its last week of hours
  (`hours-<metric>.json`, for D) beside the cards' file, under the
  same rules (out of backups, complete-until-first-unlock, apart from the record, deleted by Delete
  all my data, access reset or an empty Health). A page draws the kept history first; with none
  (a first visit) it draws 400 days (sleep 200 nights) while the whole history is read and kept;
  later reads ask HealthKit only what changed since the kept anchor (an anchored query): added
  samples re-read just their days; sleep's samples are added or removed by id; a deleted day
  sample (HealthKit gives only its id), a change list past 5,000 or a new time zone reads the
  days in full again. Each file records its zone. Decoding, merging,
  grouping nights and writing run on the actor, never the main thread. Rejected: two reads per
  visit (fast first draw, then the full read) still re-read years each time; SwiftData or a
  database was more machinery than five small JSON files. It opens with the reading in
  view (`LiveChartGeometry.opening`, the window's own length so a 31-day month still holds it),
  reads D's hours a day at a time as the scroll reaches a day (D scrolls a week back, or to the reading's day: a 400-day hourly domain took Swift Charts several seconds to lay out on the simulator), and reads the days only once the
  range leaves D (E4). Its bars live in `@State`, rebuilt after a read or a range change (E2). The
  audio graphs describe what is in view (adversary R8) and say "Time in bed" for In Bed-only nights. Colours: five entries in `MetricChart.palette`
  (checked by `MyDataLayoutTests` with the rest); Apple's stage colours by eye, to match on a real iPhone.
- My data: `LiveCardsSection(metrics: .vitals)` right after the vitals (so under blood pressure),
  then `LiveCardsSection(metrics: .fitness)`, both before Blood tests; tour tip 3 still anchors to the Blood tests header
  (the tour UI tests pass). A tap pushes `LiveHealthPage` through My data's own
  `navigationDestination`; My data reads Health on `.task` and on return to the app.
- Usage signal: `Analytics.Screen.appleHealthMetric` ("Apple Health metric"); `LiveHealth.pagesOpen`
  counts open pages, and RootView names the My data tab by it.
- Guides (US-58 AC7, Brad 2026-10-31): each page ends with its health-core guide, the same `GuideSections` as a
  record metric's page. `LivePageFrame` draws it last; `MyDataView` hands it in from My data's `guides` by
  `LiveMetric.guideKey` (the snake-case key, as `paletteKey`). No engine change: the engine already serves every guide.
- Simulator seeding: `App/LiveHealthSeed.swift`, DEBUG only (`#if DEBUG`, never in a release build):
  `--seed-live-health` asks to write the four types and saves three years of every metric in
  batches of 5,000 (a page keeps and scrolls a long history, AC7a). A sheet asked for during launch is dismissed by iOS, so it waits 4 s. Apple's
  sheet in iOS 27 answers by "Select All", "Continue", "All Recorded Data", "Allow"; a UI test can
  tap them only by screen point (the sheet reports its frames at a third of screen points).
- Purpose string: the six "go only into your record"; the four are kept only on this iPhone, never in the record (AC10, AC2 since 2026-10-27).
- **AC8 built 2026-10-26 (Brad: "do it. we want the bands").** Apple publishes only the Low rule
  (white paper, May 2021: lowest FRIEND quintile for sex and decade at 20 to 59, Kaminsky 2015;
  below 18 mL/kg/min for men and 15 for women at 60 and over), so the page shows FRIEND 2022
  percentile bands instead (Kaminsky 2022, Table 3, treadmill), which can differ from Apple's alert: Low
  below P20, Below Average to P50, Above Average to P80, High from P80, ages 20 to 89. Shaded
  behind the chart with a legend; the card names the newest reading's band. The copy never calls
  them Apple's. Table and route: the bands note under D2.

### D7 · Reminders: on-device notifications only (Brad, 2026-10-21)

App users get local notifications computed from `reminder-schedule.ts`, with no server and
no email. iOS holds at most 64 pending notifications, so the app schedules the next batch
and refills on launch and on new data. What a lock-screen notification says ("Colonoscopy
due") is visible to anyone holding the phone: the wording is a decision for the build.

**Built 2026-10-21 (US-25 AC12).** Decisions taken while Brad slept, for him to revisit:
- **What is due is the engine's.** `ios/engine/reminders.ts` calls health-core's
  `computeReminderSchedule`, the schedule the web pushes for its emails (per-category
  preferences, annual floor, nothing for a minor), and adds only the notification days.
  Swift compares no dates.
- **When it notifies.** On the due day at 9:00 on the phone's clock, then again every
  cooldown of its group (the email cron's `GROUP_COOLDOWNS`: screenings 90 days, blood
  tests 180, reviews and the annual check-in 365) while it stays due, up to two years
  ahead. The phone keeps no "last sent", so repeats count from the due day: the same
  record gives the same days on every refill, and an item already overdue waits for its
  next step instead of firing on every launch. Today is kept (review fix): opening the
  app that morning must not drop the 9:00 reminder, and iOS never fires a one-off trigger
  whose hour has passed. The in-app list shows due items as "Due now", the rest as "Mar
  2027" (health-core's `formatReminderDate`, the web's email format).
- **The annual check-in slides**, as on the web: it is a year from the last time the app
  computed it, so a user who opens the app once a year never gets it. A user enrolled in
  the web's emails who also turns on phone reminders is reminded twice; no dedupe.
- **Lock-screen words: generic.** Title "Health Roadmap", body "A check-up is due. Open
  the app to see which." The procedure's name is shown only inside the app. Revisit if
  Brad prefers the name ("Colonoscopy due") on the lock screen. The in-app list names a
  follow-up after an abnormal result as its plan card does ("Follow-up to organize:
  repeat colonoscopy", "Follow-up check-in: colposcopy"; US-17 AC15 and US-25 AC27, approved by Brad 2026-11-05), from
  `followupKinds` on the phone's own record; the lock screen stays generic (Brad
  2026-11-05) and the pushed web schedule keeps the plain label.
- **Follow-ups fire the first morning they are seen** (US-17 AC15, Brad 2026-11-05). A
  follow-up's due day is already past, so counting from it would wait up to 90 days. The
  app keeps the day each follow-up was first seen in `reminders-first-seen`, beside the
  opt-in in the folder backups leave out (D5), and sends it back through `remindersJson`'s
  optional `firstSeenJson`; the engine fires that morning (or the next if 09:00 has
  passed, `NOTIFY_HOUR`, pinned equal to `ReminderScheduler.hour` by a test), or on its due
  day if later, and every 90 days from it. Cleared whenever reminders are off, refused or
  erased, even if the engine failed; an item no longer a follow-up drops its entry; a lost
  entry fires once more, never in a loop; a kept day in the future heals. Never sent anywhere.
- **Rebuilt from scratch** on launch, on return to the foreground and on every record
  change: remove our pending ones (ids start `reminder.`), add the soonest 64. One
  notification a day, however many things fall due on it (the words are generic, so two
  would be the same banner twice); ids are `reminder.<day>`, stable across refills.
- **The opt-in is this phone's, not the record's.** It is a small file
  (`reminders-opt-in`) beside the record, in the folder backups leave out (D5), holding
  the record's erase epoch when it was given. A phone restored from a backup starts a new
  record and so starts with reminders off (UserDefaults would have carried a stale
  opt-in across; review finding). Not keyed on `meta.createdAt`: a merge takes the
  earliest across devices, so cloud sync would silently turn reminders off. The task asked for health-core's `setReminderOptIn`, but that
  singleton is the web's email enrolment: it carries a server token, an address and a
  cloud provider, and the web reads `status: 'active'` as "this address gets emails". A
  phone writing it would put a fake enrolment in a synced record. Notification permission
  is per device anyway. If Brad wants one switch for both, it needs its own field in the
  schema (a merge and schema call, so the orchestrator's).
- **No per-category switches.** The web has none since its v1 settings went; the schedule
  still honours any `reminderPreferences` already in the record.
- **Erase (US-11).** When the record's erase epoch moves (an erase here or one synced in),
  the opt-in ends and every pending reminder is cancelled; the user turns reminders on
  again. This assumes an erase bumps the epoch and never deletes the file for a fresh
  one at epoch 0: the in-app erase (built, D5, US-25 AC16) uses health-core's `erase.ts`. An
  unreadable record cancels them all for that round but keeps the opt-in; the next good
  read schedules again.
- **Permission.** A refusal points to Settings; "not asked yet" (Settings has no switch
  for the app until it asks) offers "Allow notifications" instead.
- **A tap opens My plan**, cold start included (`ReminderTaps` is the notification
  delegate from launch, with the completion-handler callbacks). Not yet checked on a
  device: the agent's simulator could not tap Allow.

### D8 · Chat and lab upload: no user sign-in; the app proves itself with App Attest (Brad, 2026-10-21; designed 2026-10-21, US-52)

Chat and lab extraction run on Brad's server, because they call Anthropic with a key the
phone must never hold. The user does not sign in. The web stops strangers spending the
Anthropic budget with Shopify's app-proxy signature, which the app cannot produce. The
app's endpoints are on the public internet, so "it runs on iOS" secures nothing. The design
below is the gate: Apple's **App Attest** plus limits.

**Endpoints** (on the education app, `health-tool-edu`, so chat gets the doctor posture).
Under `/api/app/v1/`, not `/app/...`: `app.tsx` is the Shopify admin layout, and a route
nested under it would sit behind admin auth.
- `POST attest/challenge` → `{ challenge }`.
- `POST attest/register` `{ keyId, attestation, challenge }` → `{ ok }`.
- `POST chat` (NDJSON stream, the widget's events) and `POST lab-import` (JSON).
- The same source deploys to the commerce app too. The app routes answer 503 there:
  they refuse to run when `CHAT_SURFACE` is `brand` (adversary R13).

**Threat model.**
- *Asset:* the Anthropic budget and the server's capacity. Secondary: the health context
  in transit (TLS; never stored), and the key table (public keys only).
- *A1, a script that copied the URL:* has no attested key, so every request is a 401 and
  no model is called. This is the case the gate exists for.
- *A2, a replayed or altered request:* TLS hides it; the assertion signs the method, path
  and body hash, so an altered body fails; the counter must rise, so a replay fails.
- *A3, a genuine device driven by a script* (a jailbroken phone hooking the app, or a
  person with a device farm): App Attest cannot tell. Each device can mint many keys.
  Bounded by limits: registrations per IP, turns and files per key and per IP, and a daily
  ceiling per machine. The ceiling is the worst case Brad pays, by design.
- *A4, the dev bypass left on in production:* the bypass needs two things, an explicit flag
  AND `NODE_ENV !== 'production'`; Fly's Dockerfile sets `NODE_ENV=production`, and a test
  proves production refuses the header with the flag on.
- *A5, abuse of the model itself* (prompt injection, crisis text): the same pipeline and
  guardrails as the web's widget turn, unchanged.
- *Not defended:* an attacker with many real devices on many IPs can spend up to the daily
  ceiling. Apple's attestation receipt carries a fraud-risk metric (how many keys a device
  minted); using it is a later step.

**Registration flow.**
1. The app asks for a challenge. It is stateless: 16 random bytes, an expiry 5 minutes
   on, and an HMAC over both with a key derived (HKDF, label `app-attest-challenge/v1`)
   from `SHOPIFY_API_SECRET`, as the guest IP hash derives its key. No table.
2. The app makes a key (`DCAppAttestService.generateKey`), keeps its id in the Keychain
   (this-device-only), and attests it over `clientDataHash = SHA256(challenge)`, where
   `challenge` is the base64url string exactly as the server sent it, hashed as UTF-8
   bytes (pinned, adversary R3). Registration attempts are counted per IP before they
   are verified.
3. The server checks, in order: the challenge's HMAC and expiry; the CBOR shape
   (`fmt: apple-appattest`); the x5c chain (leaf, intermediate) up to the **pinned** Apple
   App Attestation Root CA (SHA-256 fingerprint
   `1C:B9:82:3B:A2:8B:A6:AD:2D:33:A0:06:94:1D:E2:AE:4F:51:3E:F1:D4:E8:31:B9:F7:E0:FA:7B:62:42:C9:32`),
   each certificate in its validity window; the leaf's extension
   `1.2.840.113635.100.8.2`, a DER `SEQUENCE { [1] { OCTET STRING } }`, holds
   `SHA256(authData || clientDataHash)` in that inner octet string (never the raw
   extension bytes); the key id
   equals `SHA256` of the leaf's uncompressed public key; `authData.rpIdHash` equals
   `SHA256(teamId + "." + bundleId)`; the counter is 0; the AAGUID is the environment's
   (`appattest` + 7 zero bytes for production; `appattestdevelop` only when
   `APP_ATTEST_ALLOW_DEVELOPMENT=1`); the credential id equals the key id.
4. It stores the key. A key id already stored is refused (409): a replayed attestation
   cannot reset a counter. Challenges are not single-use; the 5-minute expiry plus the
   key-id uniqueness is the replay bound, and a stolen challenge is useless without a
   genuine device to attest with it.

**Request flow.** Every chat or lab request carries `X-App-Attest-Key` (the key id) and
`X-App-Attest-Assertion` (base64 CBOR `{ signature, authenticatorData }`). The app signs
`clientDataHash = SHA256("<METHOD>\n<path>\n<hex SHA256 of the raw body bytes>")`
(UTF-8). The server, in this order (adversary R2): checks the header shapes, parses the
assertion's CBOR and its `rpIdHash`, and loads the key (one primary-key read), all before
it reads a byte of the body. Only then does it read the raw body against the route's cap
(chat 2 MB; lab 25 MB, one file's pages, not the web batch's 200 MB), hash the bytes as
received, and verify the ECDSA P-256 signature. The signature is over
`nonce = SHA256(authenticatorData || clientDataHash)` by a key that hashes its input
again, so the check is `verify('sha256', nonce, ...)` (pinned, R3). Then one SQL function,
`app_attest_use`, advances the stored counter only if the new one is higher AND counts the
use against the key's daily cap, in one row-locked statement, and says which: `ok`,
`stale`, `limit` or `unknown`. Only then do the per-IP and per-machine limits run, and only
then the model. A key whose environment the server no longer accepts (development, once
the flag is off) is refused too (R10).

*A deliberate deviation from Apple (R10):* Apple's assertion step 6 puts a server
challenge in each assertion's client data. We do not, to save a round trip per request.
The rising counter stops replay; what we lose is expiry: an assertion signed but never
sent stays valid until a higher counter passes it. Making one needs the device's key, so
the gain would be small.

The app holds a per-key lock only from signing until the response headers arrive (the
server's counter step runs before any model call), so a long chat stream never blocks the
next request (R14).

**Storage** (Supabase, operational only; migration
the App Attest section of `supabase/rls-policies.sql`, not run by agents): `app_attest_keys` with `key_id`
(primary key), `public_key` (PEM), `sign_count` (bigint: the counter is a uint32),
`environment`, `created_at`, and the day's use counts (`use_day`, `chat_uses`,
`lab_uses`). No last-used time (R12: a per-device activity log sits badly with D9); the
use day is the coarsest thing the per-key cap needs. No IP, no device name, no health
value, no request content. RLS on with no policies, and the function executable by the
service role only. Rows are never deleted by the app; pruning old keys is an ops job for
later.

**Limits.**
- Per key, exact and shared across machines (in `app_attest_use`, R4): 60 chat turns and
  30 lab files per UTC day.
- Per IP, in memory: 10 failed registration attempts and 50 successful registrations
  (US-52 AC1b; a success hands its attempt back, and a store outage or a 409 hands the
  success unit back, an outage the attempt too), 200 turns, 200 files a day. IPv6 is keyed
  on its /64, which one subscriber holds whole, so rotating addresses inside it buys
  nothing. IPv4 is keyed on the address, so phones behind one carrier NAT share a bucket:
  the price of having one; 200 is set high for that reason.
- Per machine, in memory: `APP_CHAT_DAILY_CAP` turns (default 500) and `APP_LAB_DAILY_CAP`
  files (default 300). Lab files also spend the web's per-machine file cap
  (`machineFiles`, `AI_DAILY_FILE_CAP`, 2000), but the app's own cap is smaller, so the
  app can never use up the web's and the connector's uploads (R5); the code also holds it
  at or under 15% of `AI_DAILY_FILE_CAP` whatever the env says. The gate reserves the
  per-IP, per-machine and file-cap units together, all or nothing, before the key's use,
  so the file cap refusing spends no other count (US-52 AC4d, 2026-11-01).
- Per IP, signed requests refused before their signature verifies (a bad or garbage
  assertion, an unknown key, a development key refused, an oversized body, a bad
  signature): 200 a day. Past that, the gate reads neither the key nor the body (code
  review R3).
- Per key, in memory, refusals after the signature verifies (a stale counter, or a key
  gone at the counter step): 20 a day, each handing the IP's unit back, so a broken phone
  whose requests verify stops only itself (US-52 AC4c, 2026-11-01). A key past its 20 is
  refused before the key read, by the header's key id, read-only: no key or body read,
  and the IP's unit goes back. A parallel burst of one key's replays still does its key
  reads, body reads and signature checks before 20 win the reserve. Residual: unverified
  refusals from any client share the IP's 200, so a hostile client behind one IP can still
  lock its neighbours out, after 200 instead of 50. Brad to decide: let a key id that
  verified successfully on this machine in this window skip the IP backstop.
- In memory means cap x machines, reset whenever a machine restarts: on deploy and on
  Fly's idle stop and start (`auto_stop_machines`). The per-key cap holds exactly; the
  machine caps bound the worst case.
- *The dollar worst case is not known yet.* A chat turn is up to three model calls with
  long cached prompts, and an abusive turn can carry the longest history and message the
  web allows. Brad sets the two machine caps from his billing (cost per turn from the
  `chat_timing` log's token counts). The defaults are deliberately low for launch.

**What the server keeps.** Nothing of a turn or a file: no conversation, message, guest
session, match-event or audit row (D9), and no health value in a log. The chat timing log
line (numbers and flags only) and Sentry's fallback report stay as on the web. Refusals
log a closed reason word, never the key id or IP.

**Failure modes.**
- App Attest unsupported (`isSupported` false: simulator, some old devices): release builds
  say chat and upload are not available on this device. DEBUG builds on the simulator use
  the dev header instead (AC3).
- Apple's service unavailable at attest time: "try again later"; no fallback.
- Key lost (app reinstalled: the Keychain id survives, the key does not) or unknown to the
  server (401 `unknown_key`): the app drops the id, attests a new key, and retries once.
  A lost key may fail its assertion with more than one error code, not only `invalidKey`,
  so any failure of the stored key counts as lost, once a launch: a key the launch
  registered is used first, Keychain or not, and never replaced on the phone; it keeps
  failing until a relaunch. A 401 `unknown_key` still re-registers once per request, and
  a registration that fails is not remembered, so the next request tries again: a
  registration the server keeps refusing is retried per report (up to 20 for a 20-report
  ZIP) and spends the IP's 10 failing attempts a day (AC1b), locking out other phones on
  that IP until the next day (US-52 AC1c, 2026-11-09: Brad's reinstalled phone). A failed App Attest call names its step and code on screen ("App Attest assert 3").
- Counter stale (401 `stale_counter`): one retry with a fresh assertion.
- Key store down, or `APP_ATTEST_TEAM_ID` unset: 503. Never open.
- Over a limit: 429 with a plain message; no model call.

**Config.** `APP_ATTEST_TEAM_ID` (no default: Apple enrolment pending; until set, the
endpoints answer 503), `APP_ATTEST_BUNDLE_ID` (default `com.drstanfield.healthroadmap`, the
placeholder above), `APP_ATTEST_ALLOW_DEVELOPMENT`, `APP_ATTEST_DEV_BYPASS`,
`APP_CHAT_DAILY_CAP`, `APP_LAB_DAILY_CAP`. The app's server address is a build setting; the release value is a
placeholder until Brad picks the host.

**Consent** (App Review 5.1.2(i)): before the first chat message, and before the first lab
upload, a screen names Anthropic, says what is sent, that Brad's server keeps none of it,
and that Anthropic handles it under its API terms, which do not let it train on the data,
and may keep it for a limited time (R7: the screen must not read as "kept by nobody";
Brad to confirm the retention wording against his contract). It sends nothing until the
user agrees. The agreement is kept on the phone with a version, so changed wording asks
again, and the chat and upload screens have a "Stop sharing" control that withdraws it.
Before submission Brad updates the privacy policy and the App Store privacy label
(forwarding to a third party that keeps data may count as "collected").

**The plan screen's sentence** (D9, adversary R1): "No health data left your device" is
false once a user has used chat or upload. It now reads "Worked out on this iPhone", which
stays true; the consent screens carry the sharing statement.

**Test vectors** (R3): the tests build a CA, attestations and assertions with openssl from
our reading of Apple's format, so they cannot catch a misreading shared by generator and
verifier. A real attestation and assertion from Brad's iPhone, once enrolment clears, is
owed as a fixture before release; until then the first real device is the test.

**Reviews (2026-10-21).** Design: adversary R1 to R14 fixed, Codex no findings. Code: a
fresh adversary (no blocker; R2 to R7 fixed) and Codex (R2 to R7 fixed; R1 "not wired into
RootView" is by design: the orchestrator wires `ChatView` and `LabUploadButton`). The chat
history order bug it found was then fixed in health-core (orchestrator's call,
2026-10-21): `mergeMessages` orders a question before its answer at an equal
createdAt (ids `u-<t>` / `a-<t>` used to put the answer first from the second exchange),
and `ChatSession.getMessages` reads in that order, so a file saved the old way reads
right before its next save. The app's own re-sort was deleted.

**The record stays the app's.** Lab extraction returns proposed values; the app shows them
for confirmation and writes the ticked ones itself, through health-core's
`bulkAppendValues` in the engine. Chat history is the web's `chat-history.json`, written
by health-core's `ChatSession` in the engine, kept beside the record.

**Where a report comes from (2026-10-22; redesigned 2026-10-25, US-52 AC10 to AC12).**
"+" opens a chooser: Files first, then Photos and Scan (VisionKit's document camera, real
phones only). Brad decided the order on 2026-10-25.
- *Files reaches every cloud.* The Files picker (`fileImporter`, which is
  `UIDocumentPickerViewController`) reaches any folder in Dropbox, Google Drive or iCloud
  Drive through their File Provider apps, and hands the app only the one file or folder the
  person picks, as a security-scoped URL. The sheet says so in one line.
- *Why no cloud lists (Brad, 2026-10-25).* From 2026-10-22 to 2026-10-25 the sheet had
  "From Dropbox" (a listing of the App folder, `Apps/Health Plan by Dr Brad`, and its
  subfolders, through engine doors over health-core's `dropboxListTree`) and "From Google
  Drive" (a Connect button and a pointer to Files). The Dropbox app is an App folder app
  and Google's scope is `drive.file`, so neither could ever show a person's own folders:
  Brad could not see his "Health" folder. Both screens, the doors `labFolderJson`,
  `labFolderFilesJson` and `labFile` (`engine/lab-files.ts`) and their Swift side went in
  one change, which moved the bridge id (D3). Sync keeps its scopes, `CloudSync` and the
  token store; the hosted connector still imports from the App folder (US-35 AC2).
- *Orphans removed (orchestrator, 2026-10-25).* health-core's `dropboxListTree` went with
  its only caller, and the fence no longer allows Dropbox `files/list_folder` or its
  `/continue`: nothing on the app's path lists a folder (EngineFenceTests
  `testADropboxFolderListingIsRefused`). The hosted connector's `dropboxListFolder` stays.
- *Consent moved to the send.* The AI consent now comes after a file is picked and read on
  the phone, before anything goes to the server. Choosing a source and signing in to
  Dropbox are not AI steps, so asking first got in the way.
- *Sync screen.* It says what sync does before a connect, names the cloud and folder once
  connected, and draws "not connected" as a phone (`SyncStatusText.symbol`): a struck-out
  iCloud symbol read as "iCloud is off".
- *The account's email (orchestrator, 2026-10-22).* Sync says "Connected to <email>", so a
  person with two Dropbox accounts can see which one is linked. Dropbox's token answer has
  no email, so connect makes one `users/get_current_account` call, as the web's
  `accountEmail` does (verified only, lower-cased); Drive's `about` call, already made for
  the account id, also asks for `emailAddress`; that it answers under `drive.file` alone is
  unverified until a real Google sign-in, so the cloud's name stays the fallback. No new
  scope. The lookup times out after 5 seconds (review R9). A missing email never fails a
  connect. It is kept only in `sync-account-email`, beside `sync-account` in the Record
  folder that backups leave out, never logged, and removed on Disconnect and on "Delete
  all my data". The web's code lives in the widget's adapter, not health-core, so the
  phone repeats the one call in OAuthClient beside Drive's `about`.

**The chat edits the record (2026-11-02, US-67; Brad: copy the web, F11).** The app sends
`edits: 1`, so the server offers the web's form tools, and the `done` line's `proposedEdits`
reach Swift as opaque JSON (`OpaqueJSON`), never read. One engine door, `chatEditsJson`, words
them against the record now, in the person's units; two edit kinds write them through the
usual path (`applyOnPhone`, or `cloudEdit` with its erase guard): `chatEdits` (part
`medications` or `review`, the proposals as received, the phone's day) and the engine's own
Undo edit, passed back as it came. A medication change saves at once with Undo; values,
height and sex wait in a banner with Save and Not now (`Chat/ChatEdits.swift`). A reply to a
question asked before an erase, and a banner made before one, write nothing: `RecordStore.Mark`
(the cloud erase, the eraseEpoch and the phone's erase count) is checked in the write's turn,
and ChatView drops the banners when it moves (US-16 AC2a).

**State 2026-10-22.** On the iPhone, chat answers "not available": the education server leaves
App Attest off until `APP_ATTEST_TEAM_ID` is set (`app/lib/app-attest.server.ts`), so chat and lab
upload wait for that secret and the team it names (Brad's personal team P7LB54J2PM now, DR BRAD,
INC. after enrolment; whether App Attest works under a personal team is not known). While a report
is read, the sheet shows where it goes (`LabUpload/LabReadingDiagram.swift`, US-52 AC13): the
report, "Read by AI", the record; it is not kept, and every value is checked before saving.

### D9 · No server telemetry; Clarity with every screen masked (Brad, 2026-10-21, amended 2026-10-22 and 2026-10-25)

The app sends no product events to Brad's server. Health values never enter any telemetry.

~~The usage signal is App Store Connect analytics only.~~ Fell 2026-10-22 (Brad): App
Store Connect cannot show where people get stuck. **Microsoft Clarity** now records
sessions, taps, rage taps and screen flow, as it does for the website, which masks its whole
health tool (`data-clarity-mask` on `HealthTool.tsx`'s root). The app matches that:
- `App/Analytics.swift` masks the whole window (`ClaritySDK.maskView`) BEFORE Clarity
  starts, so every tab, sheet, cover and alert in it is masked. Clarity's docs say a
  parent's mask does not force a text input's, so every TextField also carries
  `analyticsMasked()` (`clarityMask`). Screen names are fixed words (`Analytics.Screen`),
  never a navigation title, which can carry a supplement's name. Nothing is ever unmasked.
  The screens (2026-11-05, US-73, Brad): "Welcome", "Onboarding", "My health" (was "My data";
  "My plan" went with the merged tab), "Chat", "Apple Health metric".
- `AnalyticsMaskingTests` (US-25 AC19) fails if the window is not masked first, if any code
  unmasks, if a text input lacks its mask, or if any file but Analytics.swift calls Clarity.
- **Custom events, exactly twenty-one fixed words (Brad 2026-10-25, US-57's usage signal; "Guide seen" and "Guide opened" added 2026-10-26 for US-58; "Alcohol answered" for US-60; "Chat edit proposed" and "Chat edit saved" for US-67; "Health Records asked" and "Health Records imported" 2026-11-02 for US-72 AC13; "Tile explainer opened" dropped and "Jump pill tapped" and "Blood test added" added 2026-11-05 for US-73, Brad; "Lab save all" and "Lab save one" added 2026-11-11 for US-52 AC8b, Fable on Brad's hand-over):**
  `Analytics.event` sends `ClaritySDK.sendCustomEvent` with a word from one enum,
  `Analytics.Event`: "Tour started", "Tour tip closed 1/2/3", "Tour skipped 1/2/3",
  "Cloud prompt shown", "Cloud prompt back up", "Cloud prompt not now", "Guide seen", "Guide opened", "Alcohol answered", "Chat edit proposed", "Chat edit saved", "Health Records asked", "Health Records imported", "Jump pill tapped" (any of My health's jump pills, never which), "Blood test added" (a save from the Add blood test sheet, never which test or value), "Lab save all" (save all tapped on the lab-upload review, once per run), "Lab save one" (a lab report's own Save tapped; neither carries a count or a name).
  Never a value, a tile's name, a test's name, a count or any other text; nothing before Clarity starts.
  `AnalyticsMaskingTests` pins the list, so a new word is a test change and a D9 change.
  Views reach the one `Analytics` through the environment (`\.analytics`, set by RootView).
- Second layer: the Clarity project's masking mode is set to **Strict** on its dashboard
  (Brad), which masks all text and images whatever the code does.
- **What masking cannot hide:** where a person taps on a masked layout. On a two-button
  question (Female or Male, a screening yes or no) the tap position can reveal the answer to
  someone who knows the layout, and a wheel's swipe distance hints at a value. The website
  has the same limit. The privacy policy says so. Pausing Clarity on those screens would
  remove the onboarding funnel this amendment exists for: Brad's call (review R2, 2026-10-22).
- On since 2026-10-22: Brad created the mobile project (`z1kbjvj8u6`, Strict masking) and
  `Analytics.clarityProjectId` holds it. Never under XCTest, nor in the UI tests
  (`--ui-testing`). Clarity 3.5.4, exact version.
- **No consent prompt (Brad, 2026-10-22):** "we aren't recording text or images." The app
  never calls `ClaritySDK.consent`. Risk stated to Brad and accepted: Clarity keeps a random
  install id on the phone, and under the EU ePrivacy rule (and the UK's and Switzerland's
  equivalents) storing an id for analytics needs consent whatever is recorded; Microsoft's
  Clarity terms also ask for a consent signal from those users. How the iOS SDK behaves
  without one is not known. Revisit if Clarity stops recording those regions or a regulator asks.
- Apple's Guideline 5.1.3 (no Health data to third parties for analytics) holds because no
  value reaches Clarity. The privacy policy and App Store answers name Clarity, and Clarity
  derives a coarse location from the IP address, declared as Coarse Location.

**State 2026-10-22.** Project `z1kbjvj8u6`, Strict masking confirmed on the dashboard. No
recording had arrived by evening, so the masking check on a real recording is still open.

### D10 · Old app versions stay safe

Any change to merge behaviour bumps the schema version, so an older app refuses the file
(`SchemaTooNewError`) and asks for an update instead of merging the old way. Over-the-air
engine updates (D3) close most of this gap; the bump covers what they cannot reach.

The rule is for merges that could lose or change data. A change that only orders what
merges already keep does not bump. Decided 2026-10-21 by the orchestrator, for Brad to
revisit: `mergeMessages` now sorts question before answer at an equal `createdAt`
(US-52). Codex asked for a chat-history version bump. Not done, because every reader
sorts on read (`ChatSession.getMessages`), so a file an older client writes still reads
in the right order, and nothing can be lost or duplicated. A bump would have cut every
open web tab, Pages fork and CLI off from its chat history until it updated.

Decided 2026-10-22 by the orchestrator, after Codex and an adversary reviewed it:
last-write-wins now reads clock time first and the lamport counter only on a tie (US-10
AC8). No bump, accepted with the residuals below stated. An
older app merges the old way, which is exactly today's behaviour: it can put back an
older value, the bug AC8 fixes, but nothing a current app writes breaks it, and nothing it
writes breaks a current app. The file's shape is unchanged, and the field-stamp invariant
reads the same either way (each side treats the other's merged object as not stale and
reads its field stamps). The cost of no bump: a mixed fleet, older and current clients
syncing one record, can settle a scalar (a medication, a supplement, a reminder setting, a
profile or screening field) on a value that is neither the newest edit nor the highest
counter, and the cloud copy may switch between values on each save until the older client
updates. No rows are lost: append-only arrays, history and erases merge as before. Old
GitHub Pages forks and local CLI or stdio MCP installs may never update, so for them this
residual may never end. Where the file's meta was hand-edited with an offset spelling, an
older client clamps a row to that spelling and a current one does not, so a mixed fleet can
hold the row twice, the second as an `id#dup-…` copy. Nothing is lost. A second residual, from the new rule itself: after one write from a
fast clock to any profile or screening field, the WHOLE object orders by counter until real
time passes that stamp, because each later write stamps past every clock the object holds.
The cost of a
bump: every open web tab, Pages fork, local CLI and stdio MCP refuses the record until it
updates, and the published agent contract (`schemaVersion` 2, docs/agent-access.md) moves.

### D11 · My data: no title bar, one blood pressure, Apple Health's metric page (Brad, 2026-10-22, US-25 AC17)

- **No title bar.** It cost a line for a word the tab bar already says. The "+" and Sync
  sit on the About you header, the unit switch on the Vitals header. With no bar, iOS 26's
  scroll edge effect left rows legible behind the clock (checked in the simulator), so a
  zero-height top inset carries the list's background into the status bar (`solidStatusBar`).
  My plan lost its bar too (Brad 2026-11-03, US-25 AC26): "Your health snapshots" heads the
  tiles in the sections' own `PlanHeading` and scrolls with them; same inset, plus `firmTopEdge`.
- **Blood pressure is one engine edit.** `bloodPressure` (`engine/blood-pressure.ts`)
  runs health-core's `appendMeasurement` or `correctValue` for each half on one record and
  returns the first refusal, so both rows land or neither. Two Swift calls in a row would
  save a lone systolic when the diastolic is refused. The record keeps two rows per day,
  as the web pairs them; no new row shape. Replacing corrects only the half that changed:
  re-correcting the unchanged half joins merge's last-writer-wins and can silently undo
  another device's fix of it (review 2026-10-22, reproduced with `mergeFiles`). The exact
  same pair writes nothing. A held day is asked about before any half is written, and a
  replace carries the active row ids the user saw (`seenIds`); other ids at save time
  refuse it, as a single value's stale correction is refused.
- **The history replays the day** (orchestrator, 2026-10-22, after a re-check found
  the window-based struck pairs dropping and duplicating values). All the day's rows, in
  write order (`createdAt`, a correction after the row it names, then id), grouped into
  writes: one row per half, within 5 s of the write's first row, never a correction of a
  row in the same write (the web, CLI and MCP stamp each half with its own clock). Each
  write sets its halves and leaves a snapshot; the pair now is active, the rest struck.
  One choice beyond the brief: a row merge set aside shows over the pair as it stood but
  does not change it, or a lost write would leak into every later snapshot and into the
  active pair. Ids are per snapshot, so the active and a struck pair never share one.
- **Feet and inches in the engine.** `profile` takes `heightFeet` and `heightInches` and
  calls health-core's `feetInchesToCm`; My data gets `cmToFeetInches`. Same maths and
  rounding as the web's form, no Swift copy (D2). Not unit-dependent, so the cloud's
  unit-change guard does not refuse it. Wheels saved unchanged write nothing, so a metric
  height is never rounded to the nearest inch.
- **A pushed page, not a sheet.** Apple Health's pattern: range picker, headline, chart,
  values. The range logic (`ChartRange`) is presentation, so it is Swift and unit-tested;
  values and pairs come from the engine. Days are midnight UTC and the chart reads them
  in UTC, so no zone moves a point to the next day. No target band: the engine has no
  per-metric target to give, and drawing one is a clinical call.
- **Two Charts traps:** a material background inside a chart annotation renders black, so
  the callout uses a solid system fill; and the newest axis label clips unless the marks
  use the `.aligned` preset.
- **Grades and lab test rows come from health-core, through the engine (Brad, 2026-11-02,
  US-25 AC17, US-62 AC8).** The web's grade (amber, red) and its spoken words lived in
  widget code (`statusOf`, the vitals grades, `gradeWords`). They moved unchanged into
  `packages/health-core/src/row-grade.ts`; the widget imports them. `row-grade.parity.test.ts`
  grades a grid of about 1.68 million inputs and checks its hash against the one recorded from
  the widget's functions before the move. The lab tests' grouping and row moved the same way
  (`lab-series.ts` `labSeriesRows`), and so did the trend window (`recent-trend.ts`). The
  engine serves each row's `status` and `gradeWords` and a `labTests` list; a blood pressure
  is graded on the stored halves of the pair it shows. Swift reads `status` as a `Grade`
  (an unknown word reads as none) and only maps the colour (`ValueRow.gradeColor`: amber is the app's
  `info` tone, red `urgent`, the web's #b91c1c) and joins VoiceOver's words. Why not in
  Swift: a copy of a clinical line drifts, and an engine fix ships over the air (D3). PSA is
  not graded, as on the web. A lab test row opens nothing: there is no engine door for a lab
  series' history and no page for one yet. A value printed as a limit (US-12 AC20) is graded by
  the web's `savedStatus`; a weight, waist or blood pressure printed as a limit is graded only
  when certain (US-12 AC21, Brad 2026-11-02), by the same health-core rule the web uses
  (`certainValue`; a blood pressure by the lines each half can reach, `linesReached`). A limit the rule
  leaves ungraded, where there is a plan to grade it by, carries the web's "Printed as a limit"
  note (`limitUngraded`): on the row (`note`, said by VoiceOver where the grade would be) and on
  the history page (`historyJson` `note`), for weight, waist and blood pressure as for the blood tests.

- **A lab test's page (Brad 2026-11-02, US-25 AC25).** A lab row opens `MetricDetailView`, the
  metric page, with its history from the history door's optional `series: "lab"` (D14: an older
  engine fails the read, and the page shows no history). The row itself says it is a lab test
  (`series`), and the page, its kept history ("lab:<key>", `RecordStore.historyKey`) and its adds go
  by that, never by name: a lab test filed as "Weight" is not the core weight (review R1). A value
  is added by a new edit, `labAdd`, in the unit the sheet showed, through health-core's
  `addLabValue` (the web's add too), and corrected by `labCorrect`, the engine's `correct`, in the
  row's own unit and free of the record's units. No row is "used" or carries a limit note: lab tests
  are never graded. A mixed-unit series draws no chart (US-21 AC3a).

**Added 2026-10-26: "About this measure" guides (US-58).** Below Show All Data and Unit, a metric page shows
"About {title}" (What it is, Why it matters, How to measure or prepare) and its Sources as links, as Apple Health
does; each drug question on My data has an info button that opens the same sections in a sheet (`GuideSections`,
`GuideSheet`). The text is health-core's `METRIC_GUIDES`, display-only clinical text bound by the three clinical
files (health_roadmap_algorithm.md says so; `metric-guides.test.ts` checks every source and number). The engine
serves it as `guides` on `screenJson`'s My data, so a correction ships over the air (D3). Route chosen over a new
door or the history door: the drug questions live on My data, not on a metric page, and one field on the existing
answer reaches both without touching the bridge contract (id unchanged, `4bb43ea735cb5a3d`). Cost: about 19 KB of
static JSON on each draw. An older engine sends no `guides`; Swift reads it as optional and shows none. Swift reads the map leniently (`MetricGuides`): a malformed guide is left out and a malformed map reads as empty, so a bad over-the-air guide never blanks My data. Only https sources are links; any other scheme shows as text. A guide shows only on a page that has data: a metric with no value opens its entry sheet, not the page (Brad's call whether to change that).

**Added 2026-10-30: medication changes on a metric page's chart (US-25 AC9b, Brad: the web's markers on the phone).** A metric page draws each recorded medication change as a dashed indigo rule (the web's `#6366f1`, `#818CF8` in dark mode), with a dated list below the chart that VoiceOver reads; the rules are hidden from it, so nothing is read twice. The drug-to-metric map, the log projection and the words were the web's (`widget-src/src/lib/medication-annotations.ts`); they moved to health-core's `medication-annotations.ts`, which the web's HistoryPanel and RoadmapStore now import, so there is one source. The engine serves each page's as `markers` (`{id, day, label}`, oldest first) on `historyJson`'s `MetricHistory`. Why there: a marker belongs to one metric page, which already reads `historyJson`; `screenJson` would carry every metric's markers on every draw. Why no bridge change: the contract names `historyJson`'s return only as "MetricHistory JSON", and an older app ignores a field it does not know, as with `guides` (id unchanged, `2d467ff50c66c42d`). An older engine sends none; Swift reads the list leniently (the shared `Lenient` wrapper, `MetricHistory.medicationMarkers`): a malformed marker is left out, a malformed list reads as none. The day is the phone's local day of health-core's `recordedTime`, the time the web's chart plots too: a day slot at local midnight, any other stamp read by `stampInstant`, so V8 and JavaScriptCore agree (adversary R3). The chart's range reaches the markers, as the web's does; the scrub still picks only values (`ChartData.days`).

**Added 2026-10-22.** Number boxes refuse, as typed, what no value can be (`MyData/TypedNumber.swift`,
US-25 AC17b): blood pressure 3 whole digits, values 5+3, doses 5+2; a refused change goes back to
the last accepted text, a loaded value is never cut, and an over-limit loaded value is never
restored (no flip loop). Colours follow Apple Health (AC17c): blood pressure red, body measurements
purple, blood tests blue; the light accent is dark enough for white text (5.35:1) and dark-mode
accent buttons carry black text (`OnAccent`, dimmed when disabled). Controls carry the brand accent (Brad 2026-10-30): pickers' and menus' values, buttons, "+" and Sync; rows that open a value keep their text in the label colour (`.tint(.primary)`, AC17's plain names).

## Build and test

**Layout.**
- `engine/entry.ts`: the one door Swift calls, JSON in and out: `screenJson` (My data and
  the Plan tab's sections and tiles from one read and one plan, with US-61's product blocks, D14; the self-test calls it too,
  so it proves what both screens draw), `planJson` and `sectionsJson` (the parity goldens; the
  self-test also checks `planJson`), and `newRecordJson`, `applyEditJson`, `numberJson`. Every door reads the record through health-core's `ROADMAP_DOC.migrate`
  (shape check, then migration), as the web, CLI and connector do.
- `engine/shim.ts`: fetch, timers and friends over Swift's natives (D2). `engine/cloud.ts`:
  the phone's `RecordHost` and the cloud doors Swift calls (`cloudOpen`, `cloudEdit`,
  `cloudLabImport`, `documentSave`, `cloudErase`, `cloudVisible`, `cloudHidden`,
  `cloudRefresh`, `cloudFlush`, `cloudClose`), D5. `engine/cloud-adapters.ts`: the two
  stores it stands on (the cloud through health-core's REST adapters, the phone's file as
  the mirror), the cloud natives and the failure kinds. All tested in Node by `shim.test.ts` and `cloud.test.ts`,
  which `test:all` runs.
- `engine/reminders.ts`: the phone's reminders, `remindersJson` in `entry.ts`: health-core's
  schedule plus the notification days (D7). Tested by `engine/reminders.test.ts`.
- `engine/my-data.ts`: what the My data tab shows and every write it makes, each one
  health-core's own (`createEmptyFile`, `updateProfile`, `stampProfile`,
  `appendMeasurement`, `correctValue`, `upsertMedication`, `upsertSupplement`), with
  values in the user's units (US-25 AC7). Not yet through `RecordSession.edit` (D4).
- `engine/blood-pressure.ts`: the `bloodPressure` edit (both halves or neither) and the
  paired history (D11). Tested by `engine/blood-pressure.test.ts`.
- `engine/my-data-forms.ts`: the medication, screening and supplement questions
  (health-core `input-form.ts`) for the plan's age, sex and cascades, their answers
  (only a shown question, only an offered answer, then the web's writes), and
  `metricHistory` (every row of a metric, entered-in-error included, and its medication
  `markers`, health-core's `medication-annotations.ts`). Entry door:
  `historyJson`. Tested in Node by
  `engine/my-data.test.ts`, which the web's `test:all` runs.
- `scripts/build-engine.mjs`: bundles health-core with esbuild (target Safari 17, iOS 17's
  JavaScriptCore) into `HealthRoadmap/Engine/health-engine.js`, and writes the parity
  goldens. Run it before any Xcode build: `node ios/scripts/build-engine.mjs`. Its outputs
  are generated and ignored by git.
- `scripts/release-engine.mjs` (`npm run engine:build`, loading `release-build.mjs`), `scripts/sign-engine.mjs` (run directly), `scripts/engine-keygen.mjs`,
  `scripts/engine-signing.mjs`: signed over-the-air releases into `engine-release/` (D3).
  `engine/bridge-contract.json` is the native bridge's contract; its hash is the bridge id.
  `engine/bridge-optional.json` holds the both-way additions that keep it (D3, D14).
  Tested by `scripts/release-engine.test.ts`, `scripts/signing-key-guard.test.ts` and
  `engine/bridge.test.ts`.
- `scripts/ui-test.sh`: the UI tests, one at a time, each on a fresh install (US-54).
- `scripts/app-store-shots.sh`: the App Store screenshots (US-25 AC10, app-store.md step 6).
- `scripts/sim-run.sh`: the one door to the simulator (US-71 AC7, 2026-11-11). Every session takes turns on
  one device, "HR Shared iPhone" (iPhone 18 Pro, newest iOS runtime), under a kernel lock: `lockf` on a
  file descriptor the wrapper opens in `~/Library/Caches/health-roadmap-sim`. The kernel frees it when the
  holder exits, however it exits, so there is no stale lock to take over (a hand-made mkdir lease came first,
  and review found five races in it; Fable 2026-11-11). lockf's command form was not used: it drops the lock
  when lockf itself is signalled while its command runs on, and its timeout exit (75) is a command's too.
  A perl shim keeps the descriptor while the device steps and the command run in their own process group,
  and stops the group (TERM, then KILL) at the time limit, on a signal, or if the wrapper is killed outright,
  before the lock frees. The device stays booted between runs and a detached sleep shuts it down after 20
  idle minutes. Why: each test run booted its own simulator (load spikes of 33 to 47 on 2026-11-11), and 171
  simulator-runtime processes from runs 9 and 11 days old were still alive. The test scripts here run through
  it. Demos use their own device: a demo hold on the shared one was built and dropped the same day, because a
  second lock with its own lifetime on top of the first kept handing the device to two callers. Tested by
  `scripts/sim-run.test.ts` with a fake xcrun (macOS only; CI skips it).
- `scripts/fresh-sim.sh`: builds and starts the app on the demo device, "HR Demo iPhone" (made once by name, never the shared one; only with the hatch in ios/CLAUDE.md), as a new install (app, keychain, settings and privacy answers removed; settings written with `simctl spawn defaults`, as app-store-shots.sh does, live outside the app and survive an uninstall), so onboarding runs from its first screen. Brad's feedback runs start here (2026-10-23).
- `scripts/test.sh`: builds the engine and runs the unit tests (not the UI tests) once in UTC and once in
  Pacific/Auckland. Gotcha (2026-10-21): JavaScriptCore reads the time zone once per
  process, so `setenv("TZ")` inside a test does not reach the engine; the first
  parity test passed in Auckland and failed in UTC for that reason. The zone is set at
  launch with `TEST_RUNNER_TZ`, and a zone with no golden skips (a Tokyo run proved
  the pin reaches the test).
- `HealthRoadmap.xcodeproj`: hand-written, using Xcode's synchronized folders, so a file
  added to `HealthRoadmap/`, `HealthRoadmapTests/` or `HealthRoadmapUITests/` joins its
  target with no project edit. No project generator. One Swift package: Microsoft Clarity
  (`clarity-apps`, exact version 3.5.4, D9), resolved in
  `project.xcworkspace/xcshareddata/swiftpm/Package.resolved`.
- `HealthRoadmapUITests/`: XCUITest on the simulator (US-54); each test needs a fresh
  install, and the app is launched with `--ui-testing` so Clarity never starts.
  Apple's Health sheet (#999, iOS 27.0, measured 2026-11-09): under load its Don't Allow drops
  out of the tree for a moment, and reading an element's `frame` then fails the test, so
  `declineInSheet` reads a snapshot, which throws instead. A snapshot's frame is not in screen
  points (the button read 766 by snapshot, 828 by `frame`; the sheet's window starts 62 pt down),
  so the helper places it against the window's own snapshot at each look. It reads a window's
  live frame once, after both snapshots have read, waits for Apple's OK to have a place, and
  passes only once the sheet's windows are gone; each miss names its own cause (#1032).
- `HealthRoadmap/`: the SwiftUI app, one folder per feature:
  - `App/`: the entry point (`AppParts` makes the engine and the record once),
    `RootView` (the tabs: My data, My plan, Chat; and the first-run cover),
    `WelcomeView` and `WelcomeConnect` (its cloud connect derives its phase from CloudSync
    each time and keeps no copy, so a relaunch waits on the launch open; US-54 AC2b), `LogoMark` (the logo and, through `scripts/make-icon.swift`, the app icon:
    the original road-to-heart icon, our own drawing, redrawn as Shapes on 2026-10-25; never an
    SF Symbol, traced or not, US-25 AC10), `Analytics` (Clarity, masked, D9), `Colors` (the app-wide colour helpers)
    and `MessageAlert` (the one-button alert every tab uses).
  - `Onboarding/`: the new-user flow (D12, US-54). `OnboardingSteps` (which questions,
    resume, region units, Health's sex and birth month and year), `TypedAnswer` (a typed
    height or weight and its entry-only unit switch), `OnboardingView` and `OnboardingPage`
    (one screen's layout). The tour after it (US-57): `TourTips` (three TipKit tips, one
    line each; `TourSetup` configures TipKit at launch and hides it under `--ui-testing`
    unless `--show-tips`) and `CloudPrompt` (the one backup offer after the third own save).
  - `Engine/`: `HealthEngine.swift` loads the bundle into a `JSContext` and awaits its
    Promises; `EngineNatives.swift` is the bridge (D2); `PhoneFiles.swift` the phone's
    record file and pending marker the natives read and write; `EngineHTTP.swift` its network
    fence (D3); `HealthEngine+Cloud.swift` the typed cloud doors and `HealthEngine+Erase.swift`
    the erase doors. The generated bundle and its `health-engine.json` sidecar sit beside them.
    **Where a bridge door lives (one rule):** a door one feature alone uses sits in that
    feature's folder as `Engine<Feature>Doors.swift` (`Chat/EngineChatDoors.swift`,
    `LabUpload/EngineLabDoors.swift`); a door the record, sync or erase paths share sits in
    `Engine/` as `HealthEngine+<Feature>.swift` (`+Cloud`, `+Erase`). Both are extensions of
    `HealthEngine`; the core doors (plan, My data, edits) stay in `HealthEngine.swift`. This is
    the split the files already follow (two of each), so neither moves.
  - `LabUpload/`: "Add medical records" (US-52). `LabUploadSheet` (the flow), its one
    named state `LabUploadFlow` (a pure `transition`, AC8b), `LabReportSave` (a report's
    defaults, its save plan and the one save that its Save and Save all both run),
    `LabSaveAllViews`, and `LabUploadExplainer`, `DocumentScanner`, `EngineLabDoors` (the engine doors it calls),
    `LabUploadClient` (the server's extraction), `LabReview` and `LabReviewView` (the
    engine's answers and their screen), `LabReadingDiagram`, `LabFileReader` and `ZipReader`.
  - `EngineUpdates/`: over-the-air engines (D3, AC18). `EngineRelease` (pins, bridge,
    limits, address), `EngineManifest` (`ManifestCheck`), `EngineFolder` (staging and
    state), `EngineUpdater` (the check), `EngineBoot` (which engine runs),
    `EngineSelfTest` (the quarantine's test and `QuarantinePort`).
  - `Sync/`: cloud sync (D5, US-25 AC11). `CloudProvider` (client ids, redirects),
    `PKCE`, `TokenStore` (Keychain), `OAuthClient` (sign-in and refresh), `CloudSync`
    (opens the engine's session, follows the app on and off screen, answers the engine's
    `CloudPort` calls), `SyncProblem` and `SyncStatusText` (the words), `SyncView` (the
    screen, from the cloud button on My data's About you line).
  - `MyData/`: the record and its tab. `RecordStore` keeps the record and applies edits
    through the engine; `RecordFile` is the file on disk and the engine steps that read and
    write it; `MyData.swift` is the engine's view of the record and the
    `RecordEdit` the tab sends; `MyDataView`, `ValueRow` (a row, a vitals card, its
    sparkline; the row follows the web's MyDataRows.tsx, without grade colours: "target · date" under the name, the value
    with the previous one in brackets, both served by the engine, US-62 AC8), `ValueEntrySheet` and `DayText` draw it. `SheetSave` is a sheet's save and
    the "Not saved" alert (`refusalAlert`, over `App/MessageAlert.swift`).
    The form sections (US-25 AC8): `FormModels` (the engine's question JSON and `FormEdit`),
    `FormFieldRow` (one question: menu, month wheel, number or dated value),
    `FormSectionsList`, `MedicationsSection`, `ScreeningsSection`, `SupplementsSection`
    with `SupplementSheet`. Value pages (AC9, AC17): `MetricDetailView` (pushed:
    range picker, headline, values, tap to correct, no delete), `MetricChart` (Swift
    Charts, scrubbing, the VoiceOver chart descriptor, the medication markers and their
    list, `MedicationMarkerList`), `ChartRange` (which ranges to
    offer), `MetricEntrySheet` (picks `BloodPressureSheet` or `ValueEntrySheet`) and
    `FeetInchesSheet`.
  - `Reminders/`: on-device reminders (D7). `PhoneReminders` is the engine's answer,
    `ReminderScheduler` keeps the pending notifications equal to it behind
    `NotificationScheduling` (a fake in the tests), `ReminderTaps` sends a tap to My plan,
    and `RemindersSection` is the switch and list in My data.
  - `Health/`: Apple Health (D6). `HealthKitClient` is HealthKit; `AppleHealthSync` runs
    the import and the writes; `HealthReading.swift` is what crosses to the engine;
    `HealthSyncMemory` the anchors; `AppleHealthSection` the row in My data.
  - `AppleHealthMetrics/`: US-56's live heart, sleep and fitness metrics, read from HealthKit
    and never in the record; only the cards' last readings are kept, on the phone (D6, US-56 AC2).
  - `Plan/`: the plan screen, drawn from the plan the store keeps with My data (`screenJson`).
    `Plan.swift` is the slice of the engine's JSON the app reads, evidence included. The layout (sections, card order, grouped cards) is not
    Swift: it is health-core's `planSections` (packages/health-core/src/plan-sections.ts),
    which the web's results panel calls too. `PlanView.swift` and `PlanCardView.swift`
    draw it. `SummaryTiles.swift` draws the tiles above it (US-25 AC22), the web's Quick
    Stats, from the engine's `screenJson` (one plan gives both, US-25 AC22). The tile rules (which tiles, their order, words,
    units, statuses and evidence) live once, in health-core's `statTiles`
    (packages/health-core/src/stat-tiles.ts), which the web's results panel calls too;
    `screenJson` in `engine/entry.ts` only passes the phone's units. Swift picks only the
    status capsule's colour: names are plain text, no symbol (Brad 2026-10-23). The capsule
    carries the web's status colours, normal in the brand teal-green (Brad 2026-10-30):
    `Color.status` in `App/Colors.swift`, one map shared with the plan's priority badge,
    the shades fixed per mode so each word passes WCAG AA on its capsule. Each card
    rises in once, the first time any of it scrolls into view (`RiseIn`, iOS 18's
    `onScrollVisibilityChange`; on iOS 17 cards are simply there). A section-wide transition
    tied to scroll position faded a section out while it was being read, once an opened card
    made it taller than the screen (Brad 2026-10-23, "Micronutrient base"); a latched
    per-card entrance cannot. The earlier fixes (4fd330bc, then a `.visible(0)` threshold)
    worked on the animation and missed this.
- `engine/fixtures.mjs`: the parity records (the sample, an urgent value reached by a
  correction, a minor, an excluded value, no height). `engine/golden.ts` runs the engine
  from source on each to make the goldens.
- `HealthRoadmapTests/`: XCTest. `EngineParityTests` is US-25 AC1 (every fixture, plan and
  layout, byte for byte); `PlanLayoutTests` pins the sample's web layout and checks that
  no card loses its evidence or ingredients; `RecordEditTests` runs the My data writes in
  JavaScriptCore; `RecordStoreTests` covers the file (AC4) and the plan following it
  (AC6); `DayTextTests` pins the local day; `MyDataLayoutTests` is AC17; `FormEditTests` runs the form answers,
  supplements and history in JavaScriptCore (AC8, AC9). Sync (AC11): `ShimTests` (the
  shim in JavaScriptCore over a URLProtocol stub, `StubHTTP`), `SignInTests` (Keychain,
  PKCE, code exchange, refresh), `CloudSyncTests` (the whole path against a stubbed
  Dropbox with its rev rules), `SyncStatusTextTests`, `LiveDropboxTests` (real Dropbox,
  scratch account, skipped without a token); `ReminderSchedulerTests` is AC12.

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

**Bundle ID:** `com.drstanfield.healthroadmap` (2026-10-25, team KAV75KMV2R, Dr Brad, Inc), permanent once
the app is on the App Store. The earlier `com.drbrad.healthroadmap` was claimed by the free personal team
when the app was first installed on Brad's iPhone, and Apple will not move an id from a free team to a paid one. Enrolment: DR BRAD, INC.
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

### D12 · Onboarding: four questions, prefilled from Apple Health (Brad, 2026-10-22, US-54)

A new user answers sex, birth month and year, height and weight, one per screen, after one
"Use your Apple Health data" screen, then lands on My plan. Design and reasons:
[onboarding.md](onboarding.md).
- **Why:** the full My data form asked thirty rows before the plan; the plan runs on sex
  and height. Apple Health and Fitness ask these few things first and get out of the way.
- **Writes are the engine's own** (`profile`, `feetInches`, `add`, `correct`), saved as the
  person goes, so quitting keeps answers and a relaunch resumes. No health-core change.
- **Health's sex and date of birth** are now read (new purpose text). Only the birth month
  and year are used, and only once the person continues; the day is never stored.
- **Existing users skip it**: a record holding sex, birth year and height. "I already use
  Health Roadmap" connects the cloud first, then asks only what is missing.
- **No usage event** (D9 holds): App Store Connect retention is the signal.

### D13 · "Do you drink alcohol?": one profile answer, the engine drops the card (Brad, 2026-10-31, US-60)

Only the reduce-alcohol suggestion has a Dismiss button (keyed off its id in
`PlanCardView`), shown while the card is on the plan. It opens the app's usual
confirmation dialog, attached to the button so its arrow points there. Unanswered:
"Do you drink alcohol?", "I don't drink" or "I drink". A drinker (Brad 2026-11-01): "Do
you still drink alcohol?", "I've stopped" (saves `none`) or "I still drink", which saves
nothing and shows one line in an alert on the same button (`messageAlert`, no title):
the card stays because its advice applies to anyone who drinks, and About you changes the
answer. `AlcoholQuestion` holds the prompt per answer and is nil for a non-drinker, whose
card the engine has already dropped. Any save is checked against the screen recorded at
the tap. Plan:
[docs/drafts/alcohol-question.md](../docs/drafts/alcohol-question.md).
- **The answer is a profile field** (`profile.alcohol`), written by the engine's own edit
  (`{kind: 'alcohol'}` in `engine/my-data.ts`, health-core's `stampProfile`), so it merges
  field by field like the rest of the profile. "Not answered" in About you writes null, as
  every cleared profile field is stored, so a clear merges as a write.
- **Swift never filters cards.** "I don't drink" reaches the engine, which stops sending
  the card. The plan animates on the answer alone (`.animation(value:)` on it: the save
  lands after an await, outside any `withAnimation`), so the card fades out and the rest
  close up while nothing else on the plan animates.
- **Asked again only on a tap.** "I drink" keeps the card; its Dismiss now asks whether
  they still drink (it once vanished, which left a drinker who had stopped no way off the
  card but About you).
- **No new bridge.** The edit and the field ride the existing `applyEditJson`/`screenJson`
  doors; the contract file is unchanged. Swift reads the field leniently, so a value it
  does not know shows as "Not answered", never a broken My data.
- **Usage signal:** Clarity's "Alcohol answered", sent from the plan's dialog only, once
  saved ("I've stopped" counts; "I still drink" saves nothing and sends nothing), never
  the answer (D9). The chat allow-list (`ChatClient.contextKeys`) carries health-core's
  new `alcohol` key, so the chat knows a non-drinker.

### D14 · Dr Brad's products on the US plan: the App Store storefront decides (Brad, 2026-10-31, US-61)

A known adult whose App Store storefront is the US sees, on each mapped supplement card, the
product that holds it (MicroVitamin+, or Sleep on the sleep card), and under the last
Supplements card one line saying Brad owns the company. Everyone else sees the plan as it
is. Spec: docs/user-stories.md US-61.
- **Why the storefront.** StoreKit's `Storefront.current` is the App Store country of the
  Apple ID, the same market the app is sold in, and needs no permission, no location and no
  network call of ours. The phone's region is a display setting anyone changes; the record's
  units say nothing about the market. Nil (no Apple ID, StoreKit cannot say) keeps the saved
  answer and writes nothing; with nothing ever saved it is not the US (`AppStoreCountry.remember`).
  `AppStoreCountry` keeps the last answer in the app's defaults, so a launch draws the plan
  at once with it; each return to the app asks StoreKit again (the storefront changes only in
  Settings) and a change redraws (`RecordStore.follow(storefrontIsUS:)`). Under the tests it
  is always false. DEBUG only, compiled out of Release: the launch argument
  `-StorefrontCountry USA` (or `NZL`) stands in for StoreKit, for simulator checks.
- **The engine stays the one source.** `screenJson` takes `isUS` as a new last argument and
  answers `plan.usProducts`: health-core's `usProductSections` (us-products.ts, the web's own
  overlay), the sections ready to draw. It applies the adult rule `medicinesShown` itself, the
  web's. Only `true` counts. Every word, link, card choice and place is the engine's, so a
  wording or mapping change ships over the air (D3), and an engine release that empties the
  mapping removes the blocks (no kill switch, Brad). `plan.sections` stays the web's
  `planSections`, product-free; `usProducts` is left out when no block shows. Swift decides
  nothing: it draws `usProducts` when present, else `sections` (simplified 2026-11-01; the
  first cut had Swift and the web each place blocks, swap text and add the line).
  **Host pin:** decoding refuses a block whose link is not https on `microvitamin.com` (host
  compared without case), and then the whole `usProducts`, so the plan shows plain: a signed
  engine can choose among those product pages but cannot point a link anywhere else.
- **No bridge change (corrected 2026-10-31, adversary review).** The change works both ways,
  so the id stays `2d467ff50c66c42d` and over-the-air engines keep reaching builds 3 and 4.
  An older app sends four arguments: `isUS` is undefined, so it gets no blocks. An older
  engine ignores the fifth argument and sends no `usProducts`, which Swift decodes as none.
  `isUS` and `usProducts` are recorded in `bridge-optional.json`, not the hashed contract
  (D3). `usProducts` changed shape on 2026-11-01, from `{blocks, ownershipLine}` to the
  sections ready to draw; no build before US-61 reads it, so the change is safe for builds 3
  and 4. A first cut moved the id to `d0ffd9e53f8499b3`, which would have cut builds 3 and 4
  off every later engine; it never shipped.
  **The rule:** `bridge.test.ts` pins the id as a literal. A real bridge change (anything an
  older app cannot do without) moves the id and updates that literal; `bridge-optional.json`
  is never a way around one, only a place for additions that work both ways.
- **Costs, accepted (2026-11-01, review of the /simplify change):** for a US adult, `screenJson`
  ships the sections twice (`sections`, product-free, plus `usProducts`, ready to draw), and the
  plan's `ms` timing includes the overlay. A product link that fails the https microvitamin.com pin
  drops the whole overlay, so the plan draws plain and nothing records it; only a bad signed engine
  can cause that, and plain is the approved non-US view.
- **Taps only, no new Clarity word.** The links carry `utm_source=health-tool&utm_medium=ios`,
  so taps and orders show in Shopify, and nothing from the record enters a URL. No impression
  is counted: a Clarity event would add a word to D9's fixed list, which US-61 leaves as it is.
- **Tests:** `ios/engine/us-products.test.ts` and `bridge.test.ts` (Node), `USProductsTests.swift`
  and `EngineBridgeContractTests.swift` (XCTest). Both directions: the Node test calls
  `screenJson` with an old app's four arguments; the XCTest runs the plan on a stand-in for an
  engine before US-61 (four arguments, no `usProducts`).

### D15 · Lab results printed as a limit: the engine says them, Swift draws them (Brad, 2026-11-02, US-12 AC20)

A lab result printed "> 60" or "< 5" is saved with its comparator. The engine owns every
word: My data, the metric page, the lab review and the plan tiles get strings with the
symbol, and the grading rule ("only when it decides") runs in health-core. Swift only draws
a limit point hollow, off the chart's line, from `historyJson`'s optional `bound`; an older
app finds no number in "< 2.0" and leaves the point off the chart. The phone's chat sends a
limit as `limits` only, never the field's hidden representative, and `limits` joined
`ChatClient.contextKeys`, which moved the bridge (build 5 takes no over-the-air engine from
this release on). Apple Health never gets a limit (device-export.ts). The phone sends no
`product_events`, so it has no count of limits.

### D16 · My health: one tab, laid out by the engine (Brad, 2026-11-05, US-73)

My data and My plan became one tab, My health, beside Chat (seven prototype rounds, draft PR
842). Swift places no suggestion: `screenJson`'s `plan.topics` (health-core `topicSections`)
puts each in a topic's cards or on a row (a medicine question by key, a screening group by
id), an urgent one in both. `HealthPage` reads it once per draw (`RecordStore.draws`: an edit,
and also a redraw at foreground, midnight or a storefront switch, which moves no `revision`;
review round 2), with the two series below, and `MyDataView` only maps the page to views, so a test on the page is a test on what
is drawn (each suggestion exactly once; an urgent one in its card and on its row). An unknown
topic goes under Other, and with no layout every card does, so nothing is dropped. An urgent
card leads its section and the red banner scrolls to it. The waist-to-height row reads
`historyJson`'s `whtr` series; the eGFR row is the plan's current eGFR (its tile, on the day and
from the source the `egfr` series' `plan` names, a lab limit included), the series giving only
the previous value and the trend. Both series read the plan for the day drawn, so
`RecordStore.chart` keeps them per draw as well as per `revision` (review round 3); until the
page's task reads them again, the page draws the last ones. It opens its source's page, and creatinine's and the lab
eGFR's pages link to each other; the lab's own eGFR row leaves Blood tests only while the eGFR
row stands for it. The tiles are gone: each tile's explainer sits on its row's page
(`PlanTiles.pages`). The add sheet searches through the optional door `labSearchJson` and adds
by name in one place (`RecordEdit.labAddName`); an engine without the door lists the record's
own tests only. About you, units, alcohol, reminders, Apple Health and the record sit in a
settings sheet behind the person button; its close lets a due backup offer show (US-57 AC8).
The review prompt waits for a plan card on screen (US-25 AC10). The tour's three tips anchor on
the tab in Brad's words (US-57, approved 2026-11-05). Clarity's screen is "My health", with two
new events, "Jump pill tapped" and "Blood test added" (D9, Brad 2026-11-05). Sleep and Fitness
read Apple Health in their own view, so a live refresh never rebuilds the list.

**Documents at the foot (2026-11-09, US-73 AC12, the web's `HealthRecordsSection`).** The letters
and scan results the app files are listed after the sections: "Scan results", then "Documents",
newest first by health-core's `byNewestDocument`, the web's order too (Brad 2026-11-09). The engine
builds the list (`engine/documents.ts` `documentShelf`, `myData.documents`):
live rows only, never a lab archive row (health-core `isLabArchiveDocument`), with the web's kind
labels, now health-core's `DOCUMENT_TYPE_LABELS`. A row pushes `DocumentPage`: the markdown drawn as
SwiftUI text by `DocumentText` (no web view; links lose their target, since the words come from an
uploaded file), and "View original file", which reads the original by document id through the
optional door `documentOriginal` (`RecordStore.original(of:)`, only with a cloud open) into a
temporary file for Quick Look, removed when the preview closes; the read is cancelled if the page
goes, and `DocumentPage.sweep` clears leftovers when a page opens. Only the web's passive kinds open
(`DocumentPage.previewName`, mirroring `file-kinds.ts` `VIEWABLE_TYPES`, US-14 AC3). The engine
completes legacy rows with the web's defaults and Swift decodes the list row by row (review R1). No delete on the phone yet: the engine has no
document delete door, and the web's delete is its store's own tombstone (Brad's call).

## Phases

0. **Readiness (Brad, in progress 2026-10-21):** macOS upgrade, Xcode 26, Apple Developer
   Program as the company (D-U-N-S), a test iPhone.
1. **Spike, go/no-go:** done 2026-10-21 for the engine, Dropbox sync (stubbed and
   Node-tested; the live check waits on a sign-in) and Apple Health (simulator). The
   over-the-air update path (D3) was built 2026-10-22.
2. **TestFlight:** every feature is built (2026-10-21); a real iPhone and Brad's
   accounts are owed (launch-checklist.md).
3. **Health Records labs and camera lab upload.**
4. **App Store submission.**

## Where things stand (2026-10-23)

- **Done on main (pushed, a1276698):** shared document saving (39ff03a5); per-test units
  (d1199494); clinic letters and originals on the phone (1b6d58a7); the parsed-record memo, stage 1
  (b196f32a); Drive originals filed by the record folder's id (c8c2d7cd); plan cards and dark-mode
  diagrams (4fd330bc); Lp(a)'s three units, Dropbox folder picking and the MCP de-dup (84718d47);
  stage 2, the engine on its own queue with every record change in RecordStore's chain (merged
  bfaac736 after a clean adversary and Codex pass on the merge; its AC is US-25 AC21; bridge
  bcb25cd75e262be0). Installed on Brad's iPhone the same day.
- **Not deployed:** the website's shared document save waits for a real upload checked in Safari.
- **Stage-2 merge review follow-ups, done:** the Lp(a) menu holds entry and takes its chain
  turn in the tap (R1); reports are decoded on the shared pool, off both the main thread and the
  engine's queue, for Dropbox folders, Dropbox files and Files picks (`LabFileReader.decoded`, R2);
  the correction sheet's id stays its value's when its screen moves, with a test (R3).
- **Stages 3 and 4 (2026-10-23):** nothing in the app waits on the engine; launch shows
  a launch screen while the parts build off main; an opt-in debug watchdog logs main-thread
  stalls (US-25 AC21, AC21b, AC21c; the engine model section above).
- **Not started:** the "new reports in your Dropbox, read them?" prompt (web and phone; first
  test whether a picked Google Drive folder lets `drive.file` see inside it).

## Next, in order (2026-10-22)

1. Engine work off the main thread: stages 1 to 4 done (above). Left: profile Charts' first draw
   on a real iPhone (277 ms in a debug build in the simulator, 2026-10-23, the largest stall
   under an app screen).
2. US-56: resting heart rate, sleep, VO2 max and steps from Apple Health, read live (D6).
   Built 2026-10-25 (D6), checked on seeded simulator data; AC8's bands built 2026-10-26; left: the
   side-by-side comparison on Brad's iPhone with a watch.
3. `APP_ATTEST_TEAM_ID` on the education server, so chat and lab upload work on a phone (D8).
4. The Clarity masking check on a real recording (D9).
5. Known gap: an erase arriving from another device while a sheet is open may wait for the next
   launch to bring the questions back (US-54 AC7, adversary N2, unverified).


## Open questions and risks

- **Regulatory: we don't know.** Personalised medication and screening suggestions may count
  as software as a medical device in some markets (FDA, MHRA, EU MDR, NZ). Get advice before
  submission. App Review 1.4.1 asks medical apps to disclose their method.
- **D4** confirmed by Brad 2026-10-21; the move is under way (see D4). **iCloud** (D5) awaits the guideline check.
- **Hardware:** the build Mac is Intel. macOS 26 is the last Intel release, so a later
  required Xcode may need Apple silicon.
- **Two release paths:** binary changes still go through App Review; plan for it.
- **Follow-up: the eGFR choice into the engine (simplify on PRs 402 and 421, 2026-11-01, deferred).** Today
  each surface picks lab against calculated eGFR (`withLabEgfr`) before `calculateHealthResults`, and
  `labEgfrOutdated` rides on the inputs. The altitude review asks that `calculateHealthResults` make the
  choice and return `labEgfrOutdated` as a result. Deferred: it changes the engine contract and the bridge,
  so it needs its own PR, review and engine release.
- **Follow-up: the "cannot plan" sentence (US-07 AC8, 2026-11-01).** Since the engine plans
  without sex, health-core's `PlanError` means no usable height only, but `PlanView`'s
  `.needsDetails` text still says "Add your sex and height on My data". It is left as it is
  until an app release that ships with the new engine, so a new app on an old engine never
  under-asks. Then build the sentence from the profile, naming only what is missing.
