# Audit follow-up: product plan and engineering decisions

Status: proposed, not implemented. Requested 7 September 2026.
The telemetry, verification and legacy-code fixes are a separate change.
This plan does not authorize clinical rule changes, new server health data,
a new authentication surface or deletion of historical design documents.

## Outcome

A new visitor can identify the next useful action, keep their plan, and
understand what will remind them. A returning visitor can update what has
changed without rebuilding a record unnecessarily. Someone receiving an old
reminder can tell it was based on an earlier schedule and reassess it.

The product remains a periodic preventive-care tool. Annual reassessment is
a valid outcome; daily visits are not the goal. Keep the existing default-on
reminder policy and separate marketing consent during the proposed UX work.

## Phase 1: let the answer come first

Suggested stories: extend US-01, US-07, US-08, US-18 and US-20. Write final
acceptance criteria in user-stories.md before implementation.

The mobile plan tab should read in this order:

1. **Your next steps.** Existing urgent items first, followed by a small
   preview of the current attention items. Show the total and a clear way to
   see all other actions. Never conceal additional urgent items behind the
   preview or reclassify clinical priority in the UI.
2. **Your measurements.** Compact summary with the relevant dates. Make a
   missing input and an old saved input distinguishable.
3. **Keep this plan.** Existing PDF/email action with the reminder disclosure.
   Offer cloud storage as an optional durability choice within this area,
   not as the first question on the results tab.
4. **Your reminder calendar.** What is due and when, with the schedule's
   freshness and an explanation of the selected delivery method.
5. **More guidance.** Expandable general nutrition, exercise, skin and
   supplement material. Preserve the current evidence and calibrated wording.

This is a presentation change, not a smaller clinical algorithm. All current
suggestions remain available. Do not automatically describe an empty urgent
list as an all-clear: missing information must remain visible.

For the initial empty state, show what the tool can produce and the next
input to enter. Example advice must be unmistakably an example.

Keep the full PDF useful for the doctor. A screen section being collapsed
must not silently remove its evidence or suggestions from the PDF. The
current getReportHtml clones the DOM and strips buttons; a redesign must
explicitly test expanded/collapsed content in the printed result. Either
keep that content in the print DOM or render the complete report from the
same results object. Do not create another source of clinical copy.

Acceptance examples:

- A fresh iPhone visitor sees an actual next action before a storage prompt.
- A person with several urgent suggestions sees every urgent suggestion.
- A returning visitor sees saved dates rather than placeholders that look
  like newly entered values.
- An incomplete profile never produces a reassuring completion claim.
- The PDF preserves all advice and citations in either expansion state.
- Keyboard focus, screen-reader headings and mobile tap targets work after
  reordering; screen-reader navigation matches the visible hierarchy.

Measure `next_steps_viewed`, `plan_exported` and reminder enrolment separately.
These would be new closed-enum events, with no suggestion names, diagnoses,
values or free text. Existing results_viewed is not a completed-plan count.
Use event aggregates as funnel indicators, not proof of benefit.

Release this phase alone. It is relatively small and changes no record
schema, provider behavior or server permissions.

## Phase 2: make schedule freshness understandable

Suggested stories: US-17, US-22, US-23 and US-24.

There are two existing reminder relationships and the UI should name them
accurately:

| Relationship | What is true today | Proposed explanation |
| --- | --- | --- |
| Cloud-connected with active reminder capability | The browser can push updated schedules. | Show the last confirmed schedule update and an error/retry state if that update fails. |
| Typed email capture | Capture supplies a snapshot; re-capture can refresh that typed row, but the browser is not given its management token. | Say the emailed schedule reflects the latest submission; offer a deliberate update flow rather than implying continuous sync. |

Use the server's existing updated_at for a persisted schedule timestamp
where authorized to read it; keep a confirmed-push timestamp locally for the
browser's status. A generic HTTP success from typed capture is deliberately
not proof of enrolment, so do not convert it into a false "reminders active"
claim. Preserve the constant-response and anti-enumeration behavior.

In each reminder email, state that it is based on a schedule last supplied
on a particular date. Provide a link to review the plan and retain the
calendar and unsubscribe options. The wording should not claim the server
knows a test remains outstanding.

On return, show the existing record when available. Ask for changes rather
than replaying the whole onboarding form: new results, screening dates,
medication changes, and any current inputs needed by the existing rules.
Confirm the newly computed schedule before replacing the old one.

If the record is missing on that device, explain that plainly. A reminder
email or calendar entry cannot restore the medical record. Offer the existing
cloud connection or a short reassessment; never invent values from the
reminder labels.

Acceptance examples:

- Failed schedule updates retain the previous confirmed timestamp.
- A typed user can find a deliberate way to submit an updated schedule.
- Neither an email open nor its link click changes a schedule.
- Old emails remain understandable after a person has completed a check.
- The reminder service still works independently of marketing subscription.

Measure attempted/successful schedule refresh using closed events. Separate
those from initial enrolment and email clicks. Do not add recipient IDs to
analytics simply to make the funnel convenient.

## Phase 3: close the loop on action, carefully

Suggested stories: US-06, US-17, US-23 and US-26.

Start in the app, where the record and current algorithm are already
available. A due item offers "Update this check-up" and opens its existing
screening or measurement entry surface.

An appointment being booked is not a test being completed. A test being
completed is not evidence of a normal result. Do not turn a single "Done"
button into a fabricated screening result or automatically calculate the
next interval from an assumed normal result.

Use a small explicit choice where relevant:

- **I have new results:** open the existing entry/import path.
- **The check-up happened:** collect the date and required result/follow-up
  information through the existing screening form; allow unknown/awaiting
  where the current model supports it.
- **I want to review this with my doctor:** keep the action visible and
  offer the existing summary/calendar affordance.

Only then recompute the reminder schedule with the existing clinical engine.
Persist clinical information in the user's file. The server continues to
receive only the allowed schedule, not the result, reason or medication.
Do not broaden the data model just to ship this phase.

A richer email-management path is optional and later. It would require
authenticated access to the recipient's calendar. Knowing an email address
is not permission to read it. Reuse an appropriately scoped capability or
a verified email-link flow after a separate security review. Do not repurpose
an unsubscribe URL into an implicit clinical write.

For that later path, a GET opens a review screen and an explicit POST applies
the chosen change. This prevents link scanners from marking something done.
Keep capability material out of logs/referrers and do not add arbitrary
redirects. Changes to the allowed reminder data or authority need their own
story and review; they are not hidden inside a visual redesign.

Measure successful local updates and schedule refreshes. Optional user
research can establish whether a reminder led to a useful action. Do not
equate a new date or a clicked link with a confirmed health outcome.

## Validation and investment decisions

Observe a small initial group of independent, target-age users completing
the core journey on their own phones. Record where they hesitate, what they
think has been saved, and what they believe the email service knows. A first
group of five to eight can reveal comprehension problems; it cannot establish
population conversion rates or long-term health benefit.

Release the phases separately. For each, require mapped unit/integration
tests, a real WebKit journey and post-release checks. Follow long enough for
due reminders to occur before judging recall value. Agree the evaluation
window and spending limit before starting a mobile app or more connectors.

## Sentry bundle filter: explanation and proposed fix

The filter asks, effectively, "does this error's stack come from one of our
recognized scripts?" It was intended to discard errors from unrelated
Shopify apps. It still recognizes the old health-tool.js filename, while the
main app now ships as health-plan-v2.js. An error can happen correctly,
reach Sentry's SDK, and be discarded before delivery.

Update the allowed patterns to the current first-party bundle names and lazy
chunks, accounting for the upload, site-chat and separate chatbot surfaces.
Keep the known-origin restriction for Pages. Do not allow every script on
the Shopify CDN, which would restore the noise the filter was built to stop.

Use the installed SDK filter in tests with representative production URLs:
current main/chunks accepted, third-party scripts rejected, Pages accepted,
unrelated rehosts rejected where the origin restriction applies. After
deployment, send a deliberate value-free test event from each surface and
confirm receipt. This fix is proposed here, not part of the authorized code
changes in this follow-up.

## Drive concurrency: explanation and options

Suppose the record starts at revision 10:

1. Browser A and assistant B both read revision 10.
2. A adds a result, writes, reads it back and reports success.
3. B writes its own copy based on revision 10. A's result was never in B's
   copy, so the overwrite removes it remotely.
4. B reads back its own copy and also reports success.

Even if both checked revision 10 before their writes, that ordering remains
possible. Dropbox's conditional update can reject B at the write itself;
the current Drive implementation has no equivalent atomic precondition.
The browser is weaker again: its write ignores expectedVersion entirely.

Recommended first step: share the hosted Drive version-check behavior with
the browser, preserve bounded re-read/merge/retry, and add deterministic
multi-writer tests including corrections, erasure and scalar/profile edits.
Read-back checks should cover more than row presence: an existing row ID does
not prove a profile or screening value was preserved. Distinguish an intended
newer edit winning from an accidental stale overwrite.

That improves detection; it cannot promise atomicity. If simultaneous writes
become a core requirement, evaluate a protocol with independently durable
operations (unique per-operation files plus a merged view), or an enforced
single-writer/coordinator design. Either is a larger architecture decision.
A local durable pending journal can improve recovery, but is not itself a
global lock. No Drive rewrite is included in this follow-up.

## Medication chart annotations

An annotation would place a marker such as "statin dose changed" on the
measurement chart, helping the user compare timing with their results.
The chart still builds these markers, but RoadmapStore.loadMedicationHistory
returns an empty array. The current local history shape lacks the complete
changeType projection the chart expects; fabricating it would mislabel stops.

The choice is to implement a truthful adapter over recorded medication
history, with tests for starts/stops/dose changes, or remove the unreachable
annotation UI and its dependency if no other caller needs it. It is not a
reason to discard the stored history. Nor would a marker prove causation.
Given the current priorities, I would defer implementation and consider
removing the inactive display code after checking consumers. No annotation
behavior was changed in this follow-up.

## Refactoring components around state ownership

Splitting a 2,000-line file into four 500-line files does little if all four
still receive the same state and callbacks.

Instead, identify which part controls each piece of state. An import review
owns its selected rows, edited values, dates, conflicts, save progress and
retry state. The main health record owns committed values. Saving is the
boundary between them. A profile form owns temporary inputs while the store
owns persisted demographics.

Extract a component or hook when it can own that coherent responsibility and
expose a small interface. For example, the parent should open/close review
and receive its committed outcome; it should not coordinate every review
cell. Keep cross-device merge rules in health-core and persistence in the
store. Do not move either into a React hook to make a file shorter.

Use existing failure cases to judge the refactor: unsaved drafts survive
errors, a remote edit does not overwrite typing, duplicate saves do not
duplicate records, and callbacks cannot race two competing sources of truth.
This is a later refactor, not part of the current cleanup.

## Historical design documents

Yes: obsolete implementation guides are good deletion candidates. Git keeps
their full history. Keeping them labelled "implemented" beside current docs
can mislead a future developer or agent into restoring the wrong design.

The downside of blind deletion is losing discoverable rationale, incident
evidence and links from current instructions. Git history is available, but
someone must know what to search for.

Before deleting a candidate such as health-documents.md, extract only the
still-relevant decisions and operational lessons into the current subsystem
reference, check inbound links, update them, then delete the obsolete guide.
Keep a short history pointer if its name is widely referenced. Do not keep a
second full copy in an archive unless something actually depends on it.
Clinical source documents and citation masters are not obsolete designs and
must not be included in this cleanup. No historical guides were deleted here.

## Conversation anonymity

Removing direct account identifiers reduces identifiability. The body can
still contain "my name is ...", an address, a copied report header or medical
details. Stable random conversation/profile IDs also group messages without
making the free text anonymous. Whether to keep those conversations is a
separate product decision from whether to send them to error monitoring.

This follow-up preserves conversation storage and retention. It removes
free-text context from chat-failure telemetry. If the intended promise is
"we do not host your health record", say that precisely rather than relying
on "operational" to mean that stored messages cannot contain health content.
