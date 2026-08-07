# User Stories — Health Roadmap

The user-perspective spec for every journey in the tool. Written 2026-08-07, grounded in the first usage audit ([usage-audit-2026-08.md](usage-audit-2026-08.md)); the architecture reference is [architecture-v2.html](architecture-v2.html). Each story carries acceptance criteria (AC), the **usage evidence** we have, and the **test status** against the current suites.

**Maintenance contract:** when a feature's behavior changes, update its story here in the same commit. New tests should cite the story ID (e.g. `US-04`) in a comment. The weekly product-health loop reads this file to judge whether reported friction contradicts an AC.

Legend for test status: ✅ covered · 🟡 logic covered but UI/journey untested · ❌ untested.

---

## Epic A — Entering health data

### US-01 · Progressive first fill (guest)
As a first-time visitor, I can start getting value by entering just sex + height, and the form progressively reveals more fields so I'm never confronted with a wall of inputs.
- AC1: Stage 1 shows only Units/Sex/Height; filling Sex+Height reveals Stage 2 (weight, waist, BP, birth month); filling Weight reveals Stage 3 (bloods, meds, screening, supplements).
- AC2: The next-expected field pulses (`.field-attention`).
- AC3: A returning visitor with saved data sees the full form immediately.
- AC4: Everything works with zero account/cloud — data persists in localStorage.
- Evidence: recordings show fast Stage-1 completion (8 clicks in 72s) and long engaged fills; blog→"Build my free plan"→tool is the working funnel.
- Tests: 🟡 `computeFormStage` in mappings.test.ts; no test that stages actually gate rendering. Gap: none planned (low churn).

### US-02 · Vitals entry incl. blood-pressure pair
As a user, I can type height, weight, waist and a paired systolic/diastolic BP quickly, and **my first click/tap on any cell or its unit label focuses the input** — no dead clicks.
- AC1: Clicking anywhere in a vitals cell (including placeholder text and the `mmHg`/unit chip) focuses the editable input.
- AC2: A BP entry is accepted only as a complete sys/dia pair; a half-pair doesn't save.
- AC3: Values are validated against clinical ranges with ok/warn/bad ticks before save.
- Evidence: **top friction in the audit** — dead clicks on the BP `▫▫▫/? mmHg` control and `mmHg` label in 3 of 15 recorded sessions; tooltip/units-picker dead clicks in 4.
- Tests: 🟡 `StartingInfoVitals.test.ts` covers BP pair routing/readiness logic; `blood-test-cell.test.ts` covers validation. ❌ No test that a cell-shell click focuses the input (the actual reported friction). **Action: fix + test (2026-08 backlog #1).**

### US-03 · Blood-test matrix entry & backfill
As a user, I can enter today's blood results in a draft column, and backfill older results under their historical date, and the matrix keeps every column aligned and scroll-synced.
- AC1: Draft column accepts values + a date (DraftDateCell); saving appends immutable measurements under that date.
- AC2: Typing into an existing dated column routes as backfill for that date.
- AC3: At most one active row per (metric, day); a same-day re-entry routes through correction (US-04), never a silent overwrite or lost draft.
- AC4: A failed save preserves the typed draft for retry.
- Evidence: engaged sessions show field-by-field entry of masked numeric values; feedback email 2026-03-22 reported values appearing under a wrong date (root cause never found).
- Tests: 🟡 `matrix-save.test.ts` (task routing), `blood-test-cell.test.ts` (validation), merge tests (slot invariant). ❌ The wrong-date report has no regression test pinning date-defaulting semantics. **Action: add date-semantics tests (this pass).**

### US-04 · Correcting a saved value (FHIR)
As a user who mistyped or whose lab import was wrong, I can click the saved cell, type the right value, and the display updates — while the old value is preserved as `entered-in-error` with a `correctsId` chain (never mutated or deleted).
- AC1: Correction happens on the surface where I see the value (matrix cell), not a separate admin page.
- AC2: Old row flips to `entered-in-error`; new row has `source='manual_correction'`, `correctsId=old id`; results use only active rows.
- AC3: Corrections converge across devices (status is sticky in merge).
- AC4: Correcting a non-latest value doesn't disturb the latest summary.
- Evidence: correction affordance was a deliberate UX decision (memory: corrections live with the data); `correction_made` funnel event now measures real usage.
- Tests: 🟡 merge.test.ts covers `correctsId`/sticky status; ❌ `RoadmapStore.correctMeasurement` itself untested. **Action: store-level tests (this pass).**

### US-05 · Unit switching
As a US/international user, I can flip between conventional and SI units at any time; every field, threshold, and suggestion re-renders correctly and stored data never changes (SI canonical at rest).
- Tests: ✅ units.test.ts round-trips + thresholds; validation error conversion covered. UI re-render untested (accepted).

### US-06 · Medications, supplements & screenings
As a user, I record what I actually take (real drug + dose, or none/not-tolerated/not-yet) and my screening dates; the plan's medication cascade and screening nudges follow the algorithm doc.
- AC1: FHIR MedicationStatement semantics per CLAUDE.md table; history is append-only change log.
- AC2: Brad's products appear as quick-add supplement chips.
- AC3: New screening types must round-trip through the file (7-step checklist in CLAUDE.md).
- Tests: ✅ suggestions/cascade logic in health-core; 🟡 roadmap-store covers med/supplement history appends; screening round-trip tests exist in mappings.test.ts.

## Epic B — Getting the plan

### US-07 · Personalized suggestions with evidence
As a user, once I've entered data I see prioritized suggestions (urgent/attention/info), each expandable to its clinical reason with guideline tags and references I can verify.
- AC1: Suggestions follow `health_roadmap_algorithm.md`; evidence text from `evidence.ts`; `roadmap_text.html` stays consistent (three-file sync rule).
- AC2: LDL-only entry (no total cholesterol) still produces lipid advice (regression: feedback 2026-03-06, fixed).
- AC3: New/changed suggestions highlight briefly so I notice what my new data changed.
- Evidence: "Why this suggestion?" expansions observed in recordings; `results_viewed` event now counts reach.
- Tests: ✅ suggestions.test.ts (incl. lipid fallbacks via `resolveBestLipidMarker`); ❌ no explicit LDL-without-total regression case. **Action: verify/add (this pass).**

### US-08 · Print / save my plan
As a user, I can print or save my plan as a PDF to bring to my doctor (client-side; no server involved).
- Tests: ❌ untested (print pipeline; accepted — manual verify per deploy).

## Epic C — Owning my data (local-first)

### US-09 · Choosing where my data lives
As a privacy-conscious user, I choose Google Drive / Dropbox / GitHub / my own WebDAV server / just-this-browser, from a neutral picker with no dark patterns, and can switch later without losing anything (data copies down, tokens dropped, new provider lifted).
- AC1: OAuth (Drive/Dropbox) via PKCE redirect; GitHub/WebDAV via pasted credentials validated before commit.
- AC2: Switching providers copies current data to device first; log-off leaves the local copy intact.
- AC3: On-device guest data migrates up on first connect (merge, not overwrite).
- Evidence: a live Dropbox connect was captured on video (audit); privacy is a real user concern (feedback 2026-05-01). `cloud_connect_started/success` events now measure conversion/abandonment.
- Tests: ❌ near-zero — only `logOff` teardown is tested. The adapters + PKCE + picker flow are untested. **Action: sync-manager/store tests first (this pass); adapter tests deferred.**

### US-10 · Cross-device convergence
As a user with a phone and a laptop, edits from both devices converge without conflicts: append-only arrays union, mutable scalars last-write-wins, corrections/deletions sticky, `eraseEpoch` wins wholesale.
- AC1: A fast edit on a fresh page load can never clobber unseen cloud data (hydration gate before first flush).
- AC2: Deleted measurements never resurrect via merge.
- Tests: ✅ mergeFiles thoroughly tested; 🟡 store resurrect-guard covered; ❌ `SyncManager` load→merge→push loop and the hydration gate untested. **Action: this pass (highest-risk gap in the repo — it guards user data).**

### US-11 · Deleting my data
As a user, I can erase everything from the tool on every device (eraseEpoch bump + empty flush); there is no server copy to chase.
- Tests: 🟡 merge honors eraseEpoch; ❌ `deleteUserData` store path untested. **Action: this pass.**

## Epic D — Lab uploads & documents

### US-12 · Upload lab reports
As a user with PDF/photo/ZIP lab reports, I drop them in and extraction starts automatically; I see progress per file; failures are explained and my daily quota is enforced before any processing starts.
- AC1: Auto-process on select; per-file progress; abortable.
- AC2: Server extracts and returns values only — stores nothing.
- AC3: Extraction failures surface a friendly error (and now emit `upload_extract_failed`).
- Evidence: upload funnel events just shipped; prior visibility was zero.
- Tests: ❌ UploadModal pipeline untested (754 lines). **Action: pure-logic extraction tests (this pass); modal state-machine deferred.**

### US-13 · Review before save
As a user, I review extracted values in a metric×date matrix (mirroring the live timeline), can edit any value (tagged `lab_import_edited`), and only what I confirm is saved.
- AC1: Dedup: documents on `sourceFileName`, lab values on `(metric, recorded_at)` — re-uploading the same file is a no-op, not an error or duplicate.
- AC2: Edited-at-review values carry the edited source for audit.
- Tests: 🟡 one helper tested; dedup logic tested indirectly via store bulk-saves? ❌ mostly not. **Action: bulk-save dedup tests at store level (this pass).**

### US-14 · Document archive
As a user, my uploaded reports/letters become organized markdown documents (+ original file when my cloud can hold it) that I can reopen in a lightbox.
- Tests: ✅ document-path taxonomy; 🟡 archive-payloads synthesis; ❌ store deleteDocument/readDocumentFile. Deferred.

## Epic E — Chat

### US-15 · Ask about my plan
As a user, I can ask the assistant about my suggestions; it answers with my plan as context, cites Brad's content, and its name matches the store I'm on (Brad AI / MicroVitamin).
- AC1: Server-proxied on Shopify surfaces; BYOK on Pages (no Brad server).
- AC2: `chat_opened` now measures adoption.
- Evidence: 926 messages; ~48% router unmatched; ~17% of queries are store-support questions (redirect opportunity); zero conversations link to a Shopify customer id (needs investigation).
- Tests: ✅ server-side chat.server tests + router fixture suites (`tools/test-queries.json` Phase D loop); ❌ chat UI/hooks untested (accepted for now).

### US-16 · Chat can fill my form
As a user, when I tell the chat my numbers ("my LDL is 3.2"), it proposes structured form edits that I confirm — it never silently writes data.
- Tests: ✅ chat-edits parsing + the paid tool-edit harness (`tools/test-tool-edits.json`).

## Epic F — Staying engaged

### US-17 · Email reminders
As a user, I opt in with my email and get consolidated reminders when bloods/screenings/med-reviews come due; unsubscribe is one click; the server never sees health values (only labels+dates).
- Evidence: **2 opt-ins ever** — before more engineering, decide surface/kill (audit #8). `reminder_optin` event now measures attempts.
- Tests: ✅ schedule/due logic; ❌ opt-in UX→server path untested (deferred pending the product decision).

### US-18 · Guest email capture
As a guest, I can email myself the report (Klaviyo capture; Shopify surface only — never on Pages).
- Tests: 🟡 copy + captured-flag tested; capture path manual. Historical note: a guest's report email silently failed in v1 (feedback 2026-03-16) — the v2 path is different; keep an eye via Klaviyo stats.

### US-19 · Sending feedback
As a user, I can send Brad feedback from the widget; it reaches his inbox (Resend) AND the `feedback_submissions` table so it's never silently lost; bots are honeypotted; 3/hour/IP.
- Evidence: 2026-08 incident — edu app missing `RESEND_FROM_EMAIL` sent from the Resend sandbox address; fixed 2026-08-07, DB mirror added so submissions are provable.
- Tests: 🟡 sendFeedbackEmail + route helpers tested; mirror insert untested (accepted — verified live).

### US-20 · Mobile
As a mobile user, I get a tabbed layout (input/plan/chat) with CSS scroll-snap swiping, and every layout works in real iOS WebKit (not just Chrome emulation).
- Evidence: mobile engagement is much shallower than desktop (2.6 vs 7.4+ min new-user averages) — worth watching in funnel data.
- Tests: ❌ automated none; WebKit verification via `tools/webkit-verify.mjs` is the required manual gate per CLAUDE.md.

---

## Coverage priorities (this pass, from stories × usage × risk)

1. **US-10/US-04/US-11 — RoadmapStore + SyncManager**: correctMeasurement, flush/hydration gate, deleteUserData, bulk-save dedup (US-13). This code guards user data with no server backstop.
2. **US-03 — date-defaulting regression tests** for the wrong-date bug class.
3. **US-07 — LDL-without-total explicit regression case.**
4. **US-02 — BP/tooltip interaction fix + test** (top live friction).

Deferred consciously: cloud adapter unit tests (OAuth mocking heavy), chat UI, print, modal state machines.
