# Root fixes (owner triage, 2026-11-25)

The owner triaged the open state leads on 2026-11-25 (`main` at 27544b343).
Most open leads share a cause. Each root fix below is written above the leads
it closes, as the untangle skill's decision log asks. Ranked: privacy and data
loss first. Each lead file names its fix at the start of `evidence`
("Root fix R<n> ..."). Class is in brackets; "phone" means a simulator run and
an engine release, so it cannot land on CI alone.

## Ranked

Where each fix stands, checked 2026-11-27 against `main` at 908d2ae45, each PR's state and the code. Read this
table first; the numbered list under it is the 25 Nov triage and the dated sections are history. States: done,
part done, open (can start), held (built, PR open with `hold`), blocked (waits on a decision or another PR).
`tools/untangle-ledger.test.ts` fails when a fix in the list has no row here.

| R | Fix | State | What is left | PRs | Blocked by |
|---|---|---|---|---|---|
| R1 | Reminders opt-in writer re-checks after it lands | blocked | the whole fix (lead H126) | none | the owner's schema decision |
| R2 | report_feedback's value check uses the scrub's rule | done | nothing (lead H70) | 2090 | |
| R3 | Erase side steps run after the record write lands | part done | steps 1b (the read rule), 2 (the web order), 3 (the iPhone) (lead S59a) | 2134 | step 1b: a design ruling (orchestrator) |
| R5 | Every store write takes its erase as an argument | done | nothing (leads H18-H24, H107, H109) | 2070, 2081, 2096, 2104, 2105, 2106, 2128 | |
| R4 | Off-file leftovers carry the erase they were written under | part done | PR 3 (the stamps) and PR 4 (delete the per-browser key) (lead A23); no longer waits on R5; its files overlap held PR 2155 | 2140, 2182 | |
| R6 | Every storage failure carries a typed reason | part done | web: H127's other checks (design first); phone half: H134, M6, M8 (phone), S57d | 2085, 2108, 2115, 2116, 2118, 2136, 2188 | H127: a design; its Drive grant check sits in files PR 2099 edits |
| R7 | iPhone keeps the landed record's erase epoch apart from its drawing | open | leads H113, H130, H200; iPhone erase series, one at a time | none | |
| R8 | The unsent erase is one persisted owed state | open | leads H119, H120 (H121 waits on words); iPhone erase series | none | |
| R12 | Clear pending reminder notifications after an erase | open | lead S68, design note first; iPhone erase series | none | |
| R9 | Opt-in merge: a cancel beats an opt-in only for its own token | open | lead H115: design note with a convergence proof first | none | orchestrator's call (merge) |
| R13 | One record-apply hold state | held | H14's follow-up built: an out-of-range value, refused or half-typed, holds no remote change (US-34 AC13, the form alone) | 2084, 2110, 2113, 2117, 2119 merged; 2218 held | PR 2218 |
| R14 | A malformed Observation date is refused or flagged | done | nothing (lead H35) | 2181 | |
| R22 | Value page Add fields read-only while saving | done | nothing (lead H301, US-03 AC2b) | 2060 | |
| R10 | Delete all my data and Log off from every failure screen | part done | H122 (design first, iPhone erase series); H123a, the iPhone's cannot-start screen (decided, after App Store review) | 2158 (H123, the web crash screen) | H123a: App Store review |
| R16 | The phone reads its constants and rules from the engine | open | M1 M2 M3 M4 M5 M7 M9 M11 M14 M16 U14, several PRs; new engine doors share contract files with held PRs 2203 and 2204 | none | |
| R11 | After a remote erase the questions cover waits on one sheets-closed state | open | leads S16, S65, S71; iPhone erase series; PR 2209 edits `RootView.swift` and `MyDataView.swift` | none | |
| R15 | Chat history open is one state that retries | held | lead A2's two lines and marker | 1643, 2078 merged; 2151 held | PR 2151 |
| R19 | Reminders toggle is one union; the switch hold one state | part done | the switch hold only (lead A4); toggle done (H116, US-17 AC18) | 2058 | R1 (owner: hold union built after R1, behaviour kept) |
| R21 | One page-hide path | done | nothing (lead H92) | 2095, 2097 | |
| R20 | A save failure is reported once per cause and grant | part done | the iPhone half: `ios/engine/cloud.ts` host reads `repeat` (lead A25) | 2130 | |
| R23 | Upload ticks and save-all stops from one engine rule | done | closed, superseded by the shared upload engine (U12 keeps a test gap) | 1913, 1972 | |
| R17 | Phone allow-list from the adapters; one file-kinds rule | part done | M12 not started; M13 built | 2204 held | M12: PR 2099; M13: PR 2204 |
| R33 | Security track | blocked | leads C14, C19 | none | the orchestrator |
| R24 | Chat docs load as one state | held | lead T38's YouTube half (US-15 AC82) | 2124, 2184, 2187 merged; 2210 held | PR 2210 |
| R26 | Hosted MCP import commit gets the permanent-write pause | done | nothing (lead H58) | 2126 | |
| R18 | A stopped web page names its real cause | done | nothing (leads C30, A12, C29, C32) | 2122, 2154 | |
| R25 | Lab batch poll answers error | done | closed: PR 1846 removed the poll; no code needed (lead C18) | 1846, 2121 | |
| R27 | AppleHealthSync run state as one union | part done | the union landed (H27's row still says not started); left: whether `started` and `asking` are modes or plain guards | 1694 | |
| R28 | YouTube bot lifecycle as one union; cleanup keeps skips | done | nothing (leads H49, H48) | 1866, 2087 | |
| R29 | iPhone chat: a failed thread read is one state | held | lead C24; Swift tests not yet run | 2202 | PR 2202 |
| R30 | BP systolic auto-advance rule once in health-core | held | lead H73 | 2203 | PR 2203 |
| R31 | Confirmed-values tests get positive controls | done | nothing (lead H95) | 2123 | |
| R32 | Land the open PRs | held | A29 in draft PR 1788 (behind main, conflicting since 14 Nov); H108 done | 2059 merged (from closed 1778); 1788 held | PR 1788 (its `drive.ts` also in PR 2099) |

### Next up, independent

Open fixes that touch no file an open PR edits, in rank order. Checked: PRs 2099, 2146, 2151, 2152, 2155,
2201, 2202, 2203, 2204, 2209 and 2210; not checked: the contributor's glossary PRs, which touch wording across
many files. The iPhone erase fixes (R6 phone, R7, R8, R12, R11, R10's H122) share `DataEraser.swift`,
`CloudSync.swift`, `RecordStore` and `ios/engine/cloud.ts`: start one, not several.

1. **R6 phone half** (H134, M6, M8 phone, S57d): `ios/engine/cloud-adapters.ts`, `ios/engine/shim.ts`,
   `EngineNatives.swift`, `OAuthClient.swift`, `EraseText.swift`. Simulator: yes; engine release.
2. **R9** design note only (H115): `packages/health-core/src/merge.ts` when built. Simulator: no for the note;
   engine release when built. The orchestrator's call.
3. **R13** follow-up (H14): built, held in PR 2218 (US-34 AC13).
4. **R20 iPhone half** (A25): `ios/engine/cloud.ts`. Engine tests; engine release; shares `cloud.ts` with the
   iPhone erase series.
5. **R27** remainder: `ios/HealthRoadmap/Health/AppleHealthSync.swift`. Simulator: yes. May close with no code.

Not independent today: R4 (files held PR 2155 edits), R16 (engine contract files in PRs 2203, 2204), R11
(PR 2209), R1, R3, R17, R19, R32, R33 (blocked above).

### The 25 Nov triage

1. **R1** The device that writes a reminders opt-in re-checks after it lands, and cancels its own row under a newer erase. [privacy] `widget-src/standalone/reminders.ts`
   - H126
2. **R2** report_feedback's health-value check uses the Sentry scrub's rule. [privacy] `packages/health-core/src/mcp-feedback.ts`
   - H70
3. **R3** Erase side steps (chat tombstones) run only after the record write lands; design note first. [record erase] `record-session-erase.ts`
   - S59a
   - Design: docs/drafts/s59a-chat-erase-order-design.md
4. **R5** Every store write takes its erase as a required argument, then the store mark goes; pins first, then types, then delete the mark (3 PRs). Design: docs/drafts/h18-h24-erase-by-type-design.md. [record save/erase] `roadmap-store.ts`, `record-session.ts`, `standalone/reminders.ts`, upload and list-save hooks, `roadmap-data.ts`, `HealthTool.tsx`, `MatrixSavedCells.tsx`
   - H18 H18b H18c H18d H19 H20 H21 H22 H23 H24 H107 H109
5. **R4** Each off-file leftover (matrix draft, stored original, Lp(a) answer) carries the erase it was written under; a clear removes only older ones; one report per failed clear. [record erase] `record-session.ts`, `record-session-erase.ts`, `cleared-erase.ts`, `roadmap-data.ts`, `roadmap-store.ts`
   - A23
   - Design: docs/drafts/r4-leftover-stamps-design.md
   - Status: PR 1 done (US-11 AC12); PR 2, test-only pins of what each clear removes, in review (PR 2182); PRs 3 and 4 wait for R5.
6. **R6** Every storage failure carries a typed reason, set where it is raised (definite, may have landed, no answer); nothing reads words. Two halves. [record save/merge] health-core: `write-refusal.ts`, `save-state.ts`, `drive-rest-*.ts`, `sync-manager.ts`, `dropbox.ts`; phone: `ios/engine/cloud-adapters.ts`, `shim.ts`, `EngineNatives.swift`, `OAuthClient.swift`
   - health-core half: S62b S57c H127 M8 (web)
   - phone half: H134 M6 M8 (phone) S57d
   - Design: docs/drafts/r6-typed-storage-outcome-design.md
7. **R7** The iPhone stores the landed record's erase epoch apart from its drawing; an engine door reads a refused file's raw eraseEpoch. [phone, privacy] `RecordStore+*.swift`, `AppleHealthSync.swift`, `DataEraser.swift`, `ios/engine/cloud.ts`
   - H113 H130 H200
8. **R8** The unsent erase is one persisted owed state; Disconnect reads it, a landed erase clears it. [phone, privacy] `ios/engine/cloud.ts`, `CloudSync.swift`
   - H119 H120 (H121 waits on words)
9. **R12** Clear pending reminder notifications right after a non-refused erase outcome. [phone, privacy] `DataEraser.swift`
   - S68
10. **R9** Opt-in merge: a cancel beats an active opt-in only for its own token; convergence proof first. [merge, privacy; the orchestrator's call] `packages/health-core/src/merge.ts`
    - H115
11. **R13** One record-apply hold state that ends on the next edit, read by the page and the chat. [record read] `useRecordApply.ts`, `ChatEdits.tsx`, `HealthTool.tsx`
    - H14 H15 H16
    - Design: docs/drafts/r13-record-apply-hold-design.md
12. **R14** A malformed Observation meta or effectivePeriod is refused or flagged, never re-dated to issued. [FHIR import; the orchestrator's call] `health-records-fhir.ts`
    - H35
    - Design: docs/drafts/h35-malformed-observation-dates-design.md
13. **R22** The value page's Add fields are read-only while the save runs. [UI, typed text lost] `ValuePage.tsx`
    - H301
14. **R10** Delete all my data and Log off are reachable from every failure screen. [privacy] `RecordStore.swift`, `DataEraser.swift`, `HealthRoadmapApp.swift`, `standalone/app.tsx`, `ErrorBoundary.tsx`
    - H122 (H123 H124 wait on words)
15. **R16** The phone reads its constants and rules from the engine: dose limit, notification limit, 9am hour, rules version, trend windows, unit-region rule, number caps, creatinine link, VO2 text, upload rules. Several PRs. [Android share] `units.ts`, `recent-trend.ts`, `validation.ts`, `vo2max-bands.ts`, `upload-rules.ts`, `ios/engine/reminders.ts` and their Swift copies
    - M1 M2 M3 M4 M5 M7 M9 M11 M14 M16 U14
16. **R11** After a remote erase the questions cover waits on one named sheets-closed state. [phone] `RootView.swift`, `FirstRun.swift`, `CloudSync.swift`
    - S16 S65 S71
17. **R15** Chat history open is one state that retries on the next turn, never the server path while a history layer exists. [web chat] `chat-history-access.ts`, `chat-api.ts`, `useChatState`
    - A2 C26b
18. **R19** The reminders toggle is one ToggleStep union with `transition()`; the hold boolean and key become one state. [UI mode] `standalone/reminders-control.tsx`, `reminders.ts`
    - A4 H116
19. **R21** One page-hide path: every cell stages, then one flush. [record save] `HealthTool.tsx`, `MatrixSavedCells.tsx`, `roadmap-data.ts`
    - H92
    - Design: docs/drafts/r21-one-page-hide-path-design.md
20. **R20** A save failure is reported once per cause and grant, also on a closed page. [save status] `record-session.ts`, `record-host.ts`, `web-record-host.ts`, `ios/engine/cloud.ts`
    - A22 A25
21. **R23** Upload review default ticks and save-all stop causes come from one engine rule. [Android share] `review-matrix.ts`, `LabReportSave.swift`, `RecordStore.swift`
    - U10 U12
22. **R17** Generate the phone's network allow-list from the adapters; one file-kinds rule for both clients. [security] `EngineHTTP.swift`, `dropbox-rest.ts`, `drive-rest.ts`, `file-kinds.ts`, `DocumentPage.swift`
    - M12 M13
23. **R33** Security track, held by the orchestrator.
    - C14 C19
24. **R24** Chat docs load as one state; a missing doc refuses or reports, like the prompt. [server] `app/lib/chat.server.ts`, `chat-router.server.ts`
    - H66 T28
25. **R26** The hosted MCP import commit gets the same pause as other permanent writes. [server, agent contract] `app/lib/mcp-step.server.ts`
    - H58
26. **R18** A stopped web page names its real cause from one stop state. [web sync] `standalone/connect.ts`, `sync-control.tsx`, `pkce.ts`
    - C30 (A12 C29 C32 wait on words)
27. **R25** The lab batch poll answers error, never processing 0; the hour cancel is told. [server] `api.lab-import-v2.ts`, `lab-batches.server.ts`
    - C18
28. **R27** AppleHealthSync run state as one union. [phone mode] `AppleHealthSync.swift`
    - H27
29. **R28** YouTube bot lifecycle as one union; the cleanup keeps skips. [server] `youtube-bot.server.ts`, `supabase/rls-policies.sql`
    - H49 H48
30. **R29** iPhone chat: a failed thread read is one failed state. [phone] `ChatHistoryStore.swift`, `ChatView.swift`
    - C24
31. **R30** The BP systolic auto-advance rule lives once in health-core and the phone reads it. [Android share] `BloodPressureSheet.swift`
    - H73
32. **R31** Confirmed-values tests get positive controls. [tests]
    - H95
33. **R32** Land the open PRs. [web]
    - A29 (PR 1788), H108 (PR 1778)

## Must not run in parallel

- R1, R5 and R19 all edit `widget-src/standalone/reminders.ts`.
- R4, R5, R6 (health-core half) and R20 edit `record-session.ts`; R4 and R5 also `roadmap-store.ts` and `roadmap-data.ts`.
- R3, R4 and R6 (the M6 part) edit `record-session-erase.ts`.
- R5, R13 and R21 edit `HealthTool.tsx`; R5 and R21 also `MatrixSavedCells.tsx`.
- All iPhone erase work (R6 phone half, R7, R8, R10, R11, R12) shares `DataEraser.swift`, `CloudSync.swift`,
  `RecordStore` and `ios/engine/cloud.ts`, and one simulator: run them in series.
- Independent of all the above: R2, R14, R15, R22, R24, R25, R26, R28, R31, R32.

## Status, 26 Nov 2026

Checked against `main` at `b2548fe3d` and each PR's state.

- **R25** closed: PR 1846 removed the batch poll it named before the triage; lead C18 closed (PR 2121).
- **R24** chat docs load as one state (PR 2124); the rest (every doc, read once at server start, `createChatDocs(root)`) in PR 2184 (draft, held); lead T28 done with it.
- **R24** follow-up, lead T38: the classifier prompt joins the state (PR 2187, US-15 AC81); the YouTube prompt template waits on open PR 2183, which changes `app/lib/youtube-context.ts`.
- **R31** done (PR 2123). The erase test pins H107 and H109 are done (PR 2128).
- **R26** merged (PR 2126).
- **R20** web half merged (PR 2130); the phone half is left.
- **S-24** one-use sets are bounded (PR 2131).
- **H302** merged (PR 2133).
- **R3** step 1a merged (PR 2134); steps 1b, 2 and 3 are left.
- **R6** PR 5 (S57c) merged (PR 2136).
- **S-1** step 1 merged (PR 2135).
- **H406** chat mirror with one writer: open (PR 2132).
- **H404** widgets follow an erase: open (PR 2127).
- **R18** the switch stop names its cause in its own words (PR 2122).

## Status, 26 Nov 2026 (second run)

Brad settled the open wording and product items ([decisions-for-brad.md](../decisions-for-brad.md), Decided,
2026-11-26). Merged: PRs 2079, 2122, 2144, 2145, 2147, 2148, 2149, 2150, 2153, 2154, 2157, 2158, 2160, 2161 and
2163. Built and held, not merged: PR 2146 (three failure lines; leads H39, H117, H128), PR 2151 (chat history
lines and the "Not saved" marker; leads A2, C22), PR 2152 (per-row refusal in an upload; lead U11) and PR 2155
(the upload clause in Settings; lead W2-17). Decided and not started: the glossary PRs (waiting on the contributor),
untracking the built storefront bundles, splitting the story file, and one workflow PR for CI tidying.

## Status, 26 Nov 2026 (third run)

Brad settled the rest of the open list ([decisions-for-brad.md](../decisions-for-brad.md), Decided, 2026-11-26).
Merged: PRs 1604 (old PSA answers), 1610 (prostate words), 1805, 1806, 1607, 2082 (per-address limits, raised
for IPv6 keys; lead S-21 partial), 2173, 2175 and 2176. Closed as superseded: PR 1601. Decided and not built: the
Apple Health malformed-date skip (next iPhone build), the prostate stop age and flag line, and the 45 to 49 card,
which waits for Brad's look.

## Status, 27 Nov 2026

- **R6** web, lead H127: the picker's switch stop reads the typed log-off reason (US-09 AC64, PR 2188, merged).
  H127's other web checks (transport silence, refused Drive grant, busy write, corrupt device copy) need a typed
  field that does not exist yet: a design first. The Drive grant check sits in files held PR 2099 edits.
  Ruled as recorded in the H127 lead row.
- **R23** closed, superseded by the shared upload engine. The two old rules are deleted (`review-matrix.ts`
  in PR 1972, `LabReportSave.swift` in PR 1913). One engine rule sets the default ticks (`upload-review.ts`),
  and the phone saves an upload in one call. Leads U10 and U12 done; U12 keeps one open line, a test gap.
- **R17** owner rulings (both as changed later that day). Lead M12, not started, built after PR 2099 lands:
  one shared route table, a plain data file in the repo, is the single source. The cloud adapters read
  their routes from it; at build time it is generated into a constant compiled into the iPhone app (later
  the Android app the same way), so no platform hand-writes a list. The native app, not the over-the-air
  engine, enforces it; a new route takes effect only with a new app build. A table change is security class
  (adversary + Codex), and a test fails when an adapter uses a route outside the table. After Brad's word
  that the clients share as much as possible: one open rule in health-core for both clients (the
  extension decides; with no extension, the stored type decides; only the existing passive viewable types),
  built as its own PR with an adversary and Codex review (lead M13, in progress).
- **R24** finished: PR 2184 merged. Its follow-up, lead T38: the classifier half merged (PR 2187); the YouTube
  half is no longer held, since PR 2183 merged; next, `app/lib/youtube-context.ts` joins `ChatDocsState`.
- **R4** PR 2 merged (PR 2182).
- **R14** merged as PR 2181 (lead H35).
- **R24** follow-up, lead T38, done: the YouTube prompt template joins `ChatDocsState` as an optional doc
  (US-15 AC82); its import-time reader in `app/lib/youtube-context.ts` is gone.
- **R28** closed, both leads done before this check: H48, the cleanup keeps skips (PR 1866, US-15 AC68:
  `cleanupSkippedRows` deletes by age; the RPC is no longer called), and H49, the lifecycle as one union
  (PR 2087, `app/lib/youtube-bot-lifecycle.ts` with its table test). The unused RPC stays in
  `supabase/rls-policies.sql` until it is dropped live.
