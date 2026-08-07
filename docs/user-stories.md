# User Stories — Health Roadmap

The user-perspective spec for every journey in the tool. Written 2026-08-07, grounded in the first usage audit ([usage-audit-2026-08.md](usage-audit-2026-08.md)); the architecture reference is [architecture-v2.html](architecture-v2.html). Each story carries acceptance criteria (AC), the **usage evidence** we have, and the **test status** against the current suites.

**Maintenance contract:** when a feature's behavior changes, update its story here in the same commit, then regenerate the browser companion: `npx tsx scripts/build-user-stories-html.ts` → `docs/user-stories.html` (linked from architecture-v2.html; never edit the html by hand). New tests cite the story ID (e.g. `US-04`) in a comment. New features follow CLAUDE.md → Development Pathway Lane B: story + acceptance criteria + a declared usage signal BEFORE code. The weekly product-health loop reads this file to judge whether reported friction contradicts an AC.

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
- AC4: Numeric fields accept only numeric characters — letters and symbols are blocked at the keystroke (and stripped on paste), on every surface incl. Safari where `type="number"` doesn't enforce this.
- AC5: An out-of-range value shows a visible inline error (e.g. "Max 250 mmHg") on the field itself — never a silent save-block where garbage looks accepted.
- AC6: After typing an unambiguous, in-range systolic value, focus auto-advances to diastolic (immediately for 3-digit values 100–250; after a short pause for 2-digit values 60–99 that could still gain a digit).
- Evidence: **top friction in the audit** — dead clicks on the BP `▫▫▫/? mmHg` control and `mmHg` label in 3 of 15 recorded sessions; tooltip/units-picker dead clicks in 4.
- Tests: 🟡 `StartingInfoVitals.test.ts` covers BP pair routing/readiness logic; `blood-test-cell.test.ts` covers validation. ❌ No test that a cell-shell click focuses the input (the actual reported friction). **Action: fix + test (2026-08 backlog #1).**

### US-03 · Blood-test matrix entry & backfill
As a user, I can enter today's blood results in a draft column, and backfill older results under their historical date, and the matrix keeps every column aligned and scroll-synced.
- AC1: Draft column accepts values + a date (DraftDateCell); saving appends immutable measurements under that date.
- AC2: Typing into an existing dated column routes as backfill for that date.
- AC3: At most one active row per (metric, day); a same-day re-entry routes through correction (US-04), never a silent overwrite or lost draft.
- AC4: A failed save preserves the typed draft for retry.
- Evidence: engaged sessions show field-by-field entry of masked numeric values; feedback email 2026-03-22 reported values appearing under a wrong date (root cause never found).
- Tests: ✅ `matrix-save.test.ts` (task routing), `blood-test-cell.test.ts` (validation), merge tests (slot invariant), and date-defaulting semantics pinned in `roadmap-store-data-safety.test.ts` (2026-08-07).

### US-04 · Correcting a saved value (FHIR)
As a user who mistyped or whose lab import was wrong, I can click the saved cell, type the right value, and the display updates — while the old value is preserved as `entered-in-error` with a `correctsId` chain (never mutated or deleted).
- AC1: Correction happens on the surface where I see the value (matrix cell), not a separate admin page.
- AC2: Old row flips to `entered-in-error`; new row has `source='manual_correction'`, `correctsId=old id`; results use only active rows.
- AC3: Corrections converge across devices (status is sticky in merge).
- AC4: Correcting a non-latest value doesn't disturb the latest summary.
- Evidence: correction affordance was a deliberate UX decision (memory: corrections live with the data); `correction_made` funnel event now measures real usage.
- Tests: ✅ merge.test.ts (`correctsId`/sticky status) + `roadmap-store-data-safety.test.ts` (store-level correction flow, 2026-08-07).

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
- Tests: ✅ suggestions.test.ts — the LDL-without-total case is covered by `'shows LDL when neither ApoB nor non-HDL available'` (verified 2026-08-07).

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
- Tests: ✅ mergeFiles + store resurrect-guard + `sync-manager.test.ts` (read-merge-write, eraseEpoch wholesale win; 2026-08-07). Hydration gate (AC1) lives in HealthTool UI — still untested, accepted. **Writing these tests immediately caught a real defect — see US-11.**

### US-11 · Deleting my data
As a user, I can erase everything from the tool on every device (eraseEpoch bump + empty flush); there is no server copy to chase.
- Tests: ✅ `deleteUserData` + stale-device-cannot-resurrect covered (2026-08-07).
- **Incident 2026-08-07:** first coverage of this path found that `migrateFile()` dropped `meta.eraseEpoch` on every storage read, so any stale device's flush resurrected erased data (merge gate never saw the epoch). Fixed in `migrate.ts` same day; regression tests pin it in `roadmap-store-data-safety.test.ts` + `sync-manager.test.ts`.

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
- Tests: ✅ store-level bulk-save dedup (measurements + lab values, re-upload no-op) in `roadmap-store-data-safety.test.ts` (2026-08-07); ReviewTable UI itself still 🟡.

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
- Tests: ✅ schedule/due logic + store persistence (`saveReminderPreference`/`setGlobalReminderOptout`, 2026-08-07); ❌ opt-in UX→server path untested (deferred pending the product decision).
- **Incident 2026-08-07:** first store-level tests found `setGlobalReminderOptout` mutated rows without bumping their merge stamps — "turn off all reminders" silently reverted on the next sync. Fixed same day (routed through the stamped upsert path); regression test pins it. Open design TODO in the tests: on a fresh file with no per-category rows, the global opt-out is a no-op (depends on whether the UI seeds categories — check when the reminders decision is made).

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

### US-21 · Additional blood tests on the main matrix — **DRAFT, design stage (no code yet)**
As a user whose lab reports contain tests beyond the core 8 (sodium, GGT, TSH, ferritin…), I can see those stored values as grouped rows under the core matrix and add a test I want to monitor via a "+" button — one place to watch everything.

**What already exists** (why this is surfacing, not building, for phase 1): the `labValues` collection in `health-roadmap.json` already captures every extracted additional test (FHIR `status`/`source`, value+unit as reported, reference ranges, dedup on `(metric_name, recorded_at)`). Today it's visible only in History and at upload-review time (`ReviewTable`); the main matrix never shows it. Label mapping exists (`lib/lab-value-labels.ts`), reference hints exist (`reference-hints.ts`).

**Draft acceptance criteria** (to iterate before build):
- AC1: Stored lab values render as rows beneath the core 8, grouped by panel (Liver · Kidney/renal · Electrolytes · Blood count · Hormones · Lipids-extended · Other), matching the matrix's column/date alignment and scroll-sync.
- AC2: "+ Add test" lets the user pick from a curated catalogue (searchable; canonical unit + validation range per test) or add a free-form test.
- AC3: A known test's row always displays ONE unit; a value arriving in a different unit is converted or flagged at review — never silently mixed into the row (a U/L value charted next to a µkat/L value would be clinically wrong).
- AC4: Upload-extracted and manually-entered values for the same test land in the same row (alias map keyed on stable metric keys — never dedup on raw LLM text, per the documented gotcha).
- AC5: Corrections work exactly like core rows (entered-in-error + correctsId chain — the labValue shape already carries status/source).
- AC6: Cross-device merge semantics reviewed for the new slot behavior (Fable-level judgment — merge.ts territory).
- **Usage signal (Lane B mandatory): new product event `lab_row_added` for manual adds; phase-1 surfacing measured via a `lab_rows_viewed` event (count metadata). Uploads already emit `upload_saved`.**

**Open design questions — decide before code:**
1. **Units policy conflict (the big one):** the documented v2 design stores labValues *as reported* ("no SI conversion — units aren't canonical across labs"). Uniform per-row display requires either (a) extending the canonical-units approach (units.ts-style conversions) to a much larger metric catalogue — a significant clinical-content surface with the same citation discipline as evidence.ts, or (b) a per-row unit lock (first stored unit wins; later mismatched units get flagged for explicit conversion at review). Option (b) is cheaper and safer to ship first.
2. **Catalogue scope for v1:** local-first means we CANNOT mine users' stored labValues to see which tests are common (their data lives in their clouds, not ours) — scope must come from clinical judgment about standard panels (LFTs, U&E/renal, FBC, thyroid, iron studies, extended lipids).
3. **Collapsed vs expanded by default** under the core 8 (mobile real estate).
4. Where the catalogue lives: `packages/health-core/src/lab-catalog.ts` (key, label, aliases, group, canonical unit, conversions, ref hints) — reference ranges are clinical content, so the evidence-discipline applies.

**Proposed phasing** (each phase independently shippable with its own signal):
- **Phase 1 — surface what exists:** grouped read-only rows from stored labValues + corrections. No manual add, no conversions (per-row unit lock + mixed-unit flag). Signal: `lab_rows_viewed`.
- **Phase 2 — manual add:** "+" button + curated catalogue with canonical units/validation. Signal: `lab_row_added`.
- **Phase 3 — normalization:** alias map + unit conversion at save/review for catalogue tests.

---

## Coverage priorities — 2026-08-07 pass: DONE

1. ✅ US-10/US-04/US-11/US-13 — RoadmapStore + SyncManager suites landed (16 tests) and **immediately caught the eraseEpoch-resurrection defect** (see US-11), fixed same day.
2. ✅ US-03 — date-defaulting semantics pinned.
3. ✅ US-07 — LDL-without-total already covered; verified.
4. ✅ US-02 — BP dead-click + tooltip fixes shipped (collapsed-row value click, matrix shell focus, click-toggleable InfoTooltip, mobile fixed-bar clearance).

Still consciously deferred: cloud adapter unit tests (OAuth mocking heavy), chat UI, print, modal state machines, HealthTool hydration gate.
