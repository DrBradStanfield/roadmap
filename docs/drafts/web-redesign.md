# Web app redesign to match the iPhone app: plan (draft 4, 2026-10-31)

Brad asked for this after using the iPhone app. Beside it, the web app looks shabby,
especially on a phone. He wants:

- the mobile web to look like the iPhone app;
- a sign-in button where "Supercharge this tool" sits now, and a new home for that link;
- Starting info at the bottom once it is filled in;
- better onboarding.

Nothing is built yet. Draft 1 went to a fresh Opus adversary, which found five
blockers, and Codex reviewed draft 2. Draft 3 fixed both; see "Review" at the end.
Draft 4 takes Brad's answers of 2026-10-31 (next section).

## Brad's answers, 2026-10-31

- **Sign in** replaces the "Supercharge this tool" button in the same spot.
  Supercharge moves to a card at the foot of My plan, keeping its name. Agreed.
- **No onboarding screen and no "Already have a record?" step.** The layout stays; the
  Sign in button is the way back to a saved record. The form itself becomes the
  onboarding: a new question order, with snapshot cards appearing as each answer
  lands (section 4).
- **Bottom tab bar** agreed, with Swiper removed cleanly: no dead code (section 5).
- **Plan cards stay as they are.** No two-line collapse.
- **Blood tests on phones:** Brad likes the grid but prefers the iPhone's cleaner look,
  and wants the previous value visible. Draft 4 proposes a row with latest, previous
  and direction (section 5); Brad to confirm from the mock-up.
- **Rollout:** a deploy updates every page that carries the block, so a hidden page
  only isolates the new layout if old and new both ship behind a switch. Brad prefers
  localhost, then production, then fix there. Draft 4 does that (section "How we roll
  it out").
- **Green:** #00a38b is the brand and matches Brad's scrubs. Draft 4 keeps it as the
  brand and adds a deeper shade of the same hue only where white text sits on green
  (section 1, call B1).

## What we have today (checked on localhost and in the code)

**Layout.** One React widget ships in two builds: the Shopify block (drstanfield.com
homepage, `/pages/roadmap` and `/pages/start`) and GitHub Pages.

- At 768px and below it shows three text tabs at the top (Input, Plan, Chat) inside a
  Swiper carousel (`HealthTool.tsx` 1245-1286).
- Above the widget sits a hero: Dr Brad's photo, "Get Your Personalized Health Plan"
  and a paragraph. It is Liquid on Shopify (`app-block.liquid` 16-26) and static HTML on
  Pages (`standalone/index.html`). Both render before any JavaScript runs.
- Desktop shows two columns, or three with chat at 1200px and up.

**On a phone (375px):**

- The hero fills most of the first screen on every visit.
- The Input tab is one long scroll: Starting info, then the vitals matrix, the
  blood-test matrix (cramped at 375px), medications, screening and supplements.
- The Swiper can pan sideways and show half of two tabs at once. I saw it on localhost
  when a field was scrolled into view.
- The tabs are underlined text at the top, not a tab bar.
- Plan cards print their full text, so the plan is a long read.
- The web has no dark theme.

**Sign-in.** There are no accounts. "Signing in" means choosing where the record lives:
Google Drive, Dropbox, GitHub, WebDAV or this browser only (`backend-picker.tsx`).

- On the plan, a button asks "Where do you want to keep your health record?"
  (`sync-control.tsx`).
- The same choice is offered by a sentence with a link, the upload modal, the
  email-landing notice and the reconnect controls.
- **The plan button is hidden until the browser holds data** (`sync-control.tsx`
  146-150). Someone with a record, on a new phone or a cleared browser, sees an empty
  form. Nothing on the screen they land on says they can open their record. On Pages
  nothing does at all.
- The storage state has more than two values (`storageState()`):
  - a guest;
  - connected;
  - connected with changes still waiting to sync;
  - reconnect. The provider could not be reached, and the picker must copy the record
    down before any switch (US-09 AC13).

**"Supercharge this tool."** A link to the open-source guide.

- It sits in the desktop input-column header. On a phone it becomes a line at the foot
  of the input column.
- Opens in W39: 39 from the desktop header and 3 from the phone footer. Phone footer
  opens in W40 to W43: 1, 0, 1, 0. About 61% of host-site sessions are on phones, so the
  phone placement barely works.
- Brad decided on 2026-09-11 that this one link, by that name, is the only entry point
  to the connector layer, and that it must not add a step for anyone.

**Starting info.** It collapses to a summary line ("Male · 178 cm tall · Born May 1975
(Age 51)"). It does so only on a return visit, with sex, height and birth date complete.
It never moves.

**Colours.** The two apps use different greens.

- Web: `--color-brand: #00a38b`, 78 uses in a 5,697-line `styles.css`. White text on it
  is 3.18:1, below the 4.5:1 that normal text needs, so today's buttons already fail.
- iPhone: #0B7A55 (5.34:1 on white), and #33D18F in dark mode.

## What the iPhone app actually does

- **Tabs:** a bottom tab bar with My data, My plan and Chat. It opens on My data, and
  goes to My plan after onboarding.
- **Onboarding (US-54):**
  - A welcome screen with "Get started" and "I already use Health Roadmap". The second
    connects the cloud first and asks questions only once the cloud record is open
    (AC2), so empty-phone answers never overwrite the real record.
  - Then one question per screen: Apple Health, sex, birth month and year, height,
    weight, then a review step.
  - **Every question must be answered. Weight has no Skip** (Brad 2026-10-23).
  - Then a three-tip tour across My plan and My data (US-57).
- **About you does not move when complete.** It always sits low on My data (9th of 11
  sections), because onboarding has already asked for it. Brad's "move it to the bottom"
  is right. The way to get there is to ask first, in onboarding, then keep it low for
  good.
- **My data:** grouped cards on light grey, and a coloured symbol for each section.
  Each row opens a value page with a chart and history.
- **My plan:** snapshot tiles in two columns (one at large text sizes), each with a
  status capsule. Below them, cards that show a title and two lines and expand on tap.
- **Sync:** a sheet opened from an icon on My data. There is no account.
- **Open source:** never mentioned.

## Recommendations

### 1. One design language

- Take the iPhone's values for the web:
  - the light grey background;
  - white cards with 20px corners;
  - the system font;
  - section symbols as inline SVG;
  - status capsules on the tiles.
- New styles replace old ones in the same commit; nothing runs side by side.
- **Contrast is a requirement, not a copy.** The iPhone's grey secondary text is about
  3.4:1 on white and fails, so the web keeps a darker grey, about #5a6b73 (4.97:1).
  Every text and background pair must reach 4.5:1 on both white and grey. That
  includes the capsules, whose text gets a deeper colour than its tint.
- **Green stays #00a38b, the colour of Brad's scrubs.** It works everywhere except
  under small white text: white on #00a38b is 3.18:1, and normal text needs 4.5:1.
  Dark text on it passes (#1c2b33 is 4.58:1). So:
  - #00a38b: the brand. Logo, accents, chart lines, tile edges, large headings, and
    any button whose label is dark.
  - **#008270**, the same hue made deeper: buttons and links that carry small white
    text (4.74:1). Side by side it reads as the same green in shadow, not a new one.
  - The iPhone's #0B7A55 is a greener, different hue. Matching the web to it would move
    the brand off the scrubs. The better fix is the other way: give the iPhone #008270
    too, so both apps share one pair (B1).
  - For reference, the store's email pop-up already uses a darker green
    (#157551, measured live), so a deeper shade beside #00a38b is not new to the site.
- Dark mode: the tokens get a second set of values later. Light ships first, because
  the Shopify theme around the widget is light.

### 2. The top bar and "Sign in"

A slim bar sits at the top of the widget. The label on its right comes from
`storageState()`, so it never claims what is not true:

| State | Label | Tap opens |
|---|---|---|
| Guest | **Sign in** | the picker |
| Connected | provider icon + "Dropbox" (or Drive, GitHub…) | the sync sheet: where it lives, Disconnect |
| Changes waiting | provider icon + "Saving…" | the sync sheet |
| Reconnect | "Reconnect Dropbox" (Drive: "Sign in to Google again"; others: "Retry") | today's reconnect flow |

- The picker always gets `current={reconnect ?? backend}`, as it does now (US-09 AC13).
  So no state lets someone switch providers and orphan a record.
- There is no "Sync now". The web syncs on every save.
- The picker gets a first line that answers what a guest expects: "Saved your record to
  Dropbox, Google Drive or GitHub before? Open it here. If not, it is in this browser,
  and you can choose a home for it now."
- The plan's "Where do you want to keep your health record?" panel stays, for people
  who never look at the bar.

The wording costs are listed under call B2.

### 3. "Supercharge this tool"

The link keeps its name and its single destination. Recommended home: the **foot of My
plan**, on phone and desktop, as its own small card. It reads "Supercharge this tool",
with one line under it: "Open source. Use your record with ChatGPT, Claude or the
command line."

- People reach the foot of the plan once they have a plan, which is when the link
  makes sense. It adds no step for anyone.
- I considered the sign-in sheet and decided against it. That sheet is where the
  privacy promise is made ("your record lives there, not with us"). An AI pitch beside
  it could read as data going to OpenAI or Anthropic, and US-09 AC5 says the promise one
  way everywhere.
- The desktop header button goes, to make room for the bar.
- A new `guide_opened` placement, `plan_footer`, needs the server's event list
  (`app/lib/product-events.server.ts`) deployed before the widget. Otherwise the new
  events are rejected.
- This changes where the 2026-09-11 link lives, so it is Brad's call (B3).

### 4. Onboarding: the form builds the plan as you answer

Brad, 2026-10-31: no separate onboarding screen and no sign-in step first. The layout
stays. The Sign in button in the top bar is how a returning person opens their record.
The form's own order changes, so the plan builds in front of the person, one card at a
time.

**The order, and what each answer unlocks:**

| Step | Asks | Then shows |
|---|---|---|
| 1 | Height and weight | The BMI tile |
| 2 | Sex, with one line on why | Healthy weight (IBW) and the protein target |
| 3 | Birth month and year, with one line on why | The age-based plan: blood pressure target, screenings, the rest of the form |

- **The why-text shows, not hidden in a tooltip** (Brad, 2026-10-31). It reuses today's
  tooltip text word for word, under each question. Sex: "Used to calculate ideal body
  weight, kidney function, and screening programs." Birth date: "Used to calculate
  age-based screening suggestions (cancer, bone density) and kidney function." The
  tooltips go (`InputPanel.tsx` 794, 1064), so the text lives in one place.
- Each value saves as it is entered, as it does today. Each new tile appears in My plan
  as soon as it can be worked out, and on phones the plan tab shows a small dot so the
  person knows something new arrived.
- **Every step is required, no Skip**, the iPhone's rule. The rest of the form opens
  only after step 3.
- **Resume at the first missing answer** (Codex R1). Someone who saves height and weight
  and then leaves comes back to the sex question, not the full form. So
  `computeFormStage` changes: the full form needs height, weight, sex and birth date.
  Today a saved weight alone opens it (`mappings.ts` 579, pinned by `mappings.test.ts`),
  and that bypass goes. A saved blood test still opens the full form (a lab import with
  no profile), but the missing profile questions show at the top until answered.
  Tests: reload after step 1, and after step 2.

**What this changes underneath:**

- This is a change to progressive disclosure, which `health_roadmap_algorithm.md` §10
  documents. The stage gates and the attention glow change, so the clinical
  three-file rule applies (the evidence and user-text files likely need no change; the
  commit says why).
- `calculateHealthResults` needs sex and height before it returns anything, so today no
  tile can show before sex. **Change the engine, not a web-only workaround** (Brad,
  2026-10-31: one source of truth). `calculateHealthResults` accepts missing sex and
  returns what can be worked out: BMI from height and weight; IBW, protein and the rest
  once sex arrives. `statTiles` already handles a missing sex for the BMI reading. Costs:
  every caller of `HealthResults` must cope with absent fields (the web, the iPhone
  engine bundle, MCP `get_plan`, the chatbot context), so the type change is checked
  by the compiler and tests; the iPhone then needs a rebuilt engine bundle and Brad's
  signed engine update; and it is a clinical and agent-contract change, so adversary and
  Codex review it.
- **A child could see an adult BMI reading** for one step, since birth date now comes
  last. Today the form asks age at stage 2. Recommended: the step-1 tile shows the
  number with "adult ranges" until the birth date arrives; a known minor then gets
  today's handling (`knownMinorOf`). Clinical call for Brad.
- A returning person on a new device who types height and weight before tapping Sign
  in: those values merge into the cloud record when they connect. Weight is a new dated
  reading, which is correct. Height and sex follow newest-wins, so a typed value
  replaces the stored one. That is the same behaviour as today's form.

**After the plan appears:** a three-tip tour in the iPhone's words (US-57). It can be
dismissed.

**Desktop:** the same new order, since it is the same form. Only the phone's tab dot
is phone-only.

### 5. The mobile web becomes the iPhone layout

**A bottom tab bar** with My data, My plan and Chat.

- It is sticky inside the widget and shows only while the widget is on screen
  (IntersectionObserver). It must not float over the rest of the Shopify homepage.
- It replaces the fixed "See Your Personalized Plan" button.
- **Swiper goes completely, in the same commit** (Brad: no dead code). Only
  `HealthTool.tsx` imports it. The commit deletes:
  - the `swiper` dependency in `widget-src/package.json`, and its CSS import;
  - `swiperRef`, `liveSwiper()` and the three call sites that re-measure or move it
    (`HealthTool.tsx` 837-855, 1136, 1227);
  - the `<Swiper>`/`<SwiperSlide>` block (1258-1287), replaced by three panels where
    only the active one renders visibly;
  - `ResultsPanel`'s `onLayoutChange` prop, which exists only to re-measure Swiper;
  - `styles.css` 231-250 and `HealthTool.swiper.test.tsx`, replaced by a tab test;
  - the Swiper comment in `AlcoholQuestion.tsx` (its portal stays only if a
    transformed parent remains; otherwise it goes too).
- Plain React state picks the tab; no library. Each tab keeps its own scroll position.
- Tab semantics: `role="tablist"`, arrow keys, `aria-selected`.

**My data:** the iPhone's sections and order, as grouped cards, with About you low.

- **Blood tests and vitals: one row per value** (Brad's layout, 2026-10-31):
  - left: the name, and under it **target · date** ("Normal <5.7% · Oct 2026"). The
    targets are what the web grid shows today and the iPhone lacks. **Every target
    the web shows today must survive** (Codex R2). `refHintFor` covers only some
    blood tests. Lp(a) comes from `lpaRefHint` in the chosen unit, and blood
    pressure, weight and waist targets come from the plan (`StartingInfoVitals`). So
    one health-core function, `rowTarget(metric, unit, grading, plan)`, gathers all
    three sources. The web grid, the new rows and the iPhone all call it;
    the unit is dropped from the target ("Normal <5.7"), since it shows on the right,
    or a 375px phone truncates rows like creatinine's "Normal: 0.7–1.2 mg/dL · Oct 2026";
  - middle: the trend line, as the iPhone draws it now;
  - right: the latest value with the previous one in brackets, smaller and grey,
    and the unit under it: **"81 (74)" / "mg/dL"** (Brad, 2026-10-31, replacing "was").
    A first result shows the value alone. Screen readers hear "81, previous 74", since
    brackets alone say nothing out loud.
  - A known minor loses only the adult targets, as today. **The waist target stays**,
    because waist-to-height applies to children too (US-07 AC6; Codex R3). Metrics
    with no target (eGFR today) show just the date.
- Tapping a row opens the value's page: chart, full history, add a value, correct one.
  It is built on today's history panel.
- **The grid stays on desktop, unchanged.** On a phone it stays one tap away as **"All
  results as a table"**, at the foot of Blood tests: every result on every date, side
  by side, scrolling sideways. It is the same grid, so it also serves for typing in a
  whole lab report and moving a test to another day. Nothing the grid does today is
  lost.

**My plan: unchanged in structure** (Brad, 2026-10-31). The cards keep today's web
layout. It gets the new tokens only.

**Chat:** unchanged inside, restyled.

**A "+" on My data** for adding values and uploading a lab report, as on the iPhone.

**Every control keeps a home.** The web form has controls the iPhone layout has no
place for: correcting a value, moving a test to another day, the feedback button,
"Delete all my data", the email box and Save as PDF. Moving to rows and tabs must not
lose any of them. The table further down names where each one ends up.

**Hero on a phone: compact, approved and being built (Brad, 2026-10-31).** Nothing was broken. It is a
trade of space. Today it is not compact. The photo stacks above the headline and
paragraph, 371px tall on a 375 × 812 phone (measured live), so the form starts halfway
down the first screen, and the email pop-up covers the rest. Recommended: one compact
hero on phones, always: a small round photo beside the headline on one row, the
paragraph cut to one line, about 120px. Pure CSS in the Liquid block, no JavaScript, so
the page never jumps.

### 6. Desktop

Desktop keeps its two or three columns. It gets the tokens, the top bar, the tiles, the
plan cards and the Supercharge card. Desktop works today and gives most of the guide
opens, so it changes look, not structure.

## Where every current control goes (mobile)

| Control today | New home |
|---|---|
| Sex, height, birth date, units (Starting info) | The form's first three steps, then My data › About you (low) |
| Weight, waist, blood pressure (vitals matrix) | My data › Vitals rows › value page › Add |
| Blood-test matrix, additional blood tests | My data › Blood tests rows; "Edit as table" for both |
| Corrections (US-04, US-21 AC5) | Value page history row › Correct |
| Move a test to another day (shipped 29 Oct) | "Edit as table" date header, as now |
| Per-field unit switch | Value page › Unit |
| Upload lab results, keep documents | My data "+" › Upload; documents under My data › Your record |
| Medications, supplements, screening, bone density | My data sections, as now, restyled |
| Save button for unsaved values | Value page Add sheet (saves on Add) |
| Snapshot tiles, plan cards | My plan |
| Save as PDF, email capture (Shopify; US-18, US-22, US-44) | Top of My plan, as now; `/pages/start` keeps its no-email setting |
| Reminders | My plan, as now (iPhone: My data) |
| Where to keep the record | Top bar, plus the plan panel for guests |
| Delete all my data | My data › Your record |
| Send feedback | Foot of My plan, beside Supercharge |
| Supercharge this tool | Foot of My plan (B3) |
| Chat edit lands on a pre-filled cell (US-16 AC2) | Opens the value page's Add sheet, pre-filled |
| Email auto-focus jump to plan | Switches to My plan, as now |

## What we track

- **Usage signal** for the new story, in `product_events`, on Shopify only (Pages sends
  none):
  - `tool_opened` with `phone` or `desktop`, once per tab. This is new and ships in
    phase 0, on the old layout, so the baseline exists before anything changes. It is
    the denominator.
  - `onboarding_step` with the step's name, never the value. The widget throttles
    events once per name per tab (`server-api.ts`), which would keep only the first
    step. So the throttle key includes the step name, like `upload_outcome`'s exception
    (`PER_ACTION_EVENT_NAMES`), with a test that four steps in one tab all arrive
    (Codex R3);
  - `onboarding_done`;
  - `signin_opened` with its placement;
  - `guide_opened` `plan_footer`.
  - Every new name and value goes into the server's closed list first, and the server
    deploys before the widget.
- **Clarity masking.** Onboarding, value pages and sheets that render outside the
  widget root carry `data-clarity-mask`, as the lightbox, chat and upload modal do
  (US-09 AC8).
- **Baseline before anything ships.** These come from `metrics.csv` and Clarity:
  - mobile stage reached and `results_viewed`;
  - `cloud_connect_success` (5 to 19 a week);
  - guide opens;
  - the iPhone/Android split.

## How we roll it out

- **Localhost first.** Each phase is built against `npm run dev:pages` (port 5173) and
  shown in the browser pane at phone width. Brad and I iterate there.
- **Then straight to production** (Brad, 2026-10-31). A deploy updates every page that
  carries the block: the homepage, /pages/roadmap and /pages/start. A hidden page would
  only isolate the new layout if old and new both shipped behind a switch, which means
  two layouts in the code for weeks. With CLAUDE.md's "production is the acceptance
  environment" and low traffic, shipping straight is the better trade.
- **Making that safer:**
  - small phases, each deployed alone, so a bad one is one revert;
  - real WebKit (`tools/webkit-verify.mjs`) and Brad's phone on the live page minutes
    after each deploy, since the theme CSS only shows live;
  - **the live theme's CSS on localhost is the key check** (Brad, 2026-10-31). Phase 1
    starts by loading drstanfield.com's theme stylesheets into the localhost page, with
    the same wrapper markup the block sits in, so collisions like `div:empty` show
    before a deploy. If a theme rule cannot be reproduced locally, WebKit on the live
    page still catches it after.
  - Sentry and Clarity watched for the first day after each phase.
- **No A/B test.** No variant delivery exists today, and cloud connects run at 5 to 19 a
  week, too few to power one. Instead: a before-and-after read over two weeks either
  side. The primary metric is the share of phone `tool_opened` tabs that go on to
  `results_viewed`. `tool_opened` ships first, on the old layout, so the "before"
  exists.
- **Pages** gets the new layout in the same build. Its hero is a separate copy in
  `index.html`.
- **No switch, no `.hr-v2` scoping class.** Without a hidden page, the old styles are
  replaced, not kept beside the new. Rollback is a git revert.
- **Size.** The goal is a net fall in production lines: Swiper, the mobile half of the
  grid CSS and the replaced styles all go. Measured per phase.

## Phases

0. **Decisions and baseline.** Brad answers the calls below. Ship `tool_opened` on the
   old layout and collect two weeks (the later phases build on localhost meanwhile). Write
   the new story and the AC changes to US-01, US-02, US-04, US-09, US-11, US-15, US-16,
   US-18, US-20, US-21, US-22 AC13, US-23, US-25 AC3, US-38 and US-44.
1. **Tokens, greens, the top bar and the Supercharge card.**
2. **The new form order** (height and weight, sex, birth date) with tiles appearing as
   answers land. Clinical three-file rule applies.
3. **Mobile shell:** bottom tab bar, Swiper deleted, About you low, compact hero.
4. **My data rows, value pages and "Edit as table".**
5. **Before-and-after read.**

Every phase follows the same steps:

- story ACs first;
- tests rewritten in the same commit;
- /simplify;
- adversary and Codex, for anything touching storage, sign-in or saving;
- `test:all`;
- deploy to production, then WebKit and Brad's phone on the live page.

## Calls for Brad

Decided 2026-10-31: Sign in in Supercharge's spot, labelled "Sign in"; Supercharge to
the foot of My plan; the form as onboarding in the new order, with visible why-text;
the engine changed to work without sex; tab bar with Swiper removed; plan cards
unchanged; localhost (with the live theme CSS) then production; #00a38b brand plus
#008270 under white text, and the iPhone moves to #008270 too; lab rows with target ·
date and was · unit, plus "All results as a table".

- **B4. Phone hero.** Compact always, about 120px (recommended), or keep today's 371px.
- **B9. A child and the step-1 BMI tile.** Show the number with "adult ranges" until the
  birth date arrives (recommended); or ask birth date before showing BMI.
- **B8. Dark mode.** Later (recommended).

## Review

Draft 1 went to a fresh Opus adversary (2026-10-30). Draft 2 accepts its five blocking
findings:

- R1: onboarding would have saved each answer as given, and on a new phone those
  answers could overwrite the cloud record. Now nothing is written until the last answer,
  with the sign-in path offered first.
- R2: draft 1 had Skips, which Brad ruled out on iOS. Now every answer is required.
- R3: the A/B machinery does not exist, and traffic is too thin. Now a before-and-after
  read.
- R4: the bar ignored the reconnect and changes-waiting states. Now it has four states
  from `storageState()`.
- R5: a fixed tab bar would have floated over the Shopify homepage. Now it is sticky
  inside the widget.

It also accepts these should-fix findings:

- R6: the hero.
- R7: phase order and the scoping class.
- R8: the control inventory.
- R9: Supercharge as Brad's call, keeping its name, and the server-first deploy.
- R10: the sign-in wording costs.
- R11: masking and events.
- R12: contrast and accessibility.
- R13: Pages.
- R14: erase and re-answering.
- R16, R17: the Swiper leftovers and the full story list.

Codex (gpt-6.1-sol) then reviewed draft 2 and found three more problems. Draft 3 fixes
them:

- R1: the onboarding rule skipped half-finished records. It is now one ordered rule
  built on what the record lacks.
- R2: the primary metric would have looked better as more people gave up. It now uses
  a denominator counted before onboarding starts.
- R3: the event throttle would have kept only the first step. The throttle key now
  includes the step name.

R4 asked for this change's size: the plan is a doc, so net production LOC is 0 and
nothing was deleted.
