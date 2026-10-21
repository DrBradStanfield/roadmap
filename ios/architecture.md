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

**Shape chosen for sync (2026-10-21, cloud sync build): the polyfill.** The second shape (a
Swift `StorageAdapter`) would have kept merge in JavaScript but rewritten the Dropbox and
Drive request shapes, the conditional write and Drive's version check in Swift: the code
whose drift loses rows (dropbox-rest.ts's own header says so). The polyfill keeps all of
it shared, so a fix to `dropbox-rest.ts`, `drive-rest.ts`, `SyncManager` or
`RecordSession` reaches the phone with the next engine build. The bridge is small:
- Swift (`Engine/EngineNatives.swift`) supplies five primitives, installed as the global
  `__native` before the bundle runs: `http` (one URLSession request, body and answer as
  ArrayBuffers, headers as JSON) with `cancelHttp`, `setTimer`/`clearTimer` on the main
  queue, and `utf8Encode`/`utf8Decode`. Plus the cloud calls (`CloudPort`): an access
  token, the phone's record file, the pending marker, and `notify`.
- `ios/engine/shim.ts` builds on them exactly what the adapters touch: `fetch`,
  `Response`, `Headers`, `Blob`, `AbortController`, `AbortSignal` (`timeout`, `any`),
  `DOMException`, `setTimeout`/`clearTimeout`, `TextEncoder`/`TextDecoder`. A global the
  runtime already has is never replaced. Not shimmed, because nothing on the sync path
  uses them: `URL`, `URLSearchParams`, `atob`/`btoa`, `crypto.getRandomValues` (the token
  exchange is Swift's). Tested in Node (`shim.test.ts`, an empty vm context) and in
  JavaScriptCore (`ShimTests.swift`).
- Every JavaScript call, timer and answer runs on the main queue; URLSession answers hop
  there before they touch a JSValue (`MainQueueOnly` marks the one place Swift 6 is told
  rather than shown). Async engine doors return Promises; `HealthEngine.callAsync` awaits
  them with a continuation, and JavaScriptCore runs the promise jobs when each call from
  Swift returns. The bundle is 510 KB with sync.

### D3 · Clinical fixes ship over the air, signed (Brad, 2026-10-21; built 2026-10-22, US-25 AC18)

The engine bundle can be updated without an App Store release. Apple's developer agreement
allows an app to download interpreted code if it does not change the app's advertised
purpose; Expo Updates and CodePush rely on the same rule. Brad, 2026-10-22: "should
automatically come through if I update github". How to release: [engine-updates.md](engine-updates.md).

**What was built.** The release is three files in `ios/engine-release/bridge-<id>/` on
`main`: the bundle as `<sha256>.js`, `manifest.json` and `manifest.sig`, written by
`npm run engine:release` (`ios/scripts/release-engine.mjs`). The app reads them from
`raw.githubusercontent.com`. GitHub is a dumb host: trust comes only from the signature,
so a push to `main` by a loop or anyone else reaches no phone unless Brad's key signed it.
A signature means "the key holder approved this bundle", nothing more.

- **Signed, by pinned keys.** Ed25519 over `"health-roadmap-engine-manifest/v1\n"` plus
  the manifest's exact bytes (the prefix stops a signature made for anything else passing
  as a manifest's). Three keys, pinned by id in `EngineRelease.swift` and
  `ios/engine/signing-keys.json`: `daily` in Brad's login Keychain, trusted by no app, so
  every read asks him (adversary R9: not a 0600 file, which any process of his could
  read), and never anywhere else; `cold` in 1Password only, for a lost Mac; and `ci`,
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
- **The schema is the app's (R7).** A bundle whose record `schemaVersion` differs from the
  bundled engine's is refused. A schema change always needs an app update, so an over-the-
  air engine can never write a record the web or an older phone cannot read.
- **The bundled engine has a version** (`health-engine.json`, beside the bundle): the
  source commit's UTC minute, not the build time, so a release built later from the same
  source is newer, and an App Store update whose engine is newer deletes older downloads.
- **The check** (`EngineUpdater`): on coming on screen, launch included, at most once in 6
  hours. Two GETs (manifest, signature) on an ephemeral session: no cookies, no cache, a
  plain User-Agent, no redirects, 15 s timeouts, no health data, no device id. Only a
  verified manifest leads to the third GET, the bundle, read up to its declared size (8 MB
  cap) and refused unless its SHA-256 matches. It is staged in `Application
  Support/Engine` (left out of backups, as the record is) with its manifest and signature.
  Failures are silent and keep the current engine.
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
  cleared once the engine has shown the user's own record: My data drawn from it, or the
  plan, whichever comes first (`EngineTrial.confirm`, one call in `MyDataView` and one in
  `PlanView`; orchestrator's call, 2026-10-22). So a crash or hang on the real record
  counts, not only one on the self-test's fixture, while quitting does not: the app opens
  on My data, which confirms at once. Still there at the next foreground launch means
  that launch crashed or hung before the record was shown, and the version is marked
  bad. The cost that remains: a launch killed in that first moment, or a record My data
  cannot draw when the user never opens My plan, marks a good release bad on that phone,
  which then runs the bundled engine until the next release gets its own trial. A failed check or self-test marks it bad too. Bad
  versions are deleted and never tried again; the next staged version, or the bundled
  engine, runs. **Background launches (R8)** (a Health delivery) never try a new engine:
  they run only a version that passed a foreground launch, and an unreadable file there
  (before first unlock) means "not now", never "bad".
- **Swift holds the tokens; the network is fenced (R3, R4).** The engine's `accessToken`
  native answers the sentinel `native-token:<provider>`, never the token. Native `http`
  (`EngineHTTP`) sends only the allow-listed calls, method, host and path, of the provider
  the sentinel names: Dropbox `files/download`, `files/upload`, `files/list_folder`
  (+`/continue`); Drive `files` list, create, get (metadata and media) and the upload
  create and update. It swaps the real token in there and nowhere else. Any other
  Authorization or Cookie header, any other path (Dropbox `sharing/*`, `delete_v2`, Drive
  `permissions`), any other host (the app's own server included) or plain http is
  refused. The engine has its own ephemeral session, and every redirect is refused. So no
  engine, however changed, can send the record or a token anywhere new. Derived from
  dropbox-rest.ts and drive-rest.ts on the app's path; `get_metadata` and longpoll are
  left off because the app never calls them (push is web-only). **Before Drive sync goes
  live, check that Drive's `alt=media` download answers directly, without a redirect**:
  a redirect (to googleusercontent.com, say) is refused, which would break Drive reads.
- **Disclosed (R13, R14).** The privacy policy says GitHub sees the phone's IP address
  when it checks and the check carries no health data; the App Review notes say updates
  change computation and text only (ios/app-store.md). The plan line ("Worked out on this
  iPhone", D9) stays true.
- **Automatic on GitHub.** Workflows are Brad's, so agents wrote the job for him to paste
  (engine-updates.md, R1): a secret-less build job, then a signing job in a separate
  `engine-signing` environment with Brad as required reviewer, which runs no repo code
  (openssl and git only) and shows the manifest, the hashes and the source diff since the
  last release before it signs. Until he pastes it, releasing is the local script.
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
  (`MyData/RecordStore.swift`): `Application Support/Record/health-roadmap.json`, the web's schema,
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
  explicitly (`sessionOpen`); a failed reopen falls back to the phone's file; a generation
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
  (US-34). Until then the app polls each minute while on screen. Documents are not synced
  by the app (its adapter refuses them).
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
  - **An unreadable phone record refuses the erase.** The web erases a device copy it cannot
    read with its own epoch; the app has no working copy then, and never writes over a record
    it cannot read (US-25 AC4). The user sees why.
  - **After a cloud erase the phone copy is the erased record**, not absent: the session wipes
    the pre-erase copy and the pending marker, then the erased record goes in its place, so an
    offline launch opens on it, as every other cloud change reaches the phone copy.
  - **Chat history** (a phone-only file) is tombstoned by the engine's `ChatSession.eraseAll`
    and written only when that step ran. **Gap:** an erase made on the web reaches this
    phone's record and reminders but not its chat history. Closing it needs the phone to
    remember the erase epoch its chat last saw, as the reminders opt-in does; not built.
  - **Units are kept** (a setting; the web keeps its unit preference through an erase), the
    welcome flag and the AI consent are kept, the sync connection is kept.
  - **Reminders** need no step of their own: the opt-in ends when the epoch moves (D7).
  - **Apple Health** (merged in the same evening): after the record erase, `AppleHealthSync.
    eraseOwnSamples` deletes every sample this app wrote (HealthKit's source predicate, kinds
    it may write) and clears `HealthSyncMemory`'s written versions. The import anchors stay,
    so other apps' readings from before the erase are not imported again. A refused delete
    never undoes the record erase; the words say so. Not checked on a real iPhone.
  - **Export** is the record as shown (`store.recordJSON`) through the share sheet, written by
    the share sheet itself (`RecordExport`, a `DataRepresentation`), so the app keeps no
    stray copy. The website has no "load a file" flow; that would be a web feature.

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

**Built 2026-10-21 (app).** `HealthRoadmap/Health/`: `HealthKitClient` is the only file that
touches HealthKit (types, SI units, anchored queries, observer queries, saves), behind the
`HealthStoreClient` protocol so the tests run on a fake. `AppleHealthSync` runs it on the
main actor, as `RecordStore` does, so an import and a typed save never overlap; a refresh
asked for during one loops once more. Its decisions:
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

**Entitlement.** `ios/HealthRoadmap.entitlements` (HealthKit, with background delivery, no
Health Records access) is set as `CODE_SIGN_ENTITLEMENTS`; the purpose strings are
`INFOPLIST_KEY_NSHealthShareUsageDescription` and `...UpdateUsageDescription`. The simulator
build signs it locally with no team. **For Brad, once the Apple Developer team exists:** set
the team in Xcode (Signing & Capabilities), confirm the App ID `com.drbrad.healthroadmap`
has the HealthKit capability (Xcode adds it when signing automatically), and test the
background delivery and blood pressure both ways on a real iPhone: the simulator shows
neither. App Store Connect's privacy answers must list Health data (read and written, not
linked to tracking, kept on the device), the review notes should say why the app reads
Health, and a HealthKit app needs a privacy policy URL. The read purpose string says the
values go only into the person's record, on the iPhone or in the Dropbox or Google Drive
they connect (changed at the cloud-sync merge, 2026-10-21). Health values reaching chat, as
part of the record's summary, are a guideline 5.1.3 disclosure question for the chat consent. Whether a device backup counts as "iCloud"
under 5.1.3 is the D5 backup question, still open.

**Out of scope 2026-10-21: blood tests from Health Records** (`HKClinicalRecord`). Below
is the plan for them, not built.

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
  Brad prefers the name ("Colonoscopy due") on the lock screen.
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
`supabase/app-attest-2026-10.sql`, not run by agents): `app_attest_keys` with `key_id`
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
- Per IP, in memory: 10 registration attempts, 200 turns, 200 files a day. IPv6 is keyed
  on its /64, which one subscriber holds whole, so rotating addresses inside it buys
  nothing. IPv4 is keyed on the address, so phones behind one carrier NAT share a bucket:
  the price of having one; 200 is set high for that reason.
- Per machine, in memory: `APP_CHAT_DAILY_CAP` turns (default 500) and `APP_LAB_DAILY_CAP`
  files (default 300). Lab files also spend the web's per-machine file cap
  (`machineFiles`, `AI_DAILY_FILE_CAP`, 2000), but the app's own cap is smaller, so the
  app can never use up the web's and the connector's uploads (R5); the code also holds it
  at or under 15% of `AI_DAILY_FILE_CAP` whatever the env says.
- Per IP, refused signed requests: 50 a day. Past that, the gate reads neither the key nor
  the body (code review R3).
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
- Counter stale (401 `stale_counter`): one retry with a fresh assertion.
- Key store down, or `APP_ATTEST_TEAM_ID` unset: 503. Never open.
- Over a limit: 429 with a plain message; no model call.

**Config.** `APP_ATTEST_TEAM_ID` (no default: Apple enrolment pending; until set, the
endpoints answer 503), `APP_ATTEST_BUNDLE_ID` (default `com.drbrad.healthroadmap`, the
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

### D9 · No server telemetry (Brad, 2026-10-21)

The app sends no product events to Brad's server. The usage signal is App Store Connect
analytics (installs, sessions, retention, crashes, from users who opt in). Stated limit: it
cannot see "viewed a plan". Health values never enter any telemetry.

The plan screen said "No health data left your device". That was true only while the app
had no network code; D8's chat and upload re-derived it to "Worked out on this iPhone"
(2026-10-21). The first network call (D3's update check, D5's sync, D8's chat)
must re-derive that sentence in the same commit.
D3's update check (2026-10-22) sends no health data, so the plan line stands; the
privacy policy names GitHub. With D5's sync (2026-10-21) the plan line stays as it is: it claims only where the
plan was worked out. Where the record is kept is said on My data
(`SyncStatusText.myDataFooter`): the connected cloud, or after a Disconnect that a copy
stays in the cloud synced earlier, or only this iPhone.

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

## Build and test

**Layout.**
- `engine/entry.ts`: the one door Swift calls, JSON in and out: `planJson`,
  `sectionsJson`, and for My data `newRecordJson`, `myDataJson`, `applyEditJson`,
  `numberJson`. Every door reads the record through health-core's `ROADMAP_DOC.migrate`
  (shape check, then migration), as the web, CLI and connector do.
- `engine/shim.ts`: fetch, timers and friends over Swift's natives (D2). `engine/cloud.ts`:
  the phone's `RecordHost` and the cloud doors Swift calls (`cloudOpen`, `cloudEdit`,
  `cloudVisible`, `cloudHidden`, `cloudRefresh`, `cloudFlush`, `cloudClose`), D5. Both
  tested in Node by `shim.test.ts` and `cloud.test.ts`, which `test:all` runs.
- `engine/reminders.ts`: the phone's reminders, `remindersJson` in `entry.ts`: health-core's
  schedule plus the notification days (D7). Tested by `engine/reminders.test.ts`.
- `engine/my-data.ts`: what the My data tab shows and every write it makes, each one
  health-core's own (`createEmptyFile`, `updateProfile`, `stampProfile`,
  `appendMeasurement`, `correctValue`, `upsertMedication`, `upsertSupplement`), with
  values in the user's units (US-25 AC7). Not yet through `RecordSession.edit` (D4).
- `engine/my-data-forms.ts`: the medication, screening and supplement questions
  (health-core `input-form.ts`) for the plan's age, sex and cascades, their answers
  (only a shown question, only an offered answer, then the web's writes), and
  `metricHistory` (every row of a metric, entered-in-error included). Entry door:
  `historyJson`. Tested in Node by
  `engine/my-data.test.ts`, which the web's `test:all` runs.
- `scripts/build-engine.mjs`: bundles health-core with esbuild (target Safari 17, iOS 17's
  JavaScriptCore) into `HealthRoadmap/Engine/health-engine.js`, and writes the parity
  goldens. Run it before any Xcode build: `node ios/scripts/build-engine.mjs`. Its outputs
  are generated and ignored by git.
- `scripts/release-engine.mjs` (`npm run engine:release`), `scripts/engine-keygen.mjs`,
  `scripts/engine-signing.mjs`: signed over-the-air releases into `engine-release/` (D3).
  `engine/bridge-contract.json` is the native bridge's contract; its hash is the bridge id.
  Tested by `scripts/release-engine.test.ts`, `scripts/signing-key-guard.test.ts` and
  `engine/bridge.test.ts`.
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
  - `Engine/`: `HealthEngine.swift` loads the bundle into a `JSContext` and awaits its
    Promises; `EngineNatives.swift` is the bridge (D2); `EngineHTTP.swift` its network
    fence (D3); `HealthEngine+Cloud.swift` the typed cloud doors. The generated bundle and
    its `health-engine.json` sidecar sit beside them.
  - `EngineUpdates/`: over-the-air engines (D3, AC18). `EngineRelease` (pins, bridge,
    limits, address), `EngineManifest` (`ManifestCheck`), `EngineFolder` (staging and
    state), `EngineUpdater` (the check), `EngineBoot` (which engine runs),
    `EngineSelfTest` (the quarantine's test and `QuarantinePort`).
  - `Sync/`: cloud sync (D5, US-25 AC11). `CloudProvider` (client ids, redirects),
    `PKCE`, `TokenStore` (Keychain), `OAuthClient` (sign-in and refresh), `CloudSync`
    (opens the engine's session, follows the app on and off screen, answers the engine's
    `CloudPort` calls), `SyncProblem` and `SyncStatusText` (the words), `SyncView` (the
    screen, from My data's toolbar).
  - `MyData/`: the record and its tab. `RecordStore` keeps the file and applies edits
    through the engine; `MyData.swift` is the engine's view of the record and the
    `RecordEdit` the tab sends; `MyDataView`, `ValueEntrySheet` and `DayText` draw it.
    The form sections (US-25 AC8): `FormModels` (the engine's question JSON and `FormEdit`),
    `FormFieldRow` (one question: menu, month wheel, number or dated value),
    `FormSectionsList`, `MedicationsSection`, `ScreeningsSection`, `SupplementsSection`
    with `SupplementSheet`. Value history (AC9): `MetricSheet` (history, or entry when
    empty) and `HistoryView` (Swift Charts trend, tap to correct, no delete).
  - `Reminders/`: on-device reminders (D7). `PhoneReminders` is the engine's answer,
    `ReminderScheduler` keeps the pending notifications equal to it behind
    `NotificationScheduling` (a fake in the tests), `ReminderTaps` sends a tap to My plan,
    and `RemindersSection` is the switch and list in My data.
  - `Health/`: Apple Health (D6). `HealthKitClient` is HealthKit; `AppleHealthSync` runs
    the import and the writes; `HealthReading.swift` is what crosses to the engine;
    `HealthSyncMemory` the anchors; `AppleHealthSection` the row in My data.
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
  (AC6); `DayTextTests` pins the local day; `FormEditTests` runs the form answers,
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
1. **Spike, go/no-go:** done 2026-10-21 for the engine, Dropbox sync (stubbed and
   Node-tested; the live check waits on a sign-in) and Apple Health (simulator). The
   over-the-air update path (D3) was built 2026-10-22.
2. **TestFlight:** every feature is built (2026-10-21); a real iPhone and Brad's
   accounts are owed (launch-checklist.md).
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
