# Root fixes (owner triage, 2026-11-25)

The owner triaged the open state leads on 2026-11-25 (`main` at 27544b343).
Most open leads share a cause. Each root fix below is written above the leads
it closes, as the untangle skill's decision log asks. Ranked: privacy and data
loss first. Each lead file names its fix at the start of `evidence`
("Root fix R<n> ..."). Class is in brackets; "phone" means a simulator run and
an engine release, so it cannot land on CI alone.

## Ranked

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

- **R6** web, lead H127: the picker's switch stop reads the typed log-off reason (US-09 AC64, PR 2188, held).
  H127's other web checks (transport silence, refused Drive grant, busy write, corrupt device copy) need a typed
  field that does not exist yet: a design first. The Drive grant check sits in files held PR 2099 edits.
