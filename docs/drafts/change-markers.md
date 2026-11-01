# Lifestyle change markers on the charts: plan (draft, 2026-11-02)

Planning only. Nothing here is built. Raised by Brad on 2026-11-02: when someone starts
something new (more protein, a new exercise routine, a diet change), they note it, and the
metric charts show a marker on that date so they can see whether the numbers moved. Brad's
own words: "I don't actually know how this tracking would work... we need to thoroughly plan
this out, and if this is even a good idea in the first place or not."

Review: one fresh adversary and one Codex (gpt-6.1-sol) pass on 2026-11-02; every finding is
folded in below. The biggest: schema 3 is already claimed by the one-blood-table draft (Q8).

Short answer: worth building in a small, honest form, mostly for the measures people take
often (weight, waist, home blood pressure, and on the iPhone the Apple Health metrics).
Weak for blood tests, where most people have two or three results a year and one result
after a change says very little. The risk is not the marker. It is the conclusion a person
draws from it. The design below keeps the marker and refuses to draw the conclusion for them.

## 1. Is it worth building?

### Who benefits

- **People who measure often.** Weight, waist and home blood pressure can show a trend
  within weeks. A marker on "started walking 30 minutes a day" next to eight weekly weights
  is a fair picture. On the iPhone, steps, sleep and resting heart rate (US-56) move fastest
  of all, and they are the measures a lifestyle change most directly shows up in. Those
  pages are iPhone-only (Apple Health data never enters the record), so markers there have
  no web twin. See section 3.
- **People who recheck blood tests on purpose.** Someone who changed their diet after a
  high LDL and rechecks in two or three months. For them the marker answers "what was I
  doing between these two tests?", which memory does badly.
- **Brad's video audience.** The plan already tells people what to change. A marker closes
  the loop the plan opens ("you started this on 12 October") and gives the person a reason
  to come back and add the next reading. That is the retention case, and it is plausible,
  not proven.
- **The chat and agents.** A dated list of what the person changed is context the chatbot
  lacks today. "Your LDL fell after you started the oats in August" is only possible if the
  record knows about the oats.

Who does not benefit much: a person with one blood test a year. A marker between two
results a year apart, with five other things changed in between, tells them nothing.

### What the evidence says

Self-monitoring helps behaviour change. Self-monitoring of behaviour and of outcomes, and
feedback on outcomes, are standard behaviour-change techniques; a meta-regression of
healthy-eating and physical-activity interventions (Michie et al., Health Psychology, 2009)
found that self-monitoring combined with at least one other self-regulation technique was
associated with larger effects. That finding is about ongoing monitoring tied to goals and
feedback; a one-off dated note is a much lighter thing. So the evidence is consistent with a
marker helping a little, through the habit of recording, not proof that it will. It does not
support a chart that tells the person their change worked.

Reading one person's chart as an experiment misleads in four known ways:

1. **Biological and analytical variation.** A result moves from one test to the next with
   nothing changed. Within-person variation is roughly 1 to 3% for HbA1c, 5 to 10% for LDL
   and 20% or more for triglycerides (approximate; check against the EFLM biological
   variation database before any of this reaches users). The difference two results must
   show before it is likely real (the "reference change value") is larger again: for LDL,
   on the order of 20%; for triglycerides, more than 50%. A 10% drop in LDL after a diet
   change is inside the noise.
2. **Regression to the mean.** People change things after a bad result. The next result
   tends to be closer to their usual value whether or not the change did anything. This is
   the trap most likely to make a person credit a change that did nothing.
3. **Confounding.** People change several things at once, and other things change around
   them: weight, season, illness, a new medication, fasting or not, a different lab. A
   statin started the same month as more protein will make the protein look powerful.
4. **Timing.** LDL responds to a diet change within a few weeks, though one early result
   still carries all the noise in point 1. HbA1c reflects average glucose over roughly the
   previous two to three months, so an HbA1c a few weeks after a change measures mostly the
   time before it.

A proper n-of-1 trial deals with these by repeating the switch on and off, measuring many
times, and ideally blinding. A marker on a chart with three blood tests is none of that. It
is an observation, and the app must present it as one.

### The real harm

Over-reading in both directions:

- **False credit.** LDL drops after "more protein" because of regression to the mean or the
  statin, and the person stops the statin because "diet worked". This is the serious one.
- **False discouragement.** LDL rises 8% after a sensible diet change, inside the noise, and
  the person abandons a change that would have helped over a year.

Both are worse if the app computes a before/after number. A drawn line on a date is
neutral. "LDL down 12% since you started" is a claim the data cannot support.

### One warning from our own data

The closest thing we have already built, medication changes on the web's charts (US-06
AC4), has logged **zero** `medication_history_viewed` events in eight weeks. Product-health
2026-W43 and W44 class the counter as **Suspect**: the emit (`HistoryPanel.tsx`) is gated on
a chart that carries a post-AC4 medication change, and nobody has made a deliberate
production view to test it (W38 backlog #4). So the check is more likely to find a broken
counter than an answer about demand. It is still worth doing first, for two reasons: this
plan's own `change_marker_viewed` would copy the same emit pattern, and until a working
counter shows whether people open annotated charts at all, we are guessing at demand for a
second kind of annotation. It costs an afternoon, plus a fix if the emit is broken.

We also do not know how many people have three or more readings of any one metric. The
health data is local-first and never reaches the server, so there is no way to count. That
is the question that decides most of the value, and I don't know the answer.

### The simplest version that would still be useful

A dated note ("30 g more protein a day", started 12 October) drawn as a marker on the
charts, listed with its date under each chart, editable and removable, ended when the
person stops. No before/after arithmetic, no "it worked" verdict, one plain caption. This is
option B below.

## 2. Data model in the record

### The shape

One new append-only array in `RoadmapFile`, `changes`:

```ts
/** A lifestyle change the person noted (story TBD). Append-only; edits are corrections. */
export interface FileChange {
  id: string;
  /** Closed list; drives the icon and which plan card it links to. */
  category: 'nutrition' | 'protein' | 'exercise' | 'sleep' | 'alcohol' | 'weight' | 'other';
  /** The person's words, trimmed, at most 80 characters. */
  title: string;
  /** YYYY-MM-DD: the day the person says they started. Their claim, not the write time. */
  startedOn: string;
  /** YYYY-MM-DD, or null while it is ongoing. Never before startedOn. */
  endedOn: string | null;
  /** The plan card it was noted from, e.g. 'protein-target'; null otherwise. */
  suggestionId: string | null;
  source: 'manual' | 'chat' | 'agent';
  createdAt: string;            // ISO instant of this row's write
  status: 'active' | 'entered-in-error';
  correctsId: string | null;    // the row this one replaces
  /** Set on the row a removal appends: the change is gone from every chart. */
  removed?: true;
}
```

Why not reuse what exists:

- **Not `supplementHistory` or `medicationHistory`.** Those are keyed by a product or drug
  slot and drive the medication cascade. A lifestyle note in them would leak into plan logic.
- **Not the profile.** LWW fields hold one current answer. A person can have several changes
  over years, and the history is the point.
- **Not `startedAt` semantics from medications.** US-06 AC4 deliberately marks the day a
  medication change was *recorded*, never a claimed start. A lifestyle change is the
  opposite case: the person often notes it a week later ("I started last Monday"), and the
  claimed start is what makes the marker useful. So `startedOn` is the person's day, kept
  apart from `createdAt`. The list says "You noted: started ..." so nobody reads it as a
  measured fact. Back-dating is allowed up to a limit (proposed: one year; question Q4).

### Create, edit, end, remove

All writes append. No row is ever changed in place, as with measurements (FHIR invariant).

| Action | What is written |
| --- | --- |
| Note a change | a new row, `correctsId: null` |
| Edit (title, dates, category) | a new row with `correctsId` = the current row; the old row flips to `entered-in-error` |
| End ("I stopped") | the same as an edit, with `endedOn` set |
| Restart | a new change, not an edit; the old one keeps its end |
| Remove | a successor row with `removed: true`; the old row flips. Nothing shows. |

Removal is a row, not a status flip, so a removal and an edit made on two devices resolve by
the same last-write-wins rule as everything else (below), rather than by an accident of
which flip arrived first.

### Merge across devices

- Union by id through `unionRows`, so an id reused with different content is quarantined,
  as for every other append-only array.
- `status` is monotonic, as in `unionSlotRows`: once `entered-in-error`, never back.
- **One active row per chain.** A chain is a row and every row that corrects it, followed to
  its root. Two devices editing the same change offline each append a successor, which
  leaves two active heads. The merge keeps the newer and flips the other. A head with
  `removed: true` shows nothing.
  - **Ordering:** compare `createdAt` as an instant (`stampInstant`), then id, so every
    device lands on the same answer. Not raw string order (`rowIsNewer` compares strings,
    so two offset spellings misorder). This is still clock-based: an edit made on a device
    whose clock runs fast can beat a removal made later in real time. Medications have the
    same weakness; `laterStamp`'s skew guard should stamp every change write.
  - **Cycle-safe roots.** `correctsId` links are never verified (merge.ts header). A hand
    edit or agent could write A corrects B and B corrects A. Root resolution must keep a
    visited set and a depth cap, or every save on every writer hangs. A row in a cycle is
    its own root.
  - **Orphans.** A row whose `correctsId` names a row not in the file is its own root. This
    happens after an erase: a stale device's edit of an erased change is rescued (a listing
    erase admits unlisted rows; an unlisted erase rescues rows created after it), and the
    change comes back in its edited form. That is the residual, the same one measurements
    accept for a value typed after an erase. State it in the story.
  - **Quarantined copies.** A `#dup-` copy from `unionRows` is a separate root. It shows as a
    second change, which the person can remove.
- **Duplicates and retries.** Changes have no natural slot, and the repo rule forbids deduping
  on free text. So the writer makes the id once, before any retry: the sheet when it opens,
  the chat banner when it shows, an agent tool from a caller-supplied `requestId`. A
  double-pressed Save or a retried tool call then writes the same id twice, which
  `unionRows` folds to one row.
- **Erase.** Add `changes` to `ROW_STAMPS` (stamp `createdAt`) and to `CREATED_STAMPS`, so
  "Delete all my data" lists and drops these rows and the post-erase rescue works (US-09
  AC20, AC23). Miss this and an erased note returns from another device.
- **US-65.** An unknown `category` from a newer build should read as `other` rather than hide
  the row: the category only picks an icon. A row with a broken date is unreadable and
  hidden, as US-65 does for any row a reader would crash on.

### The old-build trap (must fix before shipping)

An older build keeps unknown top-level fields when it reads the file (`migrate.ts` rule 1).
But its merge mishandles them on both paths:

- Equal epochs: it spreads `...remote, ...local`, so **its own copy of `changes` replaces
  the remote one whole**. A note added on the web vanishes the next time a stale build saves.
- Different epochs: the erase gate takes the winner's copy whole (`{ ...top, ...listing }`),
  and `rowsSince` rescues only the arrays in `ROW_STAMPS`, so the losing copy's changes are
  dropped.

Four kinds of writer can lag: an iPhone build that no longer receives over-the-air engines
(builds 3 and 4), a stdio MCP or CLI the person installed and never updated, a self-hosted
Pages fork, and a browser tab left open across a deploy.

The fix has a precedent. US-09 AC23 stamps `schemaVersion` up only when a file actually
carries `erasedRows`, so an older reader refuses that file and cannot damage it. Do the same,
with three corrections the review found:

1. **The version number is not free.** The one-blood-table draft (branch
   `claude/one-blood-table`, its own proposed US-66) already claims schema 3 for "a record
   whose `labValues` holds a core row". Two meanings for one number would let a build that
   knows one feature read a file holding the other without refusing it, which is exactly the
   trap. The two plans need one ladder (say, 3 for blood tests, 4 for changes) or one
   combined bump. That is a decision for Brad (Q8).
2. **Erase needs its own constant.** Today `CURRENT_SCHEMA_VERSION` doubles as the erase
   list's version (`migrate.ts:327`, `merge.ts:753`, `erase.ts:74`). Bump it as written and
   every file that ever had a listed erase becomes the new version on its next read, with no
   change rows in it. The erase list keeps its own constant (2), as the one-blood-table draft
   also proposes, and a changes-aware stamp goes into migrate, merge and every writer
   (RoadmapStore, file-adapter, the hosted REST paths).
3. **The lockout is total, not write-only.** `migrate.ts` refuses a too-new file on read
   (US-65 AC5), so a stale build cannot even show the record. Only files that hold a change
   are affected, but for those the person must update the app or CLI to see anything.

**Rollout order follows from 3.** iOS D3 forbids an over-the-air engine from changing the
schema (`ios/engine/entry.ts`, `EngineManifest.swift` refuses a mismatch). So the iPhone
binary that reads the new version ships through TestFlight first, and the web write path
deploys only after it. Brad's phone has held real data since 2026-11-02: a change noted on
the web before his build updates would lock his phone out of his record.

### Removal and the person's own words

A removal appends a row, so the removed note's title stays in the file, as a deleted
measurement's value does. For a clinical value that is the FHIR rule. A change note is the
person's free text ("stopped drinking"), and documents set the other precedent: "a deleted
document is gone, text and all" to every reader. Whatever Brad picks (Q9), these hold:

- Removed chains and superseded titles never reach `read_record`, the chat context or the
  readable view. Only the current head of a live chain is read.
- The Remove confirm says so plainly: "Removed from your charts. Delete all my data erases it
  from your record file."

### Every surface that lists the record's arrays

A new array is silently dropped or unchecked wherever a list of arrays is hard-coded. Each
needs `changes` and a test:

- `merge.ts` `ROW_STAMPS` and `CREATED_STAMPS` (erase).
- `roadmap-doc.ts` `ROW_ARRAYS` (the shape gate: a non-list `changes` from a hand edit must be
  refused, not migrated to an empty list) and `rowIds` (verify-after-write: without it, a
  change lost to another writer is never noticed).
- `readable-rows.ts` `ROWS` (the view cache keys on array lengths; US-65).
- `migrate.ts` `recoveredClock`.
- `mcp-tools.ts` `readRecordOutput` and `RECORD_SECTIONS` (US-32 AC41: every section, always).
- `docs/health-roadmap-file.schema.json` and `docs/agent-access.md` (the published file
  contract).
- `roadmap-data.ts` / `RoadmapStore` (the web's write API) and the iPhone engine's edit entry.

This is merge and FHIR code. It needs the orchestrator's call, a fresh adversary and Codex
at build time, and round-trip tests in `merge.test.ts`: two devices, concurrent edit,
edit-versus-remove, a correction cycle, an orphan after each kind of erase, a retried write
with one id, and old-build refusal.

## 3. The interface, web and iPhone alike

Both clients read one health-core projection, `changeAnnotations(file, metric)`, beside
`medication-annotations.ts`, so the words and the rules live in one place. The iPhone engine
serves it on `historyJson` as it serves medication `markers` today (US-25 AC9b), so an
over-the-air engine can change it.

### Where a change is noted

Two entry points, one sheet:

1. **The plan card (Brad's idea).** On the lifestyle cards only: `protein-target`,
   `exercise`, `fiber`, `lipid-diet`, `low-salt`, `high-potassium`, `trig-nutrition`, `sleep`
   and, while it shows, `reduce-alcohol`. A quiet "I've started this" link at the foot of the
   card. It opens the sheet with the category and title filled from the card ("More protein")
   and today's date. Not on medication, screening or supplement cards: medications and
   supplements already have their own start records.
2. **The metric page.** "Note a change" under the chart's list. This catches changes no card
   covers ("stopped drinking soft drinks").

The sheet: a title (filled or typed), a category (picker), "Started" (a date, default today,
no later than today, no earlier than a year ago), and Save. Nothing else. After saving, a
card with an open change says "Started 12 Oct" under its link, so the person sees it took.

Managing: tapping a change in a chart's list opens it with Edit, "I've stopped", and Remove
(with a confirm). A small "Changes you noted" list sits at the foot of My data on both
clients, so changes are findable when no chart shows them yet.

### How markers draw

- **Which charts.** Recommendation: every value chart, because the app makes no claim about
  which change affects which number. Drawing protein only on weight would be a clinical
  mapping the evidence does not support well (option C, section 6). Medication markers keep
  their own mapping, unchanged.
- **The mark.** A thin vertical rule on the start day, in a colour distinct from the
  medication indigo, with a small numbered tab at the top. An ended change also draws a faint
  shaded band from start to end, so "while I was doing this" reads at a glance. An ongoing
  change shades to the chart's right edge.
- **The range.** As for medications, the chart's range reaches the marker, so a change noted
  after the last reading still shows.
- **The list.** Under the chart, merged with the medication list by date: "1 · You noted:
  started More protein · 12 Oct 2026". Selecting an entry highlights its marker (the US-06
  AC4 behaviour, reused). A scrub still picks only values.
- **Clutter.** At most three change markers drawn per chart range; past three, the oldest
  draw as a single tick with "+N" and live in the list only. Weekly-scale charts rarely hit
  this; a five-year LDL chart will.
- **The caption.** One line under any chart that carries a change marker, fixed text, both
  clients: "Markers show when you noted a change. Numbers vary from test to test, so one
  result after a change rarely shows whether it worked." This is user-facing health wording:
  Brad approves the exact words (Q5), and if it cites anything it goes through the three-file
  sync.

### Phone and desktop

- iPhone: Swift Charts `RuleMark` and `RectangleMark` in `MetricChart.swift`, the list and
  the sheet in `MetricDetailView.swift`, the card link in `PlanCardView.swift`. The tab label
  must not collide with the medication rule; test in a 320 pt width.
- Web: `HistoryPanel.tsx` today; whatever metric page US-62 lands by the time this builds.
  Desktop has room for the band and the list side by side; a phone web view stacks them.
- Apple Health pages (iPhone only): markers should draw there too, but those pages do not go
  through `historyJson` or `MetricChart.swift`. They draw their own charts
  (`LiveMetricPage.swift`, `SleepPage.swift`). They need a new engine field or door for the
  change list (a bridge-contract question under D3) and their own chart work. Since the
  "who benefits" case leans on these pages, this is not optional polish: without it, the
  measures that move fastest show no markers. The web has no such pages, so this is the one
  place the clients differ, by data, not by design. The story says so.

### Accessibility

- VoiceOver and screen readers read the list, not the rules, as US-25 AC9b does for
  medications. Each list entry reads "Change 1, you noted, started More protein, 12 October
  2026, ongoing".
- The marker is never colour alone: the numbered tab and the list carry it.
- Reduced motion: no draw-in for markers (US-06 AC4a).
- The sheet's controls meet the 44 pt target on the phone and are keyboard-reachable on the
  web.

### Masking

The sheet, the chart list, the SVG tab labels and "Changes you noted" all show the person's
own words. On the web, Clarity keeps rendered text unless the element is masked, and
portalled panels escape the tool root's mask (docs/reference.md gotcha, 2026-09-10). Every
new web surface carries `data-clarity-mask="true"`, with a case in `clarity-masking.test.tsx`.
On the iPhone, the whole window is already masked (D9); the sheet's text field also carries
`analyticsMasked()`.

## 4. Agents and the chatbot

### MCP and CLI (docs/agent-access.md)

- `read_record` returns `changes` through the readable view (US-65 AC3), so an assistant can
  say what the person changed and when.
- Two write tools, behind the same rules as `add_measurement`: `note_change` {title, category,
  startedOn, suggestionId?} and `end_change` {id, endedOn}. Edit and remove stay in the app
  for v1: they are rarer and easier to get wrong by voice. Both go through `SyncManager`
  (merge on conflict, verify after write). This is an agent-contract change: Codex and a
  fresh adversary before commit.
- The CLI gets the matching `note-change` command.

### The chat

Yes, the chat can propose one, never write one silently (US-16). "I started eating 30 g more
protein last week" becomes a fourth form tool, `propose_change_note` {title, category,
startedOn}, parsed in `chat-edits.ts`, shown as a banner: "Note a change: More protein,
started 26 Oct?" with Save and Not now. The model passes the date it understood; the parser
refuses a date in the future (judged by `latestDayOnEarth`, US-31 AC6, when it runs on the
server) or more than a year back. The banner makes the row's id when it shows (section 2,
duplicates).

**Web:** the tool goes wherever the other form tools go: the widget's chat and the Pages
chat.

**iPhone (more work than it looks):** the iPhone chat (US-52) does not get the form tools
today. The server turns them off for app requests (`api.chat.ts`: `canApplyEdits` needs
`!app`), `ChatClient.swift` advertises no edit capability, and `ChatModels.swift` decodes no
proposed edits. Parity needs a change-note capability flag the app sends, server gating on
it (so older app builds never get a proposal they cannot show, as US-16 AC2 requires), Swift
decoding, and the banner in SwiftUI. Phase 2, and a parity gap until it ships.

**Chat context:** the widget's chat and the iPhone chat gain the current head of each open
or recently ended change, so answers can mention them. Not the blog bubble or the chatbot
embed: US-15 AC10 lists exactly what those send, and they store transcripts. That context
already carries health values to Brad's server and to the model under the existing chat
rules (US-15); change notes add the person's own words, so the US-15 retention note covers
them. The chatbot must not tell the person a change worked from one result; that rule goes
into the chat's knowledge pipeline (claude_business), not this repo.

## 5. Measurement and the story

### Usage signal

- **Web (`product_events`, Shopify surface only):**
  - `change_noted`, metadata `{ entry: 'plan_card' | 'metric_page' | 'chat' }` only. Never the
    category, the title, the date or the card. Category is behaviour, and behaviour next to a
    plan is health-adjacent; the entry point is enough to learn from.
  - `change_marker_viewed`, the name alone, once per tab session, when a chart carrying a
    change marker is on screen.
- **iPhone (D9, Clarity words):** "Change noted" and "Change marker seen". A D9 change and an
  `AnalyticsMaskingTests` change.
- **Success, read 60 days after ship:** events carry a persistent `visitorId` but no tab or
  visit id, so the cohort is counted by visitor and by day. Denominator: visitors who sent
  `results_viewed` on two or more different days in the window. Numerator: those who also
  sent `change_noted`. Target at least 5%, and at least half of the noters later sending
  `change_marker_viewed` on a later day. Below 1% at 60 days, remove it (deletion-first).
  The numbers are a starting proposal, not derived from anything (Q10). The iPhone's Clarity
  words give a rough second read, not a matched cohort.

### Draft story (proposal, not yet in docs/user-stories.md)

> **US-xx (next free id; US-66 is claimed by the one-blood-table draft) · I note a change I made and see it on my charts** (proposed 2026-11-02)
> As someone following my plan, I note the day I started a change (more protein, a new
> exercise routine, a diet change), so my charts show what I was doing when my numbers moved,
> without the app claiming the change caused it.
>
> - AC1 (note): from a lifestyle plan card or a metric page I note a change with a title, a
>   category and a start day (today by default, never in the future, at most a year back).
>   The card then shows "Started <date>". Web and iPhone alike.
> - AC2 (record): the change is a row in the record's `changes` array, in my cloud file only.
>   Edit, end and remove append rows and flip the replaced row to `entered-in-error`; no row
>   is changed in place.
> - AC3 (merge): two devices converge on the same changes: one active row per chain, newest
>   write wins, a removal is a write. "Delete all my data" removes them and they never come
>   back. Root resolution survives a correction cycle; an orphaned edit is its own root. A
>   retried write with the same id is one row. A file holding a change is stamped the
>   schema version Q8 settles, and an older build refuses it; a file without changes keeps
>   its version, an erased one included. The iPhone binary that reads it ships before the
>   web writes it.
> - AC3a (removal): a removed change, and every superseded title, never reaches the charts,
>   `read_record`, the chat context or the readable view.
> - AC4 (charts): every value chart draws each change as a rule on its start day, a band
>   while it ran, and a numbered entry in the dated list below, merged with medication
>   changes. At most three markers draw per range; the rest show in the list. Screen readers
>   read the list.
> - AC5 (no verdict): no chart, list, card or chat reply computes a before/after difference
>   or says a change worked. Charts with a marker show the approved caption.
> - AC6 (chat): the chat proposes a change from what I say; nothing is saved until I press
>   Save.
> - AC7 (agents): `read_record` returns my changes; `note_change` and `end_change` write
>   them through `SyncManager`.
> - AC8 (usage signal): `change_noted` {entry} and `change_marker_viewed` on the web;
>   "Change noted" and "Change marker seen" on the iPhone. No title, category or date in any
>   event, log or Sentry report. Every new web surface showing a note is Clarity-masked,
>   with a test.
> - Gate check: merge/FHIR and agent contract (adversary + Codex). Clinical: the caption and
>   any timing guidance go through the three-file sync if they cite evidence.

## 6. Options

| Option | What | For | Against |
| --- | --- | --- | --- |
| **A. Don't build** | Add a short "how long changes take to show" line to the metric guides (US-58) instead | Cheapest; no schema change; little over-reading risk | It is clinical timing advice, so it still needs Brad's words and the three-file sync (US-58 AC2 bounds guides to claims already in the three files); loses the retention loop and the chat context; Brad's idea unanswered |
| **B. Lean markers (recommended)** | Section 2 to 5: note, edit, end, remove; every chart; no arithmetic; caption | Useful for frequent measures; honest; reuses the medication marker path | A schema bump tied to the one-blood-table plan, with iPhone-first rollout; one more thing on small charts; value for blood tests is low |
| **C. B + mapped charts** | A change shows only on the metrics its category plausibly moves (protein on weight, fibre on LDL) | Less clutter; feels smarter | A clinical mapping the evidence supports unevenly; needs the three-file sync and Brad's sign-off on every pair; wrong pairs mislead |
| **D. C + "did it work?"** | Before/after averages, a "real change" verdict from reference change values, and a reminder to retest at the right time ("recheck LDL 6 to 8 weeks after a diet change") | The clinically useful version; the retest reminder is the best part | Most build; a verdict on two or three results is exactly the over-reading risk; clinical content end to end |

**Recommendation: B, after the medication-marker check.** First, one deliberate production
view to settle whether `medication_history_viewed` fires (an afternoon). If annotated charts
are seen, build B in two phases: phase 1 the record, merge and the web and iPhone charts and
sheet; phase 2 the chat tool and the agent tools. Treat D's retest reminder as a separate,
later idea: it is the best piece of D and needs no verdict, but it is clinical timing advice
and belongs in the algorithm doc first.

Why not C: the step from "the app shows when you changed something" to "the app says which
numbers this change affects" is a clinical claim on every pair, and most lifestyle-to-marker
links are modest, slow and individual. B lets the person look; C would tell them where to
look and imply what to expect.

Cost of B in production code (rough, and likely low): health-core `changes` type, migrate,
merge with cycle-safe chains, the version stamp and the array lists in section 2 (about
200 lines), the projection (about 60), the web sheet, list and marks (about 250), the iPhone
sheet, list and marks on the metric pages (about 250), the Apple Health pages' engine door
and marks (about 150). Phase 2: the web chat tool (about 60), the iPhone chat capability,
decoding and banner (about 150), the two agent tools and the CLI command (about 150).
Nothing deletable found; the chart list merge may let `HistoryPanel`'s medication list code
be shared rather than added. This draft itself is docs only: net production LOC 0, nothing
deleted.

## 7. Questions for Brad

Each carries its own context.

1. **Build it at all, and which option?** The idea: let a person note a lifestyle change and
   see it on their charts. The issue: it helps people who measure often, helps little with
   blood tests, and invites over-reading. Options: A (don't build; add a timing line to the
   guides), B (lean markers, no verdict), C (markers only on "related" metrics, a clinical
   mapping), D (before/after verdicts and retest reminders). Recommendation: B, because it
   gives the useful part and makes no claim the data cannot back.
2. **Check medication markers first?** The issue: the medication markers we already built
   have logged zero views in eight weeks, and the product-health loop now calls the counter
   Suspect (probably broken). Options: settle it first (an afternoon, plus a fix if the emit
   is broken), or build B regardless. Recommendation: settle it first. B's own view counter
   would copy the same pattern, and if annotated charts are not opened, B needs a different
   entry point, not more markers.
3. **Every chart, or only related ones?** Options: every value chart (no clinical claim,
   more clutter) or a category-to-metric map (less clutter, a clinical claim per pair).
   Recommendation: every chart, capped at three drawn markers per range.
4. **Whose date?** Medications mark the day a change was recorded, never a claimed start
   (US-06 AC4). For lifestyle, the person's own start day is the useful one. Options: their
   claimed day (back-dated up to a year) or the recorded day only. Recommendation: their
   claimed day, labelled "You noted", because "I started last Monday" is how people report
   these.
5. **The caption's words.** Proposed: "Markers show when you noted a change. Numbers vary
   from test to test, so one result after a change rarely shows whether it worked." Options:
   this, your own words, or no caption. Recommendation: a caption, in words you approve; it
   is user-facing health wording.
6. **The schema bump.** The issue: an old build would silently drop notes made elsewhere.
   Options: stamp a new schema version on files with a change (old builds refuse to open
   those files at all, read and write, until updated), or ship without it and accept lost
   notes from stale builds. Recommendation: the bump, as `erasedRows` already does. The cost
   is asking a few people to update, and shipping the iPhone binary through TestFlight
   before the web can write a change, so your own phone is never locked out.
7. **Chat and agents.** Options: the chat proposes changes (banner, Save, Not now) and
   agents get `note_change` and `end_change`, or the app alone writes them. The web chat is
   cheap; the iPhone chat has no form tools today and needs a capability flag, server
   gating and a SwiftUI banner. Recommendation: both, in phase 2, because "I started X last
   week" is the most natural way to say it.
8. **One version ladder with the one-blood-table plan.** The issue: that draft (its own
   proposed US-66) already claims schema 3 for files holding core blood rows. If both use 3,
   a build that knows one feature reads a file holding the other without refusing it, and
   loses data. Options: one ladder (3 blood tests, 4 changes, each stamped only when its rows
   exist), or one combined bump shipped together. Recommendation: one ladder, so the two
   features ship independently; decide it before either builds.
9. **Does Remove really delete the words?** The issue: rows are append-only, so a removed
   note's text ("stopped drinking") stays in the file until "Delete all my data". Clinical
   values follow that FHIR rule; documents do not ("gone, text and all"). Options: keep
   append-only and hide removed text from every reader (simple, merge-safe), or blank the
   title on removal like a document tombstone (the words really go; a small merge special
   case). Recommendation: hide from every reader now, as section 2 specifies; revisit if
   people put sensitive things in notes.
10. **The success bar.** Proposed: at least 5% of returning visitors note a change within 60
   days, and half of those later view a marker; below 1%, remove it. These are guesses, not
   derived from anything. Options: accept, set your own, or measure for 60 days and decide
   then. Recommendation: accept the 1% removal floor now, so the feature cannot linger
   unused.

## Out of scope

- Moving medication markers to a claimed start date.
- Supplements on the charts (they have start dates; a separate decision).
- Any change to the plan or the suggestion rules: a noted change never alters the plan.
