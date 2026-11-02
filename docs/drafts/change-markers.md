# Change markers on the charts: the full plan (draft, 2026-11-02, revision 2)

Planning only. Nothing here is built. Brad raised the idea on 2026-11-02: when someone
starts something new (more protein, a new exercise routine, a diet change), they note it,
and the metric charts mark that date, so they can see whether the numbers moved.

**Revision 2** folds in Brad's answers to revision 1 (same day) and turns the plan into
phases with full stories. Revision 1 was reviewed by a fresh adversary and Codex
(gpt-6.1-sol); their findings are kept below. Revision 2 had the one fix-scoped re-check
(a fresh adversary and Codex, 2026-11-02); its findings are folded in. That closes the
review rounds: what remains is Brad's.

## 0. Brad's decisions so far, and what I make of them

| # | Brad (2026-11-02) | What the plan now does | Where I push back |
| --- | --- | --- | --- |
| D1 | Blood tests do respond: exercise and better eating change HbA1c and cholesterol. | Agreed; revision 1 was wrong to call blood tests a weak case. Markers draw on every blood-test chart. | Only the narrower point stays: one result after a change is noisy, and a second result is what shows a trend (section 1). |
| D2 | We have steps and VO2 max, so put in automatic markers. | Phase 4: the iPhone spots a sustained change in steps and offers it as a marker. | Steps are behaviour; VO2 max and resting heart rate are outcomes, like LDL. Outcomes get markers; they should not create them. And a fully automatic marker would fire on a holiday, an illness or a phone left in a drawer. I recommend "suggest, then the person confirms" (F3). |
| D3 | The risk is getting the markers wrong. Changes made within two or three months of each other, a statin included, become one marker that lists them all. | Section 3: **one marker per period.** Changes within 90 days of a period's first change join it. Medication changes join the same periods. | Agreed: grouping shows the person that several things changed at once, which is the confounding problem made visible. It does not cure regression to the mean, so I still suggest one quiet caption (F5). Grouping also replaces the approved rule that each medication change has its own pin (US-06 AC4), so I ask you to confirm that (F2). |
| D4 | Check the medication marker counter first: yes. | Phase 0, its own small story. | None. |
| D5 | Chat and assistants: good, needs a proper story. | Phases 1 and 5, each with a story below. | None. |
| D6 | Every chart, but tasteful, without clutter. | Section 3 sets the look: one neutral marker style, no words on the chart, grouping keeps the count low. | None. |
| D7 | Schema bump: yes. | Phase 2. | The version number still clashes with the one-blood-table plan (F6). |
| D8 | The iPhone chat must edit the record ("my blood pressure is now XYZ"). | Phase 1, a story of its own: the iPhone chat can change everything the web chat can. It ships before markers and does not wait for them. | Agreed, and it is worth more than markers on its own, so it goes first (F7). It is more than switching the web's tools on: the web saves a medication change at once with Undo but pre-fills values for review, and the phone needs its own unit, blood-pressure and batch handling (section 6, F11). |

Still open from revision 1, and asked again in section 8: the start date (F8), the caption
(F5), what Remove deletes (F9) and the success bar (F10). New from the re-check: F11 to F13.

### Brad's answers to section 8 (2026-11-02, the same day)

Every question below is answered; this list overrides anything else in the draft.

- **F1** yes: phases 0 and 1 started at once, in parallel, each in its own session.
- **F2** one marker per period, plus a pill dot at each medication change's own day.
- **F3** suggest, then the person taps Add. **F4** as proposed: steps only, both
  directions, "Walking more" and "Walking less", tuned after a month on TestFlight.
  **F4b** no step count in the record.
- **F5** keep the caption: "Markers show when things changed. Results vary from test to
  test, so look for a trend over several results."
- **F6** one ladder in ship order: one-blood-table takes schema 3, change notes 4, and the
  version-4 build reads and merges version 3 too.
- **F7** phase 1 before the markers.
- **F8** a note carries the person's own start day; medications keep the day the change was
  recorded (US-06 AC4).
- **F9** Remove hides the words from every reader; they stay in the file until "Delete all
  my data".
- **Phase 0 result (PR #575):** the medication counter works; eight weeks of zeros means almost nobody reached a marker. A view needs a desktop visitor (the web's phone layout has shown no markers since US-62), a recent medication change, a mapped value and a click on its history. US-68 therefore needs markers on the web's phone layout and a `history_opened` denominator.
- **F10** set aside for now. The usage events are still built; the success bar is decided
  later.
- **F11** copy the web: a medication edit saves at once with Undo, values and height wait for
  Save. "Ideally, we want to share as much code as possible between the web and iOS", so
  parsing, unit conversion, batching and the write rules live in health-core and the engine,
  and Swift only decodes and draws.
- **F12** go ahead: reword the permission text and the App Store privacy answers.
- **F13** anchor periods at 90 days from their first change.

The stories are in `docs/user-stories.md`: Story 0 as US-06 AC4b, Story A as **US-67** (landing with its build, PR #573),
Story B as **US-68**, Story C as **US-69** (US-66 is claimed by two open drafts).

## 1. Why build it

- **People who measure often.** Weight, waist and home blood pressure show a trend within
  weeks. On the iPhone, steps, sleep and resting heart rate (US-56) move fastest of all.
- **People who recheck blood tests.** Diet and exercise do move LDL and HbA1c (D1). Someone
  who changed their eating after a high LDL and rechecks in two or three months gets the
  answer to "what was I doing between these two tests?", which memory does badly.
- **Retention.** The plan tells people what to change. A marker closes the loop ("you
  started this on 12 October") and gives a reason to come back with the next reading.
  Plausible, not proven.
- **The chat and assistants.** A dated list of what the person changed is context the
  chatbot lacks today.

The evidence is consistent with this helping a little. Self-monitoring of behaviour and
outcomes is a standard behaviour-change technique; a meta-regression of healthy-eating and
physical-activity interventions (Michie et al., Health Psychology, 2009) found
self-monitoring combined with another self-regulation technique (goals, feedback) went with
larger effects. A dated note is a lighter thing than that ongoing monitoring, so this is
support, not proof.

### What still misleads, and what the design does about each

1. **Test-to-test variation.** Results move with nothing changed: within-person variation
   is roughly 1 to 3% for HbA1c, 5 to 10% for LDL and 20% or more for triglycerides
   (approximate; check against the EFLM biological variation database before any of it
   reaches users). *Design:* no before/after number anywhere; the person sees the dots.
2. **Regression to the mean.** People change things after a bad result, and the next result
   tends back toward their usual value whatever they did. *Design:* the caption (F5). No
   marker style can fix this one.
3. **Several changes at once.** A statin and a diet change in the same month. *Design:*
   grouping (D3) puts them in one marker, so the chart cannot credit one alone.
4. **Timing.** LDL responds to diet within a few weeks; HbA1c reflects roughly the previous
   two to three months. *Design:* none in this plan. A "recheck in 8 to 12 weeks" nudge
   would be clinical timing advice for the algorithm doc, a separate decision.

### Our own data, a warning

The medication markers already on the web's charts (US-06 AC4) have logged **zero**
`medication_history_viewed` events in eight weeks. Product-health W43 and W44 mark the
counter Suspect. We cannot tell whether people never open those charts or the counter is
broken. Phase 0 settles it first (D4), because the new marker counter would copy the same
pattern.

We also cannot count how many people have three or more readings of a metric: the data is
local-first and never reaches the server. I don't know that number, and it decides much of
the value.

## 2. The phases

| Phase | What | Depends on | Ships to |
| --- | --- | --- | --- |
| 0 | Prove or fix the medication marker counter | nothing | web |
| 1 | The iPhone chat proposes record edits (values, medicines, profile) | nothing | server + iPhone binary |
| 2 | The `changes` array and the schema bump, readers first | the version ladder (F6) | health-core, iPhone binary first, then web |
| 3 | Noting changes, grouped markers on every chart, both clients | 2 | web + iPhone |
| 4 | The iPhone suggests a change from Apple Health steps | 3 | iPhone |
| 5 | Chat and assistants note changes | 1 and 3 | server, web, iPhone, MCP, CLI |

Phases 0 and 1 can run now and in parallel. Phase 2's iPhone binary gets its own
TestFlight build: riding phase 1's would make phase 1 wait on F6 and on phase 2's merge
review.

## 3. How the markers work (phase 3)

### One marker per period (D3)

For each chart, the app collects the events that chart shows:

- every change the person noted, and its end if they ended it (on every chart, D6);
- every recorded medication change the existing map puts on that metric (a statin on LDL,
  ApoB and total cholesterol; a GLP-1 on HbA1c, weight and triglycerides; and so on, as
  `medication-annotations.ts` has it today);
- every confirmed Apple Health suggestion (phase 4).

It sorts them by date and groups them: a period opens at its first event, and every event
within 90 days of that first event joins it. The next event after that opens a new period.
Anchoring on the first event (rather than chaining each event to the last) keeps a run of
changes a few weeks apart from becoming one year-long period. You said "within two or three
months of each other"; chaining would match those words more closely, so this is F13.

Exactly, so web and phone always agree: each event becomes a **local calendar day** (a
note's own day; a medication change's recorded instant on the reader's local day, as
`recordedTime` already places it). An event joins a period when its day is at most 90
calendar days after the period's first day, inclusive. Same-day events sort medication
first, then note, then by id. Daylight saving cannot move an event across the boundary,
because the count is in days, not milliseconds. Two devices in different time zones can
still place a medication change on different days, as today's pins already do; at a
period's edge that can change the count, which the story accepts.

So the LDL chart of someone who started atorvastatin on 10 September, noted "more walking" on
1 October and "cut saturated fat" on 20 October shows **one** marker, on 10 September,
reading "3 changes". The weight chart of the same person shows one marker of 2 changes (the
statin is not mapped to weight).

**The case grouping gets wrong (F2):** "more walking" on 1 July, an LDL test on 20 August,
a statin on 25 September, another LDL test on 20 October. All three events share one
period, so the only rule sits on 1 July, and the fall after the statin looks like the
period's work, walking included. That is the misattribution grouping was meant to stop.
The fix proposed: a medication change inside a period also draws a small pill dot on the
axis at its own day (no rule, no label), so a test before and after the statin reads at a
glance. Brad decides (F2).

### The look (D6: tasteful, no clutter)

- **One marker style for every kind**, medication or lifestyle: a thin dashed rule in a
  neutral tint on the period's first day, with a small round tab at the top holding the
  count ("3"), or a dot for a single change. No words on the chart. This replaces the
  medication-only indigo rule.
- **A period that spans weeks** gets a faint tick on the axis at its last event, nothing
  more. Revision 1's shaded bands are dropped: with grouping they made the chart busy, and an
  ended change is now its own event ("Stopped: low-carb diet").
- **Tap or select** the tab, or its entry in the list: a small callout lists the period's
  changes with their dates, and the rule darkens. A scrub along the chart still picks only
  values.
- **The list below the chart** shows one entry per period: "10 Sep to 20 Oct · Recorded
  start: Atorvastatin 10mg; you noted: more walking, cut saturated fat". It expands to the
  dated items.
- **Density.** With 90-day periods a five-year chart holds at most about 20, and real
  records far fewer. If the visible range would draw more than six, the oldest merge into a
  single "+N earlier" tab at the left edge, still listed below. The periods are the same on
  both clients; the fold depends on the range shown, so a web chart and a phone chart on
  different ranges may fold differently.
- **The range** reaches the newest marker, as it does for medications now.
- **Words.** "You noted: started more walking" for a note; "Recorded start: Atorvastatin
  10mg" for a medication, as now (US-06 AC4). The note's day is the person's claim (F8); the
  medication's is the day it was recorded.

### Where a change is noted

One sheet, three ways in:

1. **The plan card (Brad's idea).** The lifestyle cards only: `protein-target`, `exercise`,
   `fiber`, `lipid-diet`, `low-salt`, `high-potassium`, `trig-nutrition`, `sleep`, and
   `reduce-alcohol` while it shows. A quiet "I've started this" link at the card's foot opens
   the sheet with the title filled from the card and today's date. Afterwards the card says
   "Started 12 Oct". Not on medication, screening or supplement cards: those have their own
   start records.
2. **The metric page.** "Note a change" under the chart's list, for changes no card covers.
3. **The chat** (phase 5).

The sheet holds a title, a category, "Started" (default today, never later, at most a year
back) and Save. Tapping a change in a list opens it with Edit, "I've stopped" and Remove.
A short "Changes you noted" list at the foot of My data, on both clients, finds changes
that no chart shows yet.

### Both clients, one rule

The grouping, the words and the medication map live in one health-core projection
(`changeMarkers(file, metric)`), beside `medication-annotations.ts`, which it absorbs. The
web's `HistoryPanel` imports it; the iPhone engine serves it on `historyJson` as a new
`periods` field, so an over-the-air engine can change it. Today's `markers` field stays
beside it until every binary built before phase 3 has aged out: an older binary reads only
`markers`, and an engine that dropped it would take the medication markers away from that
binary (the engine contract rule, ios/architecture.md: what an older app cannot do without
stays in the contract). US-06 AC4a (select without redraw) carries over, and the tests that
pin today's shape (`my-data-local-day.test.ts`, `FormEditTests.swift`) change with it. The iPhone's Apple Health pages
draw their own charts (`LiveMetricPage.swift`, `SleepPage.swift`) and need a new engine
field for the change list; the web has no such pages, so that is the one place the clients
differ, by data, not by design.

### Accessibility and masking

- Screen readers read the list, not the rules (as US-25 AC9b does now): "Period 1, 10
  September to 20 October, 3 changes: recorded start, atorvastatin 10 milligrams; you noted,
  more walking; you noted, cut saturated fat".
- The marker never relies on colour: the count and the list carry it.
- Reduced motion: no draw-in (US-06 AC4a). Controls meet 44 pt on the phone and are
  keyboard-reachable on the web.
- The sheet, lists, callouts and tab labels show the person's own words. Every new web
  surface carries `data-clarity-mask="true"`, with a case in `clarity-masking.test.tsx`
  (portalled panels escape the tool root's mask). On the iPhone the window is already
  masked (D9) and the text field carries `analyticsMasked()`.

## 4. The record (phase 2)

### The shape

One new append-only array in `RoadmapFile`, `changes`:

```ts
/** A change the person noted (story B). Append-only; edits are corrections. */
export interface FileChange {
  id: string;
  /** Closed list; picks the icon and links to a plan card. */
  category: 'nutrition' | 'protein' | 'exercise' | 'sleep' | 'alcohol' | 'weight' | 'other';
  /** The person's words, trimmed, at most 80 characters. */
  title: string;
  /** YYYY-MM-DD: the day the person says they started. Their claim, not the write time. */
  startedOn: string;
  /** YYYY-MM-DD, or null while it is ongoing. Never before startedOn. */
  endedOn: string | null;
  /** The plan card it was noted from, e.g. 'protein-target'; null otherwise. */
  suggestionId: string | null;
  source: 'manual' | 'chat' | 'agent' | 'apple-health';
  createdAt: string;            // ISO instant of this row's write
  status: 'active' | 'entered-in-error';
  correctsId: string | null;    // the row this one replaces
  /** Set on the row a removal appends: the change is gone from every chart. */
  removed?: true;
}
```

Not `medicationHistory` or `supplementHistory` (they are keyed by drug or product and drive
the cascade) and not the profile (one current answer, where a person has many changes over
years).

### Create, edit, end, remove

Every write appends; no row changes in place (the FHIR rule the record already follows).

| Action | What is written |
| --- | --- |
| Note a change | a new row, `correctsId: null` |
| Edit (title, dates, category) | a new row with `correctsId` = the current row; the old row flips to `entered-in-error` |
| End ("I've stopped") | the same as an edit, with `endedOn` set |
| Restart | a new change; the old one keeps its end |
| Remove | a successor row with `removed: true`; the old row flips. Nothing shows. |

### Merge across devices

- Union by id through `unionRows` (an id reused with different content is quarantined);
  `status` monotonic as in `unionSlotRows`.
- **One active row per chain** (a row and every row correcting it, followed to its root).
  Two offline edits of one change leave two heads; the merge keeps the newer by `createdAt`
  read as an instant (`stampInstant`), then by id, and flips the other. A `removed` head
  shows nothing. This is clock-based like the medications' last-write-wins: a fast clock can
  beat a removal made later in real time. `laterStamp`'s skew guard stamps every write.
- **Cycle-safe roots.** `correctsId` is never verified (merge.ts header). Root resolution
  keeps a visited set and a depth cap; a row in a cycle is its own root, so a hand edit can
  never hang a save.
- **Orphans** (a `correctsId` naming a row not in the file) are their own root. After an
  erase, a stale device's edit of an erased change is rescued and comes back edited: the
  same residual measurements accept for a value typed after an erase.
- **Retries.** No natural slot, and no dedup on free text. The writer makes the id once,
  before any retry (the sheet when it opens, the chat banner when it shows, an agent tool
  from a caller's `requestId`), so a double Save or a retried call folds into one row.
- **Erase.** `changes` joins `ROW_STAMPS` and `CREATED_STAMPS`, so "Delete all my data" lists
  and drops them and the post-erase rescue works (US-09 AC20, AC23).
- **US-65.** An unknown `category` reads as `other`; a broken date makes the row unreadable
  and hidden.

### The schema bump (D7) and the old-build trap

An older build keeps unknown top-level fields on read, but its merge overwrites them: on
equal epochs `...remote, ...local` makes its own copy of `changes` win whole, and the erase
gate takes the winner's copy whole. A note made on the web would vanish the next time a
stale build saved. Stale writers: iPhone builds 3 and 4 (no over-the-air engines), an
un-updated stdio MCP or CLI, a self-hosted Pages fork, a tab left open across a deploy.

The fix follows the `erasedRows` precedent (US-09 AC23): stamp a new `schemaVersion` only on
files that hold a change row, so an older build refuses exactly the files it would damage.
Three conditions:

1. **The number** (F6): the one-blood-table plan (PR #551, its own proposed US-66) already
   claims 3. Two meanings for one number reopen the trap. And separate numbers are not
   enough on their own: `migrate.ts` accepts every version at or below its own, so a build
   that knows version 4 accepts a version-3 file. **Each version's reader must support every
   lower version.** So the numbers go in ship order, and the feature that ships second
   carries the first one's reading and merging too.
2. **Erase gets its own constant.** `CURRENT_SCHEMA_VERSION` doubles as the erase list's
   version today (`migrate.ts:327`, `merge.ts:753`, `erase.ts:74`); bumped as is, every
   erased file would jump to the new version with no change in it. The erase list keeps 2.
3. **The lockout is total.** `migrate.ts` refuses a too-new file on read (US-65 AC5), so a
   stale build cannot even show the record. Hence the order: the iPhone binary that reads
   the new version ships through TestFlight first (iOS D3: an over-the-air engine may not
   change the schema), and no client writes a change until it is out. Brad's phone holds real
   data since 2026-11-02, so this order protects his record too.

### Every hard-coded array list

Each needs `changes` and a test: `merge.ts` `ROW_STAMPS`/`CREATED_STAMPS`; `roadmap-doc.ts`
`ROW_ARRAYS` (the shape gate) and `rowIds` (verify-after-write); `readable-rows.ts` `ROWS`;
`migrate.ts` `recoveredClock`; `mcp-tools.ts` `readRecordOutput` and `RECORD_SECTIONS`
(US-32 AC41); `docs/health-roadmap-file.schema.json` and `docs/agent-access.md`;
`roadmap-data.ts`/`RoadmapStore` and the iPhone engine's edit entry.

### Removal and the person's words

A removed note's title stays in the file until "Delete all my data", as a deleted
measurement's value does. Whatever F9 decides: removed chains and superseded titles never
reach `read_record`, the chat context or the readable view, and the Remove confirm says
"Removed from your charts. Delete all my data erases it from your record file."

Merge, FHIR and the agent contract all change here: the orchestrator decides, a fresh
adversary and Codex review before commit, and `merge.test.ts` covers two devices,
concurrent edit, edit against remove, a cycle, an orphan after each kind of erase, a retried
id, and old-build refusal.

## 5. Apple Health suggests a change (phase 4, iPhone only)

**What triggers it: steps, and only steps, in v1.** Steps measure what the person does.
VO2 max and resting heart rate measure what it did to them; they are outcomes, like LDL, so
they get markers on their pages and never create one (D2). Sleep duration is behaviour too,
but nights vary more and "I slept more" is rarely a deliberate change; leave it for v2.

**The rule (thresholds for Brad, F4):** on app open, compare the average daily steps over
the last 28 days (at least 21 days with data) with the 90 days before. A rise or fall of at
least 25% and at least 1,500 steps a day is a candidate. Its start day is the first day of
the first week whose average crossed halfway to the new level. At most one suggestion per
90 days, and none within 90 days of a change the person noted in the exercise category.

**What the person sees:** a card at the top of the steps page and in My data's Fitness
section: "Your steps rose to about 8,900 a day since 3 September. Add it to your charts?"
(or "fell to about 5,100") with Add, Not now and Don't suggest this. Add writes a normal
change (`source: 'apple-health'`, category exercise) that the person can edit or remove like
any other. Its title follows the direction: "Walking more (from Apple Health)" or "Walking
less (from Apple Health)". A fall is worth marking too: an injury or a new job often explains
the next results.

**Why suggest and not just draw it (F3):** a step count also jumps on a holiday, falls in an
illness, drops when the phone sits in a drawer, and shifts with a new watch. An automatic
marker would draw every one of those on every chart, the clutter D6 rules out. A confirmed
one is the person's own statement, and it syncs to the web like any note, so both clients
show it.

**What enters the record (F4b, F12):** US-56 promises that Apple Health's steps stay on the
phone. A confirmed change breaks part of that even with no number in it: its direction
("walking more"), a start day computed from step data and `source: 'apple-health'` are
Apple Health-derived facts, and they sync to the person's Drive or Dropbox and, in phase 5,
reach the chat. Keeping the step count out (F4b) limits it; it does not keep the promise.
What changes if Brad goes ahead:

- US-56 AC1 ("no chat summary, export or merge can see them") and AC3 ("the website, the
  CLI, the MCP and the chatbot never see these metrics") gain an exception: a change the
  person confirmed.
- AC10's purpose string ("keeps only on this iPhone, never in your record") becomes false at
  the first Add, so it is reworded, for example "…which it shows you and keeps on this
  iPhone. If you choose, a change it notices can be added to your record."
- AC11's App Review position and the App Store privacy answers ("never collected") are
  redone. Data derived from HealthKit going to the person's own cloud and, in phase 5, to the
  chat server is a guideline 5.1.3 question to answer in the review notes before the build is
  submitted.

**Where the suggestion's own state lives:** "Not now", "Don't suggest this" and the
90-day clock cannot go in UserDefaults (US-56 AC2 forbids it) or in the kept-cards file,
which is deleted by an empty read, an access reset and an erase, so a "no" would come back.
They go in a small phone-only file of their own (`suggestion-state.json` beside the kept
cards: a version, the last suggestion's day, and a dismissed flag; no step value). An access
reset leaves it; "Delete all my data" deletes it. Story C amends US-56 AC2 to name it.

## 6. Chat and assistants

### Phase 1: the iPhone chat edits the record (D8)

Today the iPhone chat proposes nothing (US-52 AC5: "No form edits are proposed to the app").
The server turns the form tools off for app requests (`api.chat.ts`: `canApplyEdits` needs
`!app`), `ChatClient.swift` advertises no capability and `ChatModels.swift` decodes no
proposals. Phase 1 brings the web's three form tools to the phone: `propose_field_edit`
(values: "my blood pressure is 128/82"), `propose_medication_edit` and
`propose_profile_edit`.

**They do not behave the same on the web, and the phone must choose (F11).** On the web a
value is pre-filled into its cell for the person to review and save; a profile edit gets a
Save banner; a medication edit **saves at once**, with Undo. The tool text tells the model
so ("Medications save immediately… tell the user… they can undo it"), and the server's
tool-only reply says "Done — I've updated your medications". Copy that to a phone that waits
for Save, and the chat says the statin is saved when it is not. Options:

- **Copy the web (recommended):** a medication edit saves at once with an Undo banner;
  values and the profile show in a banner with Save and Not now (the phone has no cells to
  pre-fill, so the banner is its review step). The field tool's text and its tool-only reply
  get app wording ("I've put that ready to save"), chosen by the server from the capability.
- **Save first for everything:** one rule on the phone, but the medication tool text and
  reply need an app variant too, and the phone then differs from the web.

**The server side:**
- The app sends a capability (`edits: 1`); only then does the server offer the tools, so an
  older app never gets a proposal it cannot show (the US-16 AC2 pattern). App requests still
  store nothing (US-52 AC5, D9). App Attest is unaffected: the field rides in the signed body.
- The same gate (`canApplyEdits`) also turns on `run_roadmap`, the plan tool, when a recent
  message holds a digit. That is wanted (the phone's chat can then say what a new value does
  to the plan), but the server reads the person's inputs from `guestInputs`, which the app
  does not send today. The phone sends them from its record.
- The server already parses the tool calls (`parseProposedEdits`) and writes the "Not
  applied" result itself. The app receives `proposedEdits` already parsed; the engine
  re-checks them at the boundary, as any input from the network.
- Story A amends US-52 AC5 and US-15 AC19 ("the form tools go only where a client applies
  them").

**The phone side: one new engine entry, not `applyEditJson` per edit.** The engine's `add`
reads a value in the unit the row shows; a proposal carries the unit the person said. So
"LDL 130 mg/dL" on a phone set to mmol/L would store 130 mmol/L, or be refused. The new
entry (`applyChatEditsJson`) takes the parsed proposals and:
- converts each value from its stated unit, Lp(a)'s three units included (US-05 AC2);
- joins a systolic and a diastolic into one blood-pressure pair (`PressureEdit`): both or
  neither, never half;
- applies one Save's edits as one write, all or none, as the web batches same-day edits;
- turns a held day into the correction the phone already offers when typing;
- takes height in centimetres, as the parser returns it.

**Erase:** a banner made before an erase dies with it, and the medication Undo with it (the
US-16 AC2a rule).

### Phase 5: chat and assistants note changes

- **Chat:** a fourth form tool, `propose_change_note` {title, category, startedOn}, on the web
  and, through phase 1's capability (`edits: 2`), the iPhone. "I started eating 30 g more
  protein last week" becomes "Note a change: more protein, started 26 Oct?" with Save and Not
  now. The parser refuses a day in the future (by `latestDayOnEarth`, US-31 AC6) or more than
  a year back. The banner makes the row's id when it shows.
- **Chat context:** the widget's chat and the iPhone chat see the current head of each open
  or recently ended change. The blog bubble and the chatbot embed do not (US-15 AC10 lists
  what they send, and they keep transcripts). The chatbot never tells a person a change
  worked from one result; that rule goes in the knowledge pipeline in claude_business.
- **Assistants (MCP and CLI):** `read_record` returns the live changes; two write tools,
  `note_change` {title, category, startedOn, requestId} and `end_change` {id, endedOn},
  through `SyncManager` (merge on conflict, verify after write); the CLI's `note-change`.
  Edit and remove stay in the apps. An agent-contract change: adversary plus Codex.

## 7. Measurement and the stories

### Usage signals

- **Phase 0:** the existing `medication_history_viewed`, proven by one deliberate production
  view.
- **Phase 1:** iPhone Clarity words "Chat edit proposed" and "Chat edit saved" (a D9 list
  change). The save rate over the proposal rate says whether the proposals are right.
- **Phases 3 to 5, web `product_events` (Shopify only):** `change_noted` {`entry`:
  `plan_card` | `metric_page` | `chat` | `agent`} and `change_marker_viewed` (name only, once
  per tab session, when a chart with a marker is on screen). Never a title, category, date
  or count.
- **iPhone Clarity words:** "Change noted", "Change marker seen", "Steps change suggested",
  "Steps change added".
- **Success, read 60 days after phase 3 (F10):** events carry a visitor id but no tab id, so
  count by visitor and day. Of visitors with `results_viewed` on two or more days, at least
  5% send `change_noted`, and half of those later send `change_marker_viewed`. Below 1%,
  remove the feature. On the iPhone, at least a third of steps suggestions added.

### Story drafts (proposals; ids assigned when they land, US-66 is taken)

> **Story 0 (US-06 AC4b) · The medication marker counter is proven (US-06 usage signal, Lane A)**
> - AC1: one deliberate production view of a chart with a recorded medication change sends
>   exactly one `medication_history_viewed`, seen in `product_events`.
> - AC2: if it does not, the emit is fixed with a failing test first (`HistoryPanel.test.tsx`
>   on a real store with a post-AC4 change), deployed, and the view repeated.
> - AC3: the product-health loop's Suspect flag is cleared, or the counter is reported broken
>   with its cause.

> **Story A (US-67) · The iPhone chat saves what I tell it, after I confirm (amends US-52 AC5)**
> As an iPhone user, when I tell the chat a value, a medicine or my height, it changes my
> record the way the website's chat does (US-16), and it never says it saved something it
> did not.
> - AC1 (capability): the app sends `edits: 1`; only then does the server offer
>   `propose_field_edit`, `propose_medication_edit`, `propose_profile_edit` and `run_roadmap`,
>   with the app's inputs in place of `guestInputs`. An app without it gets none, as today.
>   App requests still store nothing.
> - AC2 (one parser): the server parses and refuses as for the web, with the same "Not
>   applied" result; the engine re-checks what arrives.
> - AC3 (what saves when, per F11): a medication edit saves at once with Undo; values and the
>   profile show in a banner in my units, naming any value they replace, with Save and Not
>   now. The model's words match: it never says a value is saved before Save, and after Not
>   now nothing was written.
> - AC4 (write): Save writes through one engine entry: each value converted from its stated
>   unit (Lp(a)'s three included), a blood-pressure pair both or neither, one Save's edits all
>   or none, a held day turned into a correction, height in centimetres.
> - AC5 (erase): an erase on any device drops an unanswered banner and the Undo.
> - AC6 (signal): "Chat edit proposed" and "Chat edit saved", no value or field name.
> - Amends US-52 AC5 and US-15 AC19.
> - Gate check: a live write path and the chat server: adversary plus Codex. No clinical
>   change.

> **Story B (US-68) · I note a change and see it on my charts, grouped with my medicines**
> As someone following my plan, I note when I started a change, so my charts show what I was
> doing when my numbers moved, without the app saying what caused what.
> - AC1 (note): from a lifestyle plan card, a metric page or My data I note a change: title,
>   category, start day (default today, never later, at most a year back). The card then
>   shows "Started <date>". Web and iPhone alike.
> - AC2 (record): a row in `changes`, in my cloud file only; edit, end and remove append rows
>   and flip the replaced row; no row changes in place. A retried write is one row.
> - AC3 (merge): devices converge: one active row per chain, the newer write wins, a removal
>   is a write, a correction cycle cannot hang a save, an orphan is its own root. Erase removes
>   changes and they do not come back, except a stale device's edit made after the erase.
> - AC4 (schema): a file holding a change carries the version F6 settles and an older build
>   refuses it; a file without changes keeps its version, an erased one included. The iPhone
>   binary that reads it ships before any client writes one.
> - AC5 (periods): each chart groups the events it shows (my changes and their ends on every
>   chart; medication changes on their mapped metrics) into periods: a period opens at an
>   event's local day and takes every event up to 90 calendar days after it, inclusive;
>   same-day events sort medication, then note, then id. One marker per period, the count on
>   its tab; a medication change inside a period also gets its own small dot (per F2); more
>   than six in view fold the oldest into "+N earlier". Supersedes US-06 AC4's one pin per
>   medication change and US-25 AC9b's indigo rule; `historyJson` keeps `markers` for older
>   binaries beside the new `periods`.
> - AC6 (no verdict): nothing computes a before/after difference or says a change worked.
>   Charts with a marker show the approved caption (F5).
> - AC7 (removal): a removed change and every superseded title reach no chart, `read_record`,
>   chat context or readable view.
> - AC8 (access): screen readers read the list; nothing relies on colour; reduced motion
>   draws no animation; every web surface showing a note is Clarity-masked, with a test.
> - AC9 (chat and assistants, phase 5): the chat proposes a change and saves only on Save, on
>   the web and the iPhone; `read_record` returns live changes; `note_change` and
>   `end_change` write through `SyncManager`.
> - AC10 (signal): `change_noted` {entry}, `change_marker_viewed`; on the iPhone "Change
>   noted" and "Change marker seen". No title, category or date in any event, log or report.
> - Gate check: merge/FHIR, schema and agent contract: adversary plus Codex. The caption is
>   health wording Brad approves; if it cites evidence, the three-file sync.

> **Story C (US-69) · My iPhone notices when I start walking more, or less (amends US-56 AC1, AC2,
> AC3, AC10, AC11)**
> - AC1 (rule): a sustained change in daily steps by the thresholds F4 settles offers one
>   card on the steps page and in Fitness, at most once per 90 days, never within 90 days of
>   an exercise change I noted. The card and the saved title follow the direction ("Walking
>   more" or "Walking less").
> - AC2 (confirm): Add writes a change (`source: 'apple-health'`) I can edit or remove. Not
>   now, Don't suggest this and the 90-day clock live in the phone-only
>   `suggestion-state.json`, never in UserDefaults or the record; an access reset keeps it;
>   "Delete all my data" deletes it.
> - AC3 (no numbers in the record): the change's words carry no step count; the count shows
>   only on the card and is never stored. VO2 max, resting heart rate and sleep never create
>   a suggestion.
> - AC3a (the promise, per F12): the purpose string and the App Store privacy answers say a
>   change the person adds can go into their record; the review notes answer 5.1.3.
> - AC4 (markers on Apple Health pages): the steps, heart rate, VO2 max and sleep pages draw
>   the same period markers as the record's charts.
> - AC5 (signal): "Steps change suggested" and "Steps change added".
> - Gate check: a threshold shown to the person is close to clinical: Brad sets it; not a
>   three-file change unless it is presented as health advice.

### Cost (rough, production code)

Phase 0: under 20 lines, if anything is broken. Phase 1: about 300 (server gating, Swift
decoding and banner, engine glue). Phase 2: about 200 (type, migrate, merge with safe
chains, version stamp, the array lists). Phase 3: about 650 (projection with grouping, web
and iPhone marks, lists, sheet, card links). Phase 4: about 250 (detection, card, Apple
Health page markers). Phase 5: about 350 (chat tool on both clients, agent tools, CLI).
Deletion: the projection absorbs `medication-annotations.ts`'s marker half and HistoryPanel's
separate medication pin code, roughly 100 lines. This draft itself: docs only, net
production LOC 0, nothing deleted.

## 8. Questions for Brad

Each carries its own context.

- **F1. Start with phases 0 and 1 now, in parallel?** Phase 0 checks whether the medication
  marker counter works (you said yes). Phase 1 lets the iPhone chat save values after a
  Save tap (you said it must). Neither waits on the rest. Recommendation: start both now;
  phases 2 to 5 wait for F6 and your review of this plan.
- **F2. Medication changes join the grouped markers.** Today each medication change has its
  own indigo pin at its exact date (US-06 AC4, US-25 AC9b, both approved). Your one-marker
  rule (D3) puts "started statin" inside the same period marker as "more walking". The
  catch: when the statin comes late in a period (walking on 1 July, statin on 25 September),
  the only rule sits on 1 July, and an LDL fall after the statin looks like the walking's
  work. Options: one marker per period and nothing else (cleanest, but that case
  misleads); one marker per period plus a small pill dot on the axis at each medication's own
  day (one extra dot, the case reads right); or medications keep their own pins (two kinds
  of marker, the clutter you want to avoid). Recommendation: the period marker plus the
  dots.
- **F3. Apple Health markers: suggest or automatic?** You suggested automatic markers from
  steps and VO2 max. Options: automatic (no effort for the person, but holidays, illness,
  a phone in a drawer or a new watch all draw markers, and the web never sees them), or the
  phone suggests and the person taps Add (one tap, no false markers, syncs to the web).
  Recommendation: suggest, then confirm.
- **F4. What starts a suggestion.** Proposed: steps only, a 28-day average at least 25% and
  1,500 steps a day above or below the 90 days before, at most once per 90 days; a rise is
  saved as "Walking more", a fall as "Walking less". VO2 max and resting heart rate are
  results of exercise, so they show markers but never create them. Options: accept, change
  the numbers, rises only, or add sleep now. Recommendation: accept both directions; tune
  after a month on TestFlight.
- **F4b. The step count stays off the record.** US-56 promised the website and chatbot never
  see Apple Health's steps. Options: the saved change says "Walking more (from Apple
  Health)" with no number (keeps the promise), or it carries "about 8,900 a day" (more
  useful on the web, breaks the promise). Recommendation: no number.
- **F5. The caption.** Grouping handles several changes at once; it cannot handle the next
  result drifting back toward normal on its own (regression to the mean). Proposed, under
  any chart with a marker: "Markers show when things changed. Results vary from test to
  test, so look for a trend over several results." Options: this, your words, or none.
  Recommendation: a caption, in words you approve.
- **F6. One version ladder with the one-blood-table plan.** PR #551 (still open) claims
  schema 3 for core blood rows. If both use 3, a build that knows one feature reads a file
  holding the other without refusing it, and loses data. And because a reader accepts every
  version at or below its own, a build that knows 4 must also handle 3. Options: one ladder
  in ship order (whichever ships first takes 3; the second takes 4 and carries the first's
  reading and merging), or one combined bump shipped together. Recommendation: one ladder in
  ship order, each stamped only when its rows exist. One-blood-table is likely first, so
  change notes would be 4 and wait for it.
- **F7. Phase 1 first.** The iPhone chat editing the record is useful on day one for every
  user who chats; markers help those who measure often. Recommendation: phase 1 before
  phase 3, as the table has it.
- **F8. Which date a note carries** (open from revision 1). Medications use the day the
  change was recorded (US-06 AC4). For a note, the person's own start day ("I started last
  Monday") is the useful one. Options: their day, back-dated up to a year, labelled "You
  noted"; or the recorded day only. Recommendation: their day.
- **F9. Does Remove delete the words?** (open from revision 1). Rows are append-only, so a
  removed note's text stays in the file until "Delete all my data", hidden from every
  reader. Options: keep append-only and hidden (simple, merge-safe) or blank the words on
  removal like a deleted document (gone for real, a small merge special case).
  Recommendation: hidden now; revisit if people write sensitive things.
- **F10. The success bar** (open from revision 1). Proposed: 5% of returning web visitors note
  a change within 60 days, half of them later view a marker, a third of iPhone step
  suggestions added; below 1% noting, remove the feature. These are guesses. Recommendation:
  accept the 1% removal floor now.
- **F11. What the iPhone chat saves, and when.** On the web, the chat saves a medication
  change at once with Undo, but only pre-fills a value for the person to check and save.
  The phone has no cells to pre-fill. Options: copy the web (medications at once with Undo;
  values and height in a Save banner), or Save first for everything (one rule on the phone,
  different from the web). Either way the model's words are matched, so the chat never says
  "saved" before it is. Recommendation: copy the web, so the two chats behave the same.
- **F12. The Apple Health promise.** US-56 tells people, in the iPhone's permission text and
  the App Store privacy answers, that their Apple Health readings stay on the phone and never
  enter the record. A confirmed "Walking more" change is derived from those readings and
  goes into the record, the person's cloud and later the chat. Options: go ahead and reword
  the permission text and privacy answers (a change Apple reviews), or keep step suggestions
  out and let people note exercise changes themselves. Recommendation: go ahead; the person
  chooses each Add, and the words say so plainly.
- **F13. How periods are cut.** You said changes "within two or three months of each other"
  share a marker. Chaining (each change within 90 days of the last) matches those words, but
  changes every two months would chain into one marker for a year. Anchoring (within 90 days
  of the period's first change) caps a marker at three months. Options: anchor at 90 days,
  anchor at 60, or chain. Recommendation: anchor at 90 days.

## Out of scope

- Moving medication markers to a claimed start date.
- Supplements on the charts (they have start dates; a separate decision).
- "Recheck in 8 to 12 weeks" reminders after a change: clinical timing advice for the
  algorithm doc first.
- Any change to the plan or the suggestion rules: a noted change never alters the plan.
