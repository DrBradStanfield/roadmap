# Repository audit, 7 September 2026

Audited checkout: `7eacd93`, after `git pull --ff-only` confirmed it was current.
This is an assessment, not an implementation plan approved for execution.
Production code changed: 0 lines. Production code deleted: nothing; this audit adds a report only.

The core idea is good: help a health-curious person decide what to do next,
take a useful summary to their clinician, and remember the next check.
The current implementation is broader than the evidence for demand supports.
Its strongest asset is the explicit, reusable clinical engine. Its greatest
weakness is the gap between strong written promises and what all the live
paths actually guarantee.

## Scope and limits

Read CLAUDE.md and reviewed the architecture, user stories, algorithm,
reference material, deployment workflows, agent contract, MCP design,
upload designs, privacy draft, design system and recent loop reports.
Traced representative paths through entry, calculation, suggestions,
storage, merge, upload, chat, reminders, telemetry and hosted tools.
Inventoried the wider code and documentation. This does not mean every line
or every article in the 1,106-file documentation tree was independently
validated. In particular, the clinical knowledge corpus needs its own
source-by-source review.

Product counts below come from the checked-in W36 report, covering
29 August to 5 September UTC. They were not freshly queried from production.
Live browser inspection was limited to the public roadmap and synthetic
first-fill checks. No real health record, email enrolment, paid AI call,
provider write, deployment or production database mutation was performed.
This is not a penetration test or comprehensive clinical validation.

Fresh real WebKit contexts at desktop 1440px and iPhone 390px completed
synthetic sex/height/weight entry with no document horizontal overflow.
They displayed BMI 26.1, ideal weight 73.8kg and protein 89g/day for the
male/175cm/80kg example. Non-read requests were blocked. Chrome inspection
independently confirmed the live bundle name. These are limited checks of
rendering and progression, not proof of persistence or all mobile journeys.

## Product judgment

The constitution in `docs/user-stories.md:5` is unusually useful: a preventive
protocol and recall system, with email as the recurring surface. That is a
credible job for this audience. Annual use can be success. Daily active
users would be the wrong target.

There are three different ambitions in the repository:

1. A short check-up and a practical reminder calendar.
2. A longitudinal health record with document storage and cloud sync.
3. An AI-accessible record platform, plus web, YouTube and Discord chat.

They can share code, but they do not share the same evidence of demand.
Treat the latter two as optional extensions with explicit budgets. Do not
let their infrastructure dictate the first-time experience.

The product's advantage is your audience, clinical judgment, understandable
reasoning and continuity. More storage providers and more chat surfaces do
not independently strengthen that advantage. The portable file and pure
engine are useful options to preserve; the product need not expose every
option to every user.

The app also has much richer medication and laboratory machinery than
structured understanding of the user's habits and ability to act.
`HealthInputs` in `packages/health-core/src/types.ts:10` captures measurements
and demographics, while the core promise includes sleep and exercise.
That is a reason to narrow claims of personalization and improve action
selection, not automatically add another long questionnaire.

## What the available usage evidence supports

Source: `docs/loops/product-health/2026-W36.md`.

| Observation | Interpretation |
| --- | --- |
| 214 results-view events in W36, down from 261 | Some reach, but these are events, not unique completed plans or outcomes. |
| 20 reminder opt-ins; 109 lifetime rows, 101 typed | Email is much better supported than cloud-first onboarding. Default enrolment is not proof that reminders help. |
| 19 report emails sent, 11 clicks | Encouraging activity; uncohorted counts cannot establish a 58% recipient conversion rate. |
| 5 upload starts, 3 saves, no extraction-failure events | Preserve upload and investigate abandonment; this is too small a sample to infer an accuracy problem. |
| 7 cloud starts, 3 successes; cumulative 26 to 14 | Connection friction warrants attention. This is not evidence to build more providers. |
| 3 MCP connects and 50 tool calls | The report identifies this as Brad-led verification. Organic demand is still unproven. |
| 2 reminder-send events | The long-term recall outcome has barely begun to be observed. |

The present evidence does not establish health benefit, sustainable paid
demand, or incremental supplement revenue. It establishes some use and a
promising email capture path. Do not substitute feature counts, clicks or
low opt-out rates for the question: did someone complete a useful action?

## Findings to address first

### 1. Lung-screening attribution and implementation disagree with the source

Confidence: confirmed source and code mismatch. Priority: high.

`packages/health-core/src/evidence.ts:451` attributes a 15 pack-year threshold
to USPSTF 2021. `suggestions.ts:934` applies that threshold to current and
former smokers without a years-since-quitting input. The algorithm table at
`health_roadmap_algorithm.md:578` repeats it. `roadmap_text.html:658` also
uses 15 pack-years, but additionally says screening is not recommended after
15 years since quitting; the code does not enforce that distinction.

The [actual USPSTF recommendation](https://www.uspreventiveservicestaskforce.org/uspstf/recommendation/lung-cancer-screening)
specifies 20 pack-years and current smoking or quitting within 15 years for
the stated age group. Thus the three-file process both repeats a source
error and misses a behavior difference between prose and code.

Decide the intended clinical policy, then align inputs, suggestions,
reminders, evidence and prose. An intentionally different Brad protocol
must be labelled as such rather than attributed to that guideline.
Add cases around the eligibility boundaries and independent source review.
Passing tests against a mistaken specification cannot resolve this.

### 2. A chat failure sends free-text health information to Sentry

Confidence: locally reproduced scrubbing failure and traced call path.
Priority: high. Production transmission frequency was not measured.

`app/routes/api.chat.ts:440` passes the user's message to `reportChatFallback`.
`app/lib/chat.server.ts:684` puts its first 100 characters into
`extra.messagePreview`; it also includes `errorDetail` and sometimes uses
that detail as the exception message. The server scrubber filters known
keys but leaves arbitrary strings under those keys intact.

A synthetic local call to the actual `instrument-scrub.mjs` retained
`messagePreview: "SYNTHETIC: my LDL is 4.2 mmol/L"`, while correctly filtering
a separate `ldl` key. No telemetry was sent in this test.

Remove user text and provider response bodies from observability payloads.
Use bounded codes and approved metadata at construction time. Test the
complete serialized event, including exception messages, rather than only
the list of sensitive field names. Truncation is not redaction.

### 3. The main production widget is omitted from Sentry's URL allow-list

Confidence: confirmed with the installed SDK and the live script URL.
Priority: high.

`widget-src/src/lib/sentry.ts:163` permits `health-tool.js`,
`health-site-chat.js` and the hosted Pages asset path. The current Shopify
build emits `health-plan-v2.js` and related chunks
(`widget-src/vite.config.shopify-prod.ts:76`). Chrome inspection confirmed
the public page loads that v2 name.

The installed `@sentry/core` EventFilters dropped an otherwise identical
synthetic exception from the v2 URL while accepting the old and site-chat
URLs. This is a concrete monitoring blind spot for matching stack events;
it does not imply every possible widget event is dropped.

Test the emitted bundle names against the actual filter, including lazy
chunks and the separate chatbot bundle. Then verify delivery from each live
surface. Add surface/release attribution before treating silence as health.

### 4. Privacy language overstates what is absent from servers

Confidence: confirmed persistence path; vendor configuration not verified.
Priority: high.

The local-first record is real. However, user and assistant messages are
stored in `chat_messages` (`app/routes/api.chat.ts:385` and `:448`). Either
can contain lab values, medications or other health information. Calling
those rows operational does not change their contents.

`README.md:9` says the data never lands on the server; the constitution
explains processing and chat retention elsewhere. The doctor posture also
describes chat history as living in the user's storage without acknowledging
the server conversation copy. These claims need one consistent account of
record storage, transient processing, conversation retention and deletion.
The live mobile view also puts "Nothing is stored on our server" above an
email form that correctly discloses storage of check-up names and dates.
Even without chat, those neighboring statements need reconciliation.

The connector privacy draft says imported content is not kept by Anthropic.
[Anthropic's standard commercial retention statement](https://privacy.claude.com/en/articles/7996866-how-long-do-you-store-my-organization-s-data)
describes deletion within 30 days, with exceptions including different
agreements. Verify the actual organization/workspace arrangement before
promising zero retention. This audit did not establish whether you have ZDR.
The file is explicitly a draft; this is not a claim that it was published.

### 5. Shared sync code does not mean identical durability guarantees

Confidence: confirmed implementation limitation, not a reproduced live loss.
Priority: high before expanding concurrent writers.

Dropbox and the local file adapter have stronger write preconditions than
the browser Drive adapter. `widget-src/src/storage/drive.ts:348` ignores
`expectedVersion` and overwrites. The hosted Drive adapter checks a version
before writing, but that remains a check followed by a separate write.

`sync-manager.ts:129` verifies a clock and append-only row IDs. It cannot
prove preservation of every scalar value, and no post-write read can stop
a later stale writer overwriting a previously acknowledged write.
`roadmap-doc.ts:54` shows the scope of row-ID verification.

Retain the shared merge engine. State provider-specific guarantees honestly,
reuse the strongest existing Drive behavior in the browser, and exercise
adversarial write orderings including profile and screening changes.
Do not describe Drive as having an atomic conditional write or promise that
every acknowledged change is permanently protected by read-back verification.

### 6. Green CI does not establish server type correctness or full journeys

Confidence: confirmed local checks and workflow inspection. Priority: medium.

All 113 suites and 2,191 tests pass across the initial run and targeted retry.
The first run had nine environmental failures because the sandbox blocked
tsx IPC; all 34 tests in the three affected files passed outside that sandbox.
Widget and health-core TypeScript checks pass.

Root TypeScript reports 33 errors. Several concern stale package declaration
resolution, so this is not 33 demonstrated runtime bugs. One actual server
error is a required parameter after optional parameters at
`app/lib/anthropic.server.ts:210`. CI explicitly omits app typechecking
(`.github/workflows/ci.yml:62`). Establish a clean server-specific check.

The deployment's `tools/webkit-verify.mjs` is a historical layout probe:
it seeds the old localStorage shape, prints measurements and returns an
error object when the matrix is absent. That missing-matrix branch does
not throw. It is useful diagnostic machinery, but not a strong acceptance
gate. Make critical journey checks assert behavior and fail the process.

## Features: keep, narrow, pause

| Feature | Judgment |
| --- | --- |
| Short check-up and prioritized plan | Keep as the central experience. Show a small actionable summary before the long reference material. |
| Evidence and clinician-facing PDF | Keep. Explain uncertainty, input dates and what the user should discuss. These are durable value outside the app. |
| Email and calendar reminders | Prioritize. Show when the schedule was last updated and make reassessment/completion practical. |
| Lab import with review | Keep. It removes typing. Improve review clarity, date/unit provenance and abandonment measurement before expanding ingestion breadth. |
| Corrections, dated history and original documents | Keep the integrity machinery. Make richer record management optional for users who actually need it. |
| Cloud storage | Keep existing users supported. Offer the simple device path first and hide advanced provider choice. Freeze new providers pending demand. |
| Read-only AI access and deterministic get_plan | A useful experiment using existing strengths. Evaluate with non-owner usage. |
| Hosted AI writes and imports | Retain safeguards; pause expansion until independent users succeed and consistency boundaries are tested. |
| Web chat | Keep focused on explaining the user's plan and answering evidence questions. Measure answer quality separately from article routing. |
| YouTube and Discord bots | Evaluate as business distribution tools, with separate cost and outcome accounting. Their volume must not stand in for roadmap demand. |
| Automatic supplement and skin suggestions | Move to optional material. `suggestions.ts:1052` always appends five supplement cards; this is not individualized selection. |
| Medication cascades | Keep the relevant educational context, but avoid presenting a broad checklist as individualized prescribing. Source attribution and eligibility need explicit review. |
| Native mobile app | A hypothesis, not the inevitable destination. Validate the reminder job before adding another major distribution and maintenance burden. |
| A/B administration | Freeze sophistication. At this volume, obvious comprehension and completion problems deserve attention before small copy optimizations. |

The supplement concern is about focus and trust, not a claim that every
ingredient is ineffective. Generic recommendation cards and affiliate skin
links deserve a clearly optional place separate from the important next
clinical action. The education chatbot's strict product posture is a useful
precedent to apply consistently.
The inspected mobile plan placed a large cloud-storage prompt and email/PDF
form before the actual next steps. Let the person see the useful answer
before asking them to decide how to keep it.

The recall system currently sends previously supplied dates, with category
cooldowns (`app/lib/reminder-v2-cron.server.ts:100`). That is useful, but it
does not know a test was completed or that circumstances changed. Typed
capture sends a schedule without returning a capability for ongoing browser
updates (`widget-src/src/lib/roadmap-data.ts:297`). The stories acknowledge
that its schedule is a snapshot. Improve the reassessment loop without
quietly expanding what is stored on the server.

## Code worth protecting

- `health-core` separates deterministic calculations, conversions and rules
  from transport and UI. Preserve that separation.
- `merge.ts`, `record-edits.ts`, `file-adapter.ts` and their tests express
  real data-integrity requirements: correction history, stable identity,
  erasure epochs, backups and conflict detection. This is justified complexity.
- The shared extraction and reviewed commit paths reduce duplicate rules.
  Two-phase import and expected-value checks are better than letting model
  prose directly become an unreviewed overwrite.
- The hosted credential code has explicit cryptographic domain separation,
  audience binding and bounded input handling. It is thoughtful work,
  although this review does not certify the custom OAuth implementation.
- Resend reminders and Klaviyo marketing have separate suppression purposes.
  Preserving that distinction prevents a marketing unsubscribe from silently
  disabling service reminders.
- Regression fixtures, source-linked stories, real WebKit checks and
  incident learnings are valuable. The test baseline is substantial.

## Simplification with concrete targets

First remove the migration scaffolding, not the safety properties.

1. **Make local-first imports explicit.** `api.ts` is 1,039 lines and still
   contains retired CRUD transports. Vite redirects it to `roadmap-data.ts`,
   which re-exports survivors and shadows data functions. The latter admits
   its signature is kept compatible by hand because TypeScript does not
   check the swapped graph. Move the live server helpers to an explicit
   module, import the real data layer directly, then delete the superseded
   functions. Preserve API types and call-site evidence during removal.
2. **Remove unreachable account-era branches and flags.**
   `setAuthenticatedFlag` documents itself as write-only on v2. Confirm all
   bundle consumers before removal. The legacy rollback bundle no longer
   exists, so it is not a reason to retain a second implementation forever.
3. **Choose whether medication annotations exist.** The live store's
   `loadMedicationHistory()` returns `[]` (`roadmap-store.ts:343`) while
   `HistoryPanel.tsx` still loads it and builds chart annotations. Either
   implement that user benefit from the stored history, or remove the
   unreachable rendering and dependency if no other consumer needs it.
4. **Consolidate reminder eligibility.** `reminder-schedule.ts` explicitly
   carries a TODO to stop duplicating `reminders.ts`. Reuse the current
   parity tests as the gate. Duplication here multiplies clinical edits.
5. **Refactor components by state ownership.** `InputPanel.tsx` has 2,469
   physical lines, `HealthTool.tsx` 1,409, `ReviewTable.tsx` 1,091 and CSS
   5,536. Size alone is not a bug. Focus on profile/form state, import-review
   state and persistence boundaries; splitting arbitrary line ranges into
   helpers merely relocates the coupling.
6. **Keep the core tool contract separate from import orchestration.**
   `mcp-tools.ts` is 2,101 physical lines. Pure record operations and import
   I/O already have different responsibilities. Separate them without
   introducing a new framework or duplicating schemas.
7. **Separate current documentation from historical designs.**
   `docs/health-documents.md` still says implemented while describing retired
   server health tables. `docs/reference.md` names a surviving
   `deleteAllUserData` that is absent from the inspected server module.
   `roadmap-data.ts` still describes Shopify as pre-cutover. Mark old designs
   as historical and keep one concise current entry per subsystem.
8. **Separate operational schema setup from v1 history.** The documented
   setup SQL still creates retired health structures. Preserve migration
   history, but make a new operational install unambiguous. Do not drop
   production tables as a cleanup shortcut.

## Architecture and working practices

Local-first reduces the central record store and gives users meaningful
portability. It also transfers recovery and synchronization obligations to
the client. Losing a five-minute form and losing years of lab records are
different costs. The constitution's cheap-reentry argument fits the former;
it should not justify weak recovery for the latter.

LocalStorage also shares the storefront origin with theme and third-party
scripts. Ownership of the cloud file is not isolation from scripts running
on the record's page. An independently controlled application origin is
worth evaluating if the record platform grows; it need not trigger a rewrite
of the working Shopify distribution now.

The one-active-value-per-metric-per-day rule is reasonable for the current
manual matrix, but it is not automatically a raw device-data model. Before
HealthKit ingestion, decide how repeated readings, daily summaries and
provenance coexist. Do not overwrite useful samples merely to fit today's
screen, or expand the schema before there is a validated ingestion need.

The two Fly apps keep secrets and store posture separate. That is a
reasonable boundary, not an obvious service to merge. A new microservice
architecture would add cost without solving the current problems.

The agent loops do catch real issues. W36 detected the accidental removal of
17 user stories and restored them. The same report carries Sentry attribution
for a fifth week. The bottleneck is partly acting on findings, not producing
more reports. Judge each loop by important fixes completed and remaining
resolved, alongside its cost.

The main-only and sweep-everything rules make commits less attributable when
several sessions work at once. I would prefer bounded changes and explicit
review boundaries, especially for clinical and persistence work. This is a
recommendation to reconsider the policy, not a change to it. Likewise,
line-count budgets should encourage decomposition, not mechanically remove
requirements or reward unreadable compression.

## Recommended next phase

1. **Repair trust and verification:** clinical mismatch, telemetry leakage,
   bundle filtering, privacy wording, server typechecking and meaningful
   live assertions. Keep these as small independently reviewable changes.
2. **Improve the core journey:** short plan summary, clear import review,
   correct durable-save status, reminder schedule freshness and a practical
   path back to reassessment. Test on ordinary phones with non-owner users.
3. **Delete migration residue:** explicit local-first data imports, stale
   account paths, duplicate reminder rules and misleading historical docs.
4. **Test demand before widening scope:** observe independent users through
   setup, first useful result and later action. Give MCP, bots and mobile
   separate success criteria and stop dates. Do not count Brad's verification
   sessions as adoption or short-term return visits as preventive outcomes.

Measure completed useful actions, recall reliability and support burden.
Use privacy-preserving counters and optional user feedback; proving value
does not require sending medical results into analytics. For annual care,
early research can establish comprehension and successful scheduling while
longer follow-up establishes completion. These are different evidence stages.

My recommendation is to continue, narrow the near-term work, and make the
existing promise dependable. Keep the core and its safety machinery. Remove
the old architecture around it. Let demonstrated user benefit decide which
of the optional platforms earns further investment.
