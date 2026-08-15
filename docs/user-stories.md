# User Stories — Health Roadmap

The user-perspective spec for every journey in the tool. Written 2026-08-07, grounded in the first usage audit ([usage-audit-2026-08.md](usage-audit-2026-08.md)); the architecture reference is [architecture-v2.html](architecture-v2.html). Each story carries acceptance criteria (AC), the **usage evidence** we have, and the **test status** against the current suites.

## The product constitution (Brad, 2026-08-14 — read every story against this)

**What this is:** a preventative-care protocol generator plus a recall system. One five-minute check-up tells a user what to actually do — bloods, screenings, medications, supplements, weight, sleep, exercise — and the reminder calendar makes sure it keeps happening over the years. The website is the onboarding funnel and the calculator; **email is the product surface the user lives in.** For preventative care an annual touch is the correct cadence, not a retention failure — never chase app-engagement metrics here.

**The avatar:** 45–55, health-curious but unsystematic, low tech-literacy (they arrive from a longevity YouTube channel, so they already care; they just don't *systematize*). They will type an email address; they will mostly not connect a cloud drive — live funnel 2026-08-14: typed captures outnumber cloud connects roughly 10:1 on any denominator we have (~4–5 captures/day and 874+ lifetime vs 3 cloud connects EVER; a precise percentage depends on which visitor count you divide by, so the RATIO is the decision-driver). Design for zero thought: the right thing happens by default, visibly, with a one-click way out. The genuinely health-indifferent mass market only becomes reachable at the mobile app (US-25); don't contort the web product for a user who can't arrive yet.

**The promise (one sentence — keep it literally true):** *Your health data stays on your device. We keep one thing — your reminder calendar, what's due and when — so we can nudge you.*
What may be STORED on Brad's server, visibly disclosed: reminder labels + due dates, the enrolled email, a capability token. What is never stored as health data: measurements, lab values, medications, results, reasoning. (Precision matters — the loop reads this literally: chat questions and lab-report uploads do TRANSIT the server for AI processing (US-12/US-15/US-16), in memory for extraction, and chat messages persist as conversation logs in `chat_messages` — operational data the user typed at a chatbot, not a parsed health record. The promise is about what we KEEP as your health data: nothing.) A label can carry an inference (a lung-CT row implies smoking history); we **disclose that at enrolment rather than neuter the labels** — specific recall notices are what clinics already send, and specificity is what makes the email valuable standalone (Brad, 2026-08-14, superseding the "vague emails" option).

**Durability (why localStorage loss is a bounded cost, not a crisis):** the artifacts survive — the PDF, every reminder email (each carries the full schedule per US-23 AC3 — for a typed user that's the newest copy we were given at capture, not a live sync), and calendar entries (US-24). Re-entry is cheap by design: the check-up takes five minutes, and re-entering IS re-assessing. Cloud sync (US-09) is the durability upgrade for the motivated, not the front door. The real fix is the mobile app (US-25). We never "fix" durability by holding health data server-side.

**Email architecture (decided 2026-08-11, reaffirmed 2026-08-14):** Resend sends everything programmatic — reminders, the plan-ready email, the feedback path. Klaviyo holds only the marketing list. Never merge them: Klaviyo suppression is list-wide, so a supplement-promo unsubscribe would silently kill "your colonoscopy is due" with no error anywhere. Two consents, two systems, two suppression lists.

**Architectural destination:** the mobile app (US-25) — on-device notifications (reminders with no server at all), HealthKit ingestion (data entry with no typing), durable storage (no wipe anxiety). Check near-term decisions against one question: *does this move toward or away from the phone?*

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

**Positioning (constitution, 2026-08-14):** cloud sync is the **durability upgrade for the motivated**, not the front door — the funnel says typed captures outnumber cloud connects ~10:1 (US-23). The picker and its place in the flow stay exactly as they are (Brad's call, 2026-08-14); what changes is expectations: US-23, not this story, is how the mass avatar gets longitudinal value.
- AC1: OAuth (Drive/Dropbox) via PKCE redirect; GitHub/WebDAV via pasted credentials validated before commit.
- AC2: Switching providers copies current data to device first; log-off leaves the local copy intact.
- AC3: On-device guest data migrates up on first connect (merge, not overwrite).
- AC4 (added 2026-08-14, Sentry JAVASCRIPT-REMIX-3X): a failed cloud save is never memory-only — the working copy mirrors on-device at the moment of failure (marker-gated) and merges back up on the next successful cloud session or reconnect.
- Evidence: a live Dropbox connect was captured on video (audit); privacy is a real user concern (feedback 2026-05-01). `cloud_connect_started/success` events now measure conversion/abandonment — first week (2026-W32): 5 started → 2 succeeded (small n; no failure-step metadata yet).
- Tests: 🟡 AC4 covered (`roadmap-store-data-safety.test.ts`, 2026-08-14: failure-mirror + merge-back-up + marker gate); AC2/AC3 lift + copy-down covered (`connect-migrate.test.ts`, 2026-08-14, real adapters); `logOff` teardown covered. ❌ Adapters + PKCE + picker flow remain untested.
- **Incident 2026-08-14 (sentry-fix run):** `migrateLocalInto()`/`copyDownToDevice()` had silently no-oped since first commit — `adapter.read()` called without its filename, `{file}` destructured from a `{body,version}` result, `SyncManager` missing its DocumentSpec — so AC3's guest-data lift and the pre-switch copy-down never ran. No error, no Sentry event; nothing typechecks `standalone/`, so tsc never saw it. Fixed same day (commit `665395d`): transfer primitive `saveRoadmapFileInto` beside `ROADMAP_DOC`, one `liftLocalInto` policy at all three connect flows (a failed lift never blocks or mislabels a connect; always Sentry-reported), failing-first tests, tsconfig now includes `standalone/`.

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
- AC3: A transient upstream failure — a 5xx whose body is not our handler's JSON (the Shopify proxy / Fly edge answered, not our route) — is retried once before chat surfaces an error. The send POST is retried only within an existing conversation, where the server-side dedup can absorb an identical resend; a thread's FIRST message is never auto-retried (dedup is gated on conversationId — a retry could mint a ghost conversation). Added 2026-08-12 from Sentry JAVASCRIPT-REMIX-1M / -22 (sentry-fix loop; scoped per independent review).
- Evidence: 926 messages; ~48% router unmatched; ~17% of queries are store-support questions (redirect opportunity); zero conversations link to a Shopify customer id (needs investigation). 2026-W32: 158 messages/wk (+394% WoW); unmatched hit 73% that week; `chat_opened` has emitted 0 events ever — the only emit site is unreachable on every live surface (dead instrumentation, fix diff in loops/product-health/2026-W32.md). 2026-W33: 260 messages (+150%, window-clean); 70.4% of match events carry no handles BUT 92/119 are deliberate `router_skipped` classifier bypasses — TRUE router misses 27/77 = 35%, below the ~48% baseline (the 73%/48% comparison conflated the two); `chat_opened` STILL 0 — the 08-10 ChatSection fix reaches only the widget bundle, because `vite.config.site-chat.ts` never defines `VITE_SHOPIFY_SURFACE` so `trackProductEvent` no-ops in the site-wide FAB bundle (loops/product-health/2026-W33.md, Tier 3 PR #23).
- Tests: ✅ server-side chat.server tests + router fixture suites (`tools/test-queries.json` Phase D loop); 🟡 `ChatSection.test.tsx` covers both `chat_opened` emit paths and `widget-src/vite-configs.test.ts` pins the per-bundle `VITE_SHOPIFY_SURFACE` surface flags in both directions (AC2); ❌ remaining chat UI/hooks untested (accepted for now). (Status refreshed 2026-08-16, Brad-authorized live.)

### US-16 · Chat can fill my form
As a user, when I tell the chat my numbers ("my LDL is 3.2"), it proposes structured form edits that I confirm — it never silently writes data.
- Tests: ✅ chat-edits parsing + the paid tool-edit harness (`tools/test-tool-edits.json`).

## Epic F — Staying engaged

### US-17 · Email reminders — the retention engine (cloud lane BUILT 2026-08-13; typed lane = US-23)
As a user who has connected a cloud and entered real screening/blood data, I am reminded by email when something comes due **without having had to hunt for a setting** — because a reminder I never receive is the whole reason the tool failed to change my behaviour.

**Reframed 2026-08-14 (constitution):** reminders are not a settings feature — they are the product's retention engine, and email is the primary surface for the primary avatar. This story covers the provider-verified (cloud-connect) lane, which the funnel shows is the rare path; the typed-email lane — ~10× larger and therefore the trunk — is promoted to its own story, **US-23**. Shared mechanics that apply to BOTH lanes (full-schedule-in-every-email, the annual floor, calendar links) are specified in US-23 AC3/AC6 and US-24 to avoid duplication.

**Status: the opt-in design was a proven failure; the opt-out replacement is built (2026-08-13).** The old behaviour was explicit opt-in behind three barriers (cloud-connect → scroll past the disclaimer to the bottom of the results panel → two clicks). Result: **~1 genuine opt-in in two months** (the second `reminder_optin_v2` row is Brad's own e2e test). Nothing was broken — cron healthy, sends correct, nothing yet due (earliest 2027-05-12) — the feature simply never reached anyone.

**What now ships (`autoEnrolReminders`, [standalone/reminders.ts](../widget-src/standalone/reminders.ts)):** every app load on a reminders-capable cloud enrols the user unprompted, unless the file already records a decision. Details that are load-bearing, not incidental:

- **Silent proof only.** Auto-enrolment may never open a Google popup — it runs at page load, where a popup is both browser-blocked and unasked-for. When Drive can't vouch silently the visit doesn't enrol and the next one retries. Failures are swallowed: an enrolment nobody asked for must not raise an error nobody asked for. Pinned by a real (unmocked) test on the adapter, `storage/drive-reminder-proof.test.ts`.
- **The disclosure renders ABOVE the widget, not inside the plan panel.** The plan is slide 2 of the mobile tab layout and every connect path reloads onto slide 1, so a notice inside it would announce itself to an off-screen panel; it is also absent from the no-data-yet render branch — exactly the user who just connected. It is the reminders control itself, so the off switch is one click from the sentence announcing it, and it survives a reload (sessionStorage) until dismissed.
- **Shopify surface only** (a deliberate narrowing of AC1's literal text — Brad to confirm). The Pages/self-host build is marketed as "no Brad server" and runs uploads + chat on the user's own key; enrolling that user unprompted would post their account email to Brad's server at page load, the one thing they chose that build to avoid. They keep the manual toggle. It also matters for the kill criterion: `trackProductEvent` no-ops off-Shopify, so a Pages opt-out would be invisible to the very ratio this decision reverts on.
- **A 401 stops the retry loop permanently** (`hr_reminders_autoenrol_blocked`). A provider that refuses to vouch will refuse again, and silent retries would re-post the credential on every visit forever — a GitHub PAT here holds write access to the repo the user's health data lives in.
- **Switching clouds moves the enrolment, it doesn't duplicate it.** Server rows are keyed by email, so a fresh opt-in cannot replace one made under a different provider; the old row is cancelled first. Not counted as an opt-out — a storage switch is not a user's verdict on reminders.
- **Erasing your data deletes the server row** (AC1b), via a pre-erase hook — the capability token that authorises the delete dies with the file, so it cannot run afterwards.

**The decision (Brad, 2026-08-11):** move to reminders **on by default**, opt-out rather than opt-in. Sends are rare by design (screening 90d / bloods 180d / med-review 365d cooldowns), so the cost to a user who ignores them is near zero while the value to one who forgets a colonoscopy is the product's entire thesis.

**Two constraints that bound the redesign** (they are not negotiable and any implementation must satisfy both):
1. **The email must be verified — the provider's word, or proven delivery (superseded 2026-08-14; original wording said "never a client-typed address … only after a confirm-link round trip").** The threat is unchanged: anyone can enter `victim@example.com` and make Brad's server email a stranger. What changed is the accepted proof: Brad rejected the confirm click (loses 20–40% of honest users) in favour of **delivery-validation + defense-in-depth**, now specified in US-23 — bounce/complaint webhook un-enrols, 3-day quiet period before any reminder, server-side label allow-list (no attacker-authored text can transit), typed writes can never touch a provider-verified row, refreshes preserve token + cooldowns (no resend amplification, no broken unsubscribe links), one plan-ready email per address ever, prominent in-body unsubscribe. A typed address with none of those protections remains forbidden.
2. **Default-on must stay visible, never silent.** Auto-enrolling silently would push every cloud-connected user's due-dates + labels to Brad's server without them knowing — quietly weakening the "your health data lives in your cloud, not our servers" promise that the product is marketed on ([architecture-v2.html](architecture-v2.html)), and inviting spam complaints that damage the sending domain shared with transactional mail. **Recommended design point:** at the cloud-connect success moment, a visible, pre-checked "Email me when something comes due" with a one-line plain statement of exactly what leaves the device (due date + label + email — never values), unmissable on one screen, plus a permanent off switch in settings.

**Where the audience actually is (live pull, 2026-08-10 — this reorders the work):** Klaviyo holds **874 captured emails** on the commerce list (+39 edu), still growing ~4–5/day (135 in the last 30d). `cloud_connect_success` has fired **2 times ever**. So the provider-verified lane covers ~2 people and the typed-address lane covers ~900: **the typed lane is not a nice-to-have Phase 2, it is the entire audience.** Build order follows the numbers, not the ease.

**Confirmation email sends via Resend, never Klaviyo (decision 2026-08-11).** Reminder consent must never be coupled to the marketing list: Klaviyo suppression is list-wide, so a supplement-promo unsubscribe would silently stop "your colonoscopy is due" — a marketing preference overriding a health reminder, with no error and nobody noticing. Two consents, two systems, two suppression lists. Supporting reasons: the confirm mail is textbook transactional (one-time, user-triggered, expected in seconds); a confirm landing in spam fails the whole redesign silently, and transactional streams land better; Resend is already wired (`reminder-v2.server.ts`, `email.server.ts`). Precedent already in the code — [api.reminders-v2.ts](../app/routes/api.reminders-v2.ts) takes `verified.email` for reminders and a SEPARATE `marketingEmail` for Klaviyo, fire-and-forget so Klaviyo can never fail an opt-in. Bonus: confirming before adding to Klaviyo filters typos/fakes, which raises Meta/Google audience match rates and cuts per-contact spend.

**No confirm-click gate (Brad, 2026-08-11).** Double opt-in loses 20–40% of legitimate signups — taxing every honest user to catch a rare bad one. Instead the plan-ready email (US-22) does the work: a bounce proves the address is dead, and delivery is the enrollment trigger. The residual risk a bounce can't catch is a typo into a *valid stranger's* address (`john@` for `johnn@`), which delivers fine; AC2c bounds that (rare sends + prominent one-click unsubscribe). A click on that email is a strong ownership signal but is never required — treat clicks, not opens, as real (Apple Mail Privacy Protection fakes opens).

**The ~900 existing captures (still needs a Brad call):** they gave an email for a report, not for reminders, and predate any send. A bulk "want reminders?" mail is a re-permission campaign to people who never asked — real complaint risk on a domain that also carries transactional mail. Preferred shape if we do it: one genuinely useful email (plan re-entry + the reminders offer), once. Both lists are `single_opt_in` today, so no confirmation habit exists with these contacts.

- AC1: On cloud-connect success (Drive/Dropbox/GitHub), enrollment happens **immediately and without any user action** — true opt-out (Brad, 2026-08-11). A user who reads the line and clicks away IS enrolled; only an explicit toggle-off unenrolls. The disclosure is a visible statement + already-on switch on that same screen, never a gate.
- AC1b: Consequence of AC1, accepted knowingly: every cloud-connecting user's due date + label + verified email reaches the server, where before only explicit opt-ins did. Still no measurement, lab value, or reasoning — the local-first invariant holds — but the population sending metadata widens from ~2 to everyone who connects. If a toggle-off arrives, the server row is DELETED, not just flagged.
- AC2: The enrolled email is either provider-verified (cloud-connect ✅ built 2026-08-13) OR a typed address whose plan-ready email **delivered without bouncing** — the typed lane is now its own story, **US-23** (promoted 2026-08-14: it is ~10× the cloud lane and the highest-leverage unbuilt thing in the product). No confirm-click gate — see the consent reasoning below.
- AC2b: A hard bounce disenrolls: no reminders, and the address is suppressed (unsubscribed, not deleted) in Klaviyo — matching US-22 AC3's reversibility decision.
- AC2c: Because a delivered-but-mistyped address belongs to a stranger, the FIRST reminder to any bounce-validated (not provider-verified) address must carry the one-click unsubscribe prominently in the body, not just the header. Rare sends (90/180/365d) + one click to stop = bounded, self-correcting harm.
- AC3: A user can turn reminders off permanently in one action, from the results surface and from any reminder email (RFC 8058 one-click unsubscribe already ships).
- **Known residual risks, accepted not fixed (adversarial review 2026-08-13).** (1) If a user moves their `health-roadmap.json` to the Drive trash, the app sees a legitimately-empty query result — indistinguishable from a new user — and re-enrols, minting a token that invalidates the one in the real file; the next schedule push 404s and flips them to `cancelled`. A silent unsubscribe, very narrow. (2) Drive does two `tryServerRefresh` round trips per load until enrolment succeeds (one in `resolveBackend`, one in `getReminderProof`), on two adapter instances sharing localStorage. Refresh grants don't re-issue the refresh token, so no credential can be stranded — it's waste, not risk.
- AC4: Turning reminders off survives a sync from a second device (see the 2026-08-07 incident below — this AC exists because that exact bug shipped).
- AC5: The server still receives only due date + label + verified email + capability token. No measurement, lab value, or reasoning ever leaves the device — default-on must not widen the data sent. **Open nuance for Brad (adversarial review, 2026-08-13):** a label can carry an inference even though it carries no value. `'Lung screening (low-dose CT)'` is emitted ONLY for a ≥15-pack-year smoker, `'Medication review'` only for someone on active medication, and result-dependent intervals make some `dueAt` values a function of a result. Under opt-in the user chose that knowingly; under default-on they didn't. The shipped copy was changed to be concrete rather than reassuring ("the NAME and due date of each check-up, for example 'Colonoscopy — due May 2027'") instead of the earlier "never your measurements or results", which was true and misleading. If Brad wants the inference closed rather than disclosed, the options are generic labels ("A screening is due") or dropping the lung item.
- AC6: Local-storage-only users (no cloud, no verified email) are never enrolled and are never shown a broken control.
- **Usage signal (Lane B, declare before code):** `reminder_optin` fires on enrolment (auto or manual) and `reminder_optout` on disable — both wired 2026-08-13, both in the shared `PRODUCT_EVENT_NAMES` enum. The ratio is the honest measure. Kill criterion: if opt-out exceeds ~30% of enrolments, or spam complaints appear in Resend, the default-on decision is wrong and reverts. Caveat to read the first numbers with: `trackProductEvent` is Shopify-surface-only and throttles to once per event name per tab session, so these are session counters, not per-user counts.
- Evidence: ~1 genuine opt-in ever (live query 2026-08-10); `reminder_optin` 0 fires since instrumentation went live 2026-08-06 — but both existing opt-ins PREDATE instrumentation, so zero events measures reach, not rejection. First default-on week (2026-W33): 18 enrolments, 0 opt-outs (kill-ratio 0% vs the 30% threshold); `reminder_optin_v2` 2 → 20 rows all-time. `reminder_log` empty and `last_sent: {}` are correct (nothing due yet), not a send bug. Cron `reminder_v2_cron` healthy (lock acquired daily).
- Tests: ✅ schedule/due logic + store persistence (2026-08-07); ✅ enrolment path — 27 cases across three files (2026-08-13): `standalone/reminders.test.ts` (22 — AC1 auto-enrol/token/`reminder_optin`-only-after-flush, silent proof, transient-vs-401 retry, AC4, AC6, Pages no-op, cloud switch, erase teardown, `reminder_optout` only on a server-confirmed cancel), `storage/drive-reminder-proof.test.ts` (3 — the real popup contract, unmocked), `storage/roadmap-store-data-safety.test.ts` (2 — an opt-out survives an erase; no token or address survives it). **What they do NOT prove:** reminders.test.ts mocks at the module boundary, so it pins the fetch payload and the branch logic, not that a real user gets enrolled. ❌ still manual: the live cloud-connect → enrol → notice-visible journey on real WebKit (needs a real provider round trip).
- **Incident 2026-08-07:** store-level tests found `setGlobalReminderOptout` mutated rows without bumping their merge stamps — "turn off all reminders" silently reverted on the next sync. Fixed same day (routed through the stamped upsert path); regression test pins it. **The "load-bearing TODO" it left is resolved (2026-08-13) — partly by evidence, partly by code.** By evidence: in the v2 builds the off switch is `cancelReminders()`, which DELETES the server row and flips the file's opt-in to `cancelled`, a stamped LWW singleton that carries the opt-out to every device; the per-category `reminderPreferences` UI that `setGlobalReminderOptout` drives (`ReminderSettings` in ResultsPanel) is unreachable in both v2 builds, because `standalone/app.tsx` is the only renderer of `HealthTool` and always passes `remindersSection`, which wins that branch. Nothing needed seeding. **By code, because the first draft of this feature got AC4 wrong and an adversarial review caught it before it shipped:** "Delete all my data" resets the file, and an empty file reads as "never decided" — so the next load would have re-enrolled the user, undoing an explicit opt-out via a button promising the opposite, on every device at once (a higher `eraseEpoch` wins the merge wholesale, so a second device's `cancelled` record couldn't save them either). The erase now carries the decision without the identity: `status:'cancelled'`, no token, no email. Same bug class as 2026-08-07 — an off switch that comes back on — which is why AC4 is stated as a survival property, not a UI feature. Separately, the dead v1 preferences chain is now unreachable code awaiting a deletion sweep (spans HealthTool + ResultsPanel + api.ts + roadmap-store; it predates this change, so it is a follow-up commit rather than a rider on a consent-model change).

### US-18 · Generate my plan as a downloadable PDF (guest capture button)
As a guest, I enter my email and **immediately get my whole plan as a downloadable/printable PDF** — no account, no waiting on an inbox. (Corrected 2026-08-11: this story used to claim "I can email myself the report", which has not been true since `525e6be`, 2026-06-12 — "NO Resend report email, and NO health data reaches the server". Nothing was ever emailed. The general print/save path is US-08.)
- AC1: The button renders the plan and opens the save-as-PDF/print window **client-side** — the plan never leaves the device.
- AC2: The typed address is subscribed to Klaviyo fire-and-forget; a Klaviyo failure never blocks or delays the PDF.
- AC3: Rate-limited per address (guest report limit) and behind app-proxy HMAC; Shopify surface only — the Pages build has no Brad server and must no-op.
- AC4: The PDF is the delivery. US-22 has shipped, so the UI may promise the plan-ready email; once US-23 ships, the capture UI must also carry its reminders disclosure (US-23 AC4).
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
- AC9: Ships on **both** Fly apps (commerce + education) together; they share one Resend key and from-address. The bounce webhook needs only ONE endpoint, hosted on commerce: both apps send through the same Resend account, and the handler writes to the shared Supabase + the single commerce Klaviyo list.
- AC10: The webhook also handles `email.complained` (spam complaint), not just `email.bounced` — under an opt-out model a complaint is the loudest possible "I never wanted this", and must suppress in Klaviyo AND unenroll from reminders immediately.
- **Usage signal:** `report_email_sent` / `report_email_bounced` / `report_email_clicked`. Bounce rate on new captures is also the estimate for how much of the legacy ~900 is junk — the input to the backfill decision. First live week (2026-W33): 25 sent, 10 clicked (40% CTR), 1 bounced (4%, webhook un-enrolled it end-to-end in production), 0 complaints.
- **Brad prerequisite: ✅ DONE 2026-08-13.** Webhook registered in Resend (bounced + complained → commerce route), `RESEND_WEBHOOK_SECRET` set via file→fly→shred. Live-verified end-to-end with a REAL bounce: signature accepted, `{"ok":true,"action":"bounced","count":1}`, Klaviyo suppressed, row deleted.
- **AC1 amended 2026-08-14 (US-23/US-24):** the email may now ALSO carry the reminder calendar — labels + due dates with add-to-calendar links — when the capture enrolled reminders. That is the constitution's permitted footprint and US-22 AC1's own "what reminders they'll expect", not health data; the "no measurement, lab value, medication, or screening RESULT" clause stands.
- Tests: ✅ 18 (2026-08-13/14): `resend-webhook.server.test.ts` (12 — signature verify, bounce/complaint parse, permanence filter), `plan-ready-email.test.ts` (6 — no-health-fields shape, calendar section, links).

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
- **Phase 1 — surface what exists: ✅ SHIPPED 2026-08-07.** `AdditionalLabRows` renders grouped, collapsed-by-default read-only rows beneath the blood-test matrix (inline SVG icon per group, count, mixed-unit flag, "Other tests" bucket for uncatalogued names). Logic in `lib/lab-rows.ts` (13 tests); catalogue resolver handles LLM underscore/space variance. Corrections deferred to phase 2 (labValues have no store-level correct method yet). Signal live: `lab_rows_viewed` — 15 events in the first instrumented week (2026-W32) vs 190 `results_viewed` (~8% of viewers expand the additional-lab rows); 2026-W33: 6 (novelty wear-off vs the 08-14 relayout — W34 decides). **AC1 layout fix 2026-08-14 (found live by Brad):** phase 1 had shipped expanded groups as horizontal "dated value strips", violating AC1's "matching the matrix's column/date alignment" — expanded groups now render the same `bt-*` date-column matrix as the core 8 (shared `BatchDateCell` + CSS vars, per-group date columns, newest column pinned, name column pixel-aligned with the core matrix; layout pinned by a component test + `labGroupMatrix` unit tests).
- **Phase 2 — manual add: ✅ SHIPPED 2026-08-14 (add only; corrections still open).** "+ Add a blood test" beneath the groups (`AddLabTest.tsx`): catalogue picker grouped by panel, canonical unit FIXED for known tests (AC3), free-form name+unit via "Other", native date input, saves through `bulkSaveLabValues` under the stable catalogue key (AC4 — manual and upload-extracted values share a row), store-side same-day dedup surfaced as an inline notice. Section now renders (with just the button) even before any lab values exist. Gated exactly like the labValues fetch (`isLoggedIn`; always-on for the standalone build). Signal live: `lab_row_added` — 0 events in its first ~1.5 live days (deployed 08-14; true zero, watch W34). labValue CORRECTIONS remain open — they move to phase 3's scope.
- **Units fix (same day, found live by Brad):** the catalogue now covers the common FBC/chemistry tests that were dumping into "Other tests" (new `haematology` "Blood count" group — Hb/Hct/RBC/WBC/differential/platelets/MCV/MCH/MCHC/RDW — plus eGFR under renal, globulin under liver), and display units are normalized at render: `normalizeLabUnit` fixes report/LLM spelling ("umol/L"→"µmol/L", "x 10e9/L"→"×10⁹/L", "1.73m2"→"m²"), `displayLabUnit` relabels same-unit spelling variants to the catalogue canonical (haematocrit "ratio" ≡ "L/L" via per-entry `unitAliases`), so false "Units vary between reports" flags are gone. SPELLING ONLY — stored values stay as-reported; genuinely different units still flag mixedUnits (AC3).
- **Adversarial review 2026-08-14 (verdict: ship with fixes — applied same commit):** dedup slots now resolve to the catalogue KEY (an upload's "Gamma GT" + a manual "ggt" on the same day was two active rows — the exact duplicate the notice exists to stop); Greek μ (U+03BC) normalizes to µ (U+00B5); "m^2" joins "m2"→"m²"; `hs_crp` resolves; save() catches store throws; future dates blocked in canSave. **Residual risks accepted:** (1) manual entry has no per-test plausibility bounds — a US-report user can type a g/dL number into the fixed g/L field (10× off, no warning; blast radius is display-only since additional labs feed no suggestion logic; bounds belong to phase 3 with conversion); (2) HistoryPanel still charts raw units/raw-name series (cosmetic inconsistency with the matrix); (3) cross-device merge unions by id, so a same-day name-variant pair created on TWO devices before syncing still survives merge; (4) eGFR reported as bare "mL/min" deliberately still flags mixed units — raw clearance is genuinely a different quantity than the BSA-normalized canonical.
- **Phase 3 — normalization + corrections:** unit conversion at save/review for catalogue tests (+ per-test plausibility bounds for manual entry); labValue corrections (entered-in-error + correctsId, AC5).

---

### US-23 · Typed-email reminders — **THE TRUNK (Brad-approved 2026-08-14; BUILT same day, awaiting deploy + live verify)**
As someone who typed my email to get my plan PDF, I get reminded when my check-ups and blood tests come due — because my lane is ~10× the cloud lane (874+ captures, ~4–5/day vs 3 cloud connects ever). **This is the highest-leverage unbuilt thing in the product.**

**Why it's safe now:** US-22's delivery-validation machine is live and verified (signature-checked bounce/complaint webhook → Klaviyo suppression + `deleteByEmail`). Delivery is the consent gate Brad chose over confirm-clicks; a bounce un-enrols before any reminder could ever fire.

- AC1: When the capture button is pressed, the client sends the **schedule alongside the email** — the same client-computed labels + due dates as US-17, stored as one `reminder_optin_v2` row with `provider: 'typed'`. Nothing else crosses (constitution: calendar, not chart).
- AC2: No reminder is ever sent to a typed address until the plan-ready email has had time to bounce. **Precisely (2026-08-14, second review):** the gate is a quiet period, not positive delivery confirmation — the cron skips typed rows for 3 calendar days from `created_at` (effective floor ~2d8h given the 08:00 UTC send hour; never `updated_at`, which refreshes touch), and the bounce/complaint webhook un-enrols within minutes-to-hours, comfortably inside it. This covers the overdue-at-capture case too. Residual, accepted: a plan-ready send that FAILS outright (Resend outage) is logged, not retried — the enrolment stands on the typed consent + quiet period alone. Upgrading to a Resend `delivered`-event flag is future hardening.
- AC3 (both lanes): Every reminder email carries the user's **full upcoming schedule**, not just the due item — the email is the surviving artifact for a user whose localStorage is long gone (constitution: durability). The server already stores the whole list; this costs nothing.
- AC4: Labels are **specific** ("Colonoscopy — due May 2027"), per the constitution's recall-letter decision — and **server-validated against health-core's `SCHEDULE_LABELS` allow-list**: an unauthenticated capture names someone else's inbox, so no client-authored text may ever transit into an email (the old free-text `label` field was the hole). The capture UI carries a one-line disclosure that typing the email turns reminders on, with the off switch named.
- AC5: EVERY reminder to a typed address carries the one-click unsubscribe prominently in the body, not just the header (a superset of US-17 AC2c's "first reminder" — a delivered-but-mistyped address belongs to a stranger; rare sends + one click = bounded harm).
- AC6 (both lanes): **The annual floor** — if the computed schedule has nothing due within 12 months, seed one "Annual health check-in" item 12 months out. Every enrolled person gets at least one touch a year; a colonoscopy-every-10-years user must not get a decade of silence (Brad, 2026-08-14).
- AC7: Re-capturing with the same email **refreshes the schedule ONLY** — the token and `last_sent` cooldowns are preserved, and a typed write can never touch a provider-verified row. Each of those three is load-bearing: a rotated token breaks the unsubscribe links in every email already sent (the page would claim success while the row lives on); reset cooldowns turn one re-capture/day into daily re-sends of whatever is due; and clobbering a verified row would 404 the victim's own device into a silent "you unsubscribed".
- AC8: Abuse bound for `victim@example.com` (rebuilt after the second adversarial review found the first version had three bypasses): **the plan-ready email fires ONLY on a NEW enrolment** — a schedule-less body sends nothing (was: per-capture), a capture against a cloud-enrolled address sends nothing (was: per-capture at exactly the most engaged users), and **unsubscribe is a durable TOMBSTONE for typed rows** (schedule emptied, row + token kept), so a replayed capture is a refresh (no email), not a fresh enrolment (was: unsubscribe→re-capture minted a new email each cycle). Plus: per-IP rate limit (20/hr) beside the per-email 5/day, the response is CONSTANT (an `enrolled` field was a membership oracle for typed emails), labels allow-listed (AC4), unsubscribe links never rot (AC7 + provider-upgrade token preservation), complaint (US-22 AC10) suppresses + un-enrols immediately.
- AC9: Shopify surface only — the capture UI is now gated on `SHOPIFY_SURFACE` **explicitly** (before 2026-08-14 Pages was protected only by its hardcoded `data-logged-in="true"` attribute — an accident, not a gate).
- **Usage signal:** `reminder_optin` vs `reminder_optout`, both carrying `provider` so the lanes are judged separately; same ~30% kill criterion as US-17. Both sides of the typed ratio are counted SERVER-side: optin on the capture route (only NEW enrolments — refreshes don't inflate the denominator, and abuse enrolments are counted rather than invisible), optout on the unsubscribe page (the typed lane's primary off switch — it was structurally blind before the first review). Bounce rate on new sends stays the estimator for the legacy-~900 backfill decision (US-22 AC8, still Brad's open call).
- The **annual floor (AC6) is computed client-side AND clamped server-side on every write** (`ensureAnnualFloor` — pure date arithmetic, so the server stays a dumb scheduler). The server clamp is an integrity bound, not UX: anyone who knows a typed user's email can overwrite their schedule via re-capture (AC7's refresh is unauthenticated by construction), which would otherwise be a silent per-user kill switch for the retention engine; with the clamp, the worst an attacker achieves is degrading a victim to annual check-ins — each carrying the one-click off switch. Tombstones (explicit unsubscribe) are exempt: an off stays off. `annual_checkin` is a first-class `ReminderCategory` (group `annual`, 365-day cooldown).
- **Known residual risks, accepted knowingly (second review, 2026-08-14):** (1) a typed schedule remains rewritable by anyone who knows the email — bounded by the floor clamp, label allow-list and real-date validation to "someone could change WHICH canonical items/dates a victim is reminded of", with every email carrying the off switch; (2) a deliberate re-capture refills a tombstoned schedule — that's the opt-out model's re-consent path, and an attacker using it buys only rare reminder-cadence emails; (3) the rate limiters are per-process in-memory (reset on deploy, per-machine) — bounds are soft, ×2 across the two Fly apps.
- Evidence: first live week (2026-W33, deployed 08-14): 17 typed enrolments vs 3 cloud rows all-time — the ~10:1 typed-lane bet held almost exactly; plan-ready CTR 40%. Production rows with provider 'typed' + delivered emails now exist, though the deliberate end-to-end capture walk-through the Tests line calls for is still owed.
- Tests: ✅ 25 server/health-core cases 2026-08-14, incl. a ROUTE-level suite (`api.measurements.test.ts`) pinning the isNew gate, the schedule-less and cloud-row no-send paths, the constant response, the tombstone, `upsertOptin`'s typed-refusal, the server floor clamp, and the real-date refine. ❌ live verify after deploy: a real typed capture → row lands with provider 'typed' → plan-ready email carries the calendar.

### US-24 · Add my check-ups to my calendar — **Brad-approved 2026-08-14 (links, not attachments)**
As a user reading my plan or a reminder email, I can add any due item to my own calendar in one tap — Google/Apple's calendar becomes a reminder engine Brad never operates (the zero-server rung of the reminders ladder).
- AC1: Implemented as **Google Calendar template links** (`calendar.google.com/calendar/render?action=TEMPLATE…`) — plain URLs, no attachments (Brad, 2026-08-14: cleaner than .ics; Resend supports attachments but links beat them on deliverability and simplicity).
- AC2: Each link creates an all-day event on the due date, titled with the label, description linking back to the tool — **via the canonical storefront URL** (`drstanfield.com/pages/roadmap`), never a fly.dev backend host: the description is visible text in the saved event, and a raw redirect URL reads as phishing (found live by Brad, fixed 2026-08-14; cost accepted — calendar-sourced returns go uncounted, only the email CTA routes through `/roadmap/open`).
- AC3: Links appear wherever the schedule renders in email (plan-ready email once US-23 gives it a schedule; every reminder email).
- AC4: Zero server-side storage change; zero new data crosses.
- Tests: ✅ URL-building pinned (`plan-ready-email.test.ts`: TEMPLATE params, exclusive end date incl. year rollover, re-entry pointer); email placement pinned in the calendar-section suites.

### US-25 · The mobile app — architectural destination (stub; this-year ambition once the web loop is proven)
As the avatar's future self, I have an app that makes the whole thing automatic: **on-device notifications** (reminders with no server at all — the true serverless end-state), **HealthKit ingestion** (US labs push results into Apple Health; the app reads bloods, recomputes the plan, no typing), durable storage (no localStorage wipe anxiety). The enrolment/consent model built for US-17/US-23 transfers as-is; the server calendar shrinks toward zero as users migrate. Every near-term decision gets checked against the constitution's question: *does this move toward or away from the phone?*

### US-26 · Action links — every reminder pairs the "what" with a "where" (stub)
As a user told a lipid panel is due, the reminder also tells me where to get one — direct-to-consumer lab links (Quest/Ulta-style, US), supplement refills via Brad's store, later pharmacy integration. Start affiliate-grade (plain links, zero API work); the click-through data is the evidence needed before building any real integration. This is the monetization seam, honestly labeled — and it must never gate the reminder itself.

## Coverage priorities — 2026-08-07 pass: DONE

1. ✅ US-10/US-04/US-11/US-13 — RoadmapStore + SyncManager suites landed (16 tests) and **immediately caught the eraseEpoch-resurrection defect** (see US-11), fixed same day.
2. ✅ US-03 — date-defaulting semantics pinned.
3. ✅ US-07 — LDL-without-total already covered; verified.
4. ✅ US-02 — BP dead-click + tooltip fixes shipped (collapsed-row value click, matrix shell focus, click-toggleable InfoTooltip, mobile fixed-bar clearance).

**2026-08-07 later passes:** US-12 pure-pipeline tests landed (incl. the real `health.zip` local fixture); store gaps closed (deleteLabValue, documents, screenings, reminder prefs — which caught and fixed the US-17 opt-out revert bug); input hardening (US-02 AC4–6) shipped and live-verified; US-21 catalogue scaffold (`lab-catalog.ts`) created.

Still consciously deferred, each needing infra or a product decision first: cloud adapter unit tests (OAuth mocking heavy), chat UI + upload modal state machines + canvas/pdf.js rendering (need browser-mode test infra — jsdom/Playwright component testing), print (manual/live verify), HealthTool hydration gate (UI-level), reminders opt-in UX path (pending the keep-or-kill decision).
