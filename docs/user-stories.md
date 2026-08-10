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
- Evidence: correction affordance was a deliberate UX decision (memory: corrections live with the data); `correction_made` funnel event now measures real usage — 9 corrections in the first instrumented week (2026-W32).
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
As a user, I can print or save my plan as a PDF to bring to my doctor (client-side; no server involved). The guest capture button drives the same pipeline — see US-18.
- Tests: ❌ untested (print pipeline; accepted — manual verify per deploy).

## Epic C — Owning my data (local-first)

### US-09 · Choosing where my data lives
As a privacy-conscious user, I choose Google Drive / Dropbox / GitHub / my own WebDAV server / just-this-browser, from a neutral picker with no dark patterns, and can switch later without losing anything (data copies down, tokens dropped, new provider lifted).
- AC1: OAuth (Drive/Dropbox) via PKCE redirect; GitHub/WebDAV via pasted credentials validated before commit.
- AC2: Switching providers copies current data to device first; log-off leaves the local copy intact.
- AC3: On-device guest data migrates up on first connect (merge, not overwrite).
- Evidence: a live Dropbox connect was captured on video (audit); privacy is a real user concern (feedback 2026-05-01). `cloud_connect_started/success` events now measure conversion/abandonment — first week (2026-W32): 5 started → 2 succeeded (small n; no failure-step metadata yet).
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
- Tests: ✅ pure pipeline covered (2026-08-07): `lab-extraction.test.ts` (content blocks, classification branching, unit-resolution fallback), `zip-extract.test.ts` (junk filtering, caps, nested folders — plus a real-fixture test against Brad's `health.zip`, local-only/skipped in CI, structure-only assertions), `anthropic.server.retry.test.ts` (retry/backoff/Sentry-silencing policy), `isImage`/`isPdf` guards. ❌ Remaining, with reasons: the React modal state machine, and `resizeImage`/`extractFromPdf` rendering (need real DOM/canvas — browser-mode testing infra); batch-API path.

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
- Evidence: 926 messages; ~48% router unmatched; ~17% of queries are store-support questions (redirect opportunity); zero conversations link to a Shopify customer id (needs investigation). 2026-W32: 158 messages/wk (+394% WoW); unmatched hit 73% that week; `chat_opened` has emitted 0 events ever — the only emit site is unreachable on every live surface (dead instrumentation, fix diff in loops/product-health/2026-W32.md).
- Tests: ✅ server-side chat.server tests + router fixture suites (`tools/test-queries.json` Phase D loop); ❌ chat UI/hooks untested (accepted for now).

### US-16 · Chat can fill my form
As a user, when I tell the chat my numbers ("my LDL is 3.2"), it proposes structured form edits that I confirm — it never silently writes data.
- Tests: ✅ chat-edits parsing + the paid tool-edit harness (`tools/test-tool-edits.json`).

## Epic F — Staying engaged

### US-17 · Email reminders (REDESIGN PENDING — Brad, 2026-08-11)
As a user who has connected a cloud and entered real screening/blood data, I am reminded by email when something comes due **without having had to hunt for a setting** — because a reminder I never receive is the whole reason the tool failed to change my behaviour.

**Status: the current design is a proven failure and is being replaced.** Shipped behaviour is explicit opt-in behind three barriers (cloud-connect → scroll past the disclaimer to the bottom of the results panel → two clicks). Result: **~1 genuine opt-in in two months** (the second `reminder_optin_v2` row is Brad's own e2e test). Nothing is broken — cron healthy, sends correct, nothing yet due (earliest 2027-05-12) — the feature simply never reaches anyone.

**The decision (Brad, 2026-08-11):** move to reminders **on by default**, opt-out rather than opt-in. Sends are rare by design (screening 90d / bloods 180d / med-review 365d cooldowns), so the cost to a user who ignores them is near zero while the value to one who forgets a colonoscopy is the product's entire thesis.

**Two constraints that bound the redesign** (they are not negotiable and any implementation must satisfy both):
1. **Provider-verified email only — never a client-typed address.** Today's email comes from the cloud provider's own token/ID. If reminders ever accept a typed address (e.g. the Klaviyo report-capture field), anyone can enter `victim@example.com` and make Brad's server email a stranger "your colonoscopy is due" — an abuse vector and a spam-complaint engine. A typed address may only ever be used after a confirm-link round trip.
2. **Default-on must stay visible, never silent.** Auto-enrolling silently would push every cloud-connected user's due-dates + labels to Brad's server without them knowing — quietly weakening the "your health data lives in your cloud, not our servers" promise that the product is marketed on ([architecture-v2.html](architecture-v2.html)), and inviting spam complaints that damage the sending domain shared with transactional mail. **Recommended design point:** at the cloud-connect success moment, a visible, pre-checked "Email me when something comes due" with a one-line plain statement of exactly what leaves the device (due date + label + email — never values), unmissable on one screen, plus a permanent off switch in settings.

**Where the audience actually is (live pull, 2026-08-10 — this reorders the work):** Klaviyo holds **874 captured emails** on the commerce list (+39 edu), still growing ~4–5/day (135 in the last 30d). `cloud_connect_success` has fired **2 times ever**. So the provider-verified lane covers ~2 people and the typed-address lane covers ~900: **the typed lane is not a nice-to-have Phase 2, it is the entire audience.** Build order follows the numbers, not the ease.

**Confirmation email sends via Resend, never Klaviyo (decision 2026-08-11).** Reminder consent must never be coupled to the marketing list: Klaviyo suppression is list-wide, so a supplement-promo unsubscribe would silently stop "your colonoscopy is due" — a marketing preference overriding a health reminder, with no error and nobody noticing. Two consents, two systems, two suppression lists. Supporting reasons: the confirm mail is textbook transactional (one-time, user-triggered, expected in seconds); a confirm landing in spam fails the whole redesign silently, and transactional streams land better; Resend is already wired (`reminder-v2.server.ts`, `email.server.ts`). Precedent already in the code — [api.reminders-v2.ts](../app/routes/api.reminders-v2.ts) takes `verified.email` for reminders and a SEPARATE `marketingEmail` for Klaviyo, fire-and-forget so Klaviyo can never fail an opt-in. Bonus: confirming before adding to Klaviyo filters typos/fakes, which raises Meta/Google audience match rates and cuts per-contact spend.

**No confirm-click gate (Brad, 2026-08-11).** Double opt-in loses 20–40% of legitimate signups — taxing every honest user to catch a rare bad one. Instead the plan-ready email (US-22) does the work: a bounce proves the address is dead, and delivery is the enrollment trigger. The residual risk a bounce can't catch is a typo into a *valid stranger's* address (`john@` for `johnn@`), which delivers fine; AC2c bounds that (rare sends + prominent one-click unsubscribe). A click on that email is a strong ownership signal but is never required — treat clicks, not opens, as real (Apple Mail Privacy Protection fakes opens).

**The ~900 existing captures (still needs a Brad call):** they gave an email for a report, not for reminders, and predate any send. A bulk "want reminders?" mail is a re-permission campaign to people who never asked — real complaint risk on a domain that also carries transactional mail. Preferred shape if we do it: one genuinely useful email (plan re-entry + the reminders offer), once. Both lists are `single_opt_in` today, so no confirmation habit exists with these contacts.

- AC1: On cloud-connect success (Drive/Dropbox/GitHub), enrollment happens **immediately and without any user action** — true opt-out (Brad, 2026-08-11). A user who reads the line and clicks away IS enrolled; only an explicit toggle-off unenrolls. The disclosure is a visible statement + already-on switch on that same screen, never a gate.
- AC1b: Consequence of AC1, accepted knowingly: every cloud-connecting user's due date + label + verified email reaches the server, where before only explicit opt-ins did. Still no measurement, lab value, or reasoning — the local-first invariant holds — but the population sending metadata widens from ~2 to everyone who connects. If a toggle-off arrives, the server row is DELETED, not just flagged.
- AC2: The enrolled email is either provider-verified (cloud-connect) OR a typed address whose plan-ready email **delivered without bouncing** (US-22). No confirm-click gate — see the consent reasoning below. **US-22 is therefore a hard dependency for the typed lane.**
- AC2b: A hard bounce disenrolls: no reminders, and the address is removed from Klaviyo.
- AC2c: Because a delivered-but-mistyped address belongs to a stranger, the FIRST reminder to any bounce-validated (not provider-verified) address must carry the one-click unsubscribe prominently in the body, not just the header. Rare sends (90/180/365d) + one click to stop = bounded, self-correcting harm.
- AC3: A user can turn reminders off permanently in one action, from the results surface and from any reminder email (RFC 8058 one-click unsubscribe already ships).
- AC4: Turning reminders off survives a sync from a second device (see the 2026-08-07 incident below — this AC exists because that exact bug shipped).
- AC5: The server still receives only due date + label + verified email + capability token. No measurement, lab value, or reasoning ever leaves the device — default-on must not widen the data sent.
- AC6: Local-storage-only users (no cloud, no verified email) are never enrolled and are never shown a broken control.
- **Usage signal (Lane B, declare before code):** `reminder_optin` fires on enrollment (already wired, already in the server enum) and a new `reminder_optout` fires on disable — the ratio is the honest measure. Kill criterion: if opt-out exceeds ~30% of enrollments, or spam complaints appear in Resend, the default-on decision is wrong and reverts.
- Evidence: ~1 genuine opt-in ever (live query 2026-08-10); `reminder_optin` 0 fires since instrumentation went live 2026-08-06 — but both existing opt-ins PREDATE instrumentation, so zero events measures reach, not rejection. `reminder_log` empty and `last_sent: {}` are correct (nothing due yet), not a send bug. Cron `reminder_v2_cron` healthy (lock acquired daily).
- Tests: ✅ schedule/due logic + store persistence (`saveReminderPreference`/`setGlobalReminderOptout`, 2026-08-07); ❌ opt-in UX→server path untested — **must be covered by the redesign** (AC1–AC4, especially AC2's abuse vector and AC4's regression).
- **Incident 2026-08-07:** store-level tests found `setGlobalReminderOptout` mutated rows without bumping their merge stamps — "turn off all reminders" silently reverted on the next sync. Fixed same day (routed through the stamped upsert path); regression test pins it. **Open design TODO, now load-bearing:** on a fresh file with no per-category rows the global opt-out is a no-op — with default-on this becomes the primary path (a brand-new user turning reminders off), so the redesign must seed categories or make the global flag authoritative on its own.

### US-18 · Generate my plan as a downloadable PDF (guest capture button)
As a guest, I enter my email and **immediately get my whole plan as a downloadable/printable PDF** — no account, no waiting on an inbox. (Corrected 2026-08-11: this story used to claim "I can email myself the report", which has not been true since `525e6be`, 2026-06-12 — "NO Resend report email, and NO health data reaches the server". Nothing was ever emailed. The general print/save path is US-08.)
- AC1: The button renders the plan and opens the save-as-PDF/print window **client-side** — the plan never leaves the device.
- AC2: The typed address is subscribed to Klaviyo fire-and-forget; a Klaviyo failure never blocks or delays the PDF.
- AC3: Rate-limited per address (guest report limit) and behind app-proxy HMAC; Shopify surface only — the Pages build has no Brad server and must no-op.
- AC4: The PDF is the delivery. Nothing in the UI may promise an email unless US-22 has shipped.
- Evidence: 874 addresses captured on the commerce Klaviyo list, ~4–5/day, all `single_opt_in`; 50 unsubscribed lifetime.
- Tests: 🟡 copy + captured-flag tested; PDF path manual (shares US-08's untested print pipeline). Historical note: a guest's report email silently failed in v1 (feedback 2026-03-16) — that v1 path is gone.

### US-22 · Plan-ready email + address validation — **NEW BUILD, Brad-approved 2026-08-11**
As a guest who handed over my email, I **receive an email** confirming my plan is ready with a link back to it — so I have a way back in, and so a dead address is detectable.

**Why:** ~900 people typed an email expecting something and got nothing (US-18). Those addresses have never been validated, and the tool has no re-entry path. This email is also what makes reminders possible (US-17 AC2): delivery — not a confirm click — is the enrollment trigger.

**The old implementation CANNOT be restored.** Pre-teardown `sendReportEmail(userId, client)` read health values out of Supabase and built an email containing waist, BP, HbA1c, LDL, ApoB, Lp(a) (`git show bbd79fd^:app/lib/email.server.ts`). Those tables are purged, and that design violates the v2 invariant — no health value may transit Brad's server. Lift its layout/markup for reference only.

**The v2 shape carries NO health data** (Brad, agreed 2026-08-11): it confirms the plan is ready, links back into the tool (where the plan re-renders from the user's own localStorage/cloud), and states what reminders they'll get. Local-first promise intact, and it still yields both signals we need — bounce (dead address) and click (ownership + re-engagement). The health specifics still reach people via the reminders themselves, which are already permitted to carry a label and a due date.

- AC1: On capture, Resend sends a plan-ready email containing no measurement, lab value, medication, or screening data — only the re-entry link and what reminders to expect.
- AC2: The send never blocks the user's plan; the US-18 PDF delivery is unchanged and a Resend failure is logged, not surfaced.
- AC3: A Resend **bounce webhook** (new route — none exists today, signature-verified) marks the address dead → **suppressed/unsubscribed in Klaviyo, not deleted** (Brad, 2026-08-11: keeps the record and stays reversible if a bounce is misclassified) and never enrolled in reminders (US-17 AC2b).
- AC4: A delivered (non-bounced) address stays in Klaviyo and becomes reminder-eligible — delivery is the trigger, no confirm click.
- AC5: The re-entry link is click-tracked; **clicks, not opens**, are the ownership signal (Apple Mail Privacy Protection fakes opens).
- AC6: Shopify surface only; the Pages build no-ops.
- AC7: Once shipped, US-18's UI may promise the email (AC4 there).
- AC8: **New captures only** (Brad, 2026-08-11) — no backfill send to the ~900 pre-existing addresses. They stay unvalidated and reminder-ineligible until Brad revisits, once real bounce/complaint rates from new sends are known.
- AC9: Ships on **both** Fly apps (commerce + education) together; they share one Resend key and from-address.
- **Usage signal:** `report_email_sent` / `report_email_bounced` / `report_email_clicked`. Bounce rate on new captures is also the estimate for how much of the legacy ~900 is junk — the input to the backfill decision.
- **Brad prerequisite (only he can do it):** register the bounce webhook in the Resend dashboard pointing at the new route, then put its signing secret on BOTH Fly apps as `RESEND_WEBHOOK_SECRET`. Until that exists, AC3 cannot be verified live.
- Tests: ❌ none yet — AC1–AC4 need coverage (send shape carries no health fields, bounce → Klaviyo removal + no enrollment, Resend failure doesn't break capture, Pages no-op).

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

**Decisions (Brad, 2026-08-07):**
1. **Units: canonical-units catalogue — option (a).** A new `packages/health-core/src/lab-catalog.ts` defines each test's canonical unit (units.ts discipline; conversion factors added per-metric as implemented, each verifiable). Per-lab reference ranges keep coming from the uploaded report (`referenceLow/High` already stored) — the catalogue carries units/grouping/aliases, not clinical thresholds, so the evidence-citation surface stays small.
2. **Initial panel scope:** Renal (incl. electrolytes) · Liver · Thyroid (TFTs) · Hormones · Vitamins & minerals · Inflammation markers. Grow from there.
3. **Collapsed by default** under the core 8.
4. **Each group renders an icon to the left of its heading** (kidney → Renal, etc.) — inline SVGs, same no-asset-fetch pattern as the backend-picker logos.

**Remaining open questions:** exact test list per panel (Brad to review the catalogue skeleton); mixed-unit handling for values stored before a metric's conversion exists (proposal: display as-reported with the unit label until the conversion lands).

**Phasing** (each phase independently shippable with its own signal):
- **Phase 1 — surface what exists: ✅ SHIPPED 2026-08-07.** `AdditionalLabRows` renders grouped, collapsed-by-default read-only rows beneath the blood-test matrix (inline SVG icon per group, count, expand to dated value strips, mixed-unit flag, "Other tests" bucket for uncatalogued names). Logic in `lib/lab-rows.ts` (13 tests); catalogue resolver handles LLM underscore/space variance. Corrections deferred to phase 2 (labValues have no store-level correct method yet). Signal live: `lab_rows_viewed` — 15 events in the first instrumented week (2026-W32) vs 190 `results_viewed` (~8% of viewers expand the additional-lab rows).
- **Phase 2 — manual add:** "+" button + catalogue-driven add with canonical units/validation; labValue corrections. Signal: `lab_row_added` (registered, unused yet).
- **Phase 3 — normalization:** unit conversion at save/review for catalogue tests.

---

## Coverage priorities — 2026-08-07 pass: DONE

1. ✅ US-10/US-04/US-11/US-13 — RoadmapStore + SyncManager suites landed (16 tests) and **immediately caught the eraseEpoch-resurrection defect** (see US-11), fixed same day.
2. ✅ US-03 — date-defaulting semantics pinned.
3. ✅ US-07 — LDL-without-total already covered; verified.
4. ✅ US-02 — BP dead-click + tooltip fixes shipped (collapsed-row value click, matrix shell focus, click-toggleable InfoTooltip, mobile fixed-bar clearance).

**2026-08-07 later passes:** US-12 pure-pipeline tests landed (incl. the real `health.zip` local fixture); store gaps closed (deleteLabValue, documents, screenings, reminder prefs — which caught and fixed the US-17 opt-out revert bug); input hardening (US-02 AC4–6) shipped and live-verified; US-21 catalogue scaffold (`lab-catalog.ts`) created.

Still consciously deferred, each needing infra or a product decision first: cloud adapter unit tests (OAuth mocking heavy), chat UI + upload modal state machines + canvas/pdf.js rendering (need browser-mode test infra — jsdom/Playwright component testing), print (manual/live verify), HealthTool hydration gate (UI-level), reminders opt-in UX path (pending the keep-or-kill decision).
