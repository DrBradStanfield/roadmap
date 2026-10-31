# Web app redesign to match the iPhone app: plan (draft 5, 2026-10-31)

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
  and wants the previous value visible. Decided: target · date on the left, trend line,
  value with the previous one in brackets and the unit under it (section 5).
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
  - #00a38b: the brand, for non-text marks only: logo, chart lines, tile edges, fills
    with dark labels. As text it fails on the grey page (2.85:1, adversary R7).
  - **#007C6A**, the same hue made deeper, for every green text, link and white-label
    button: 5.13:1 under white text and 4.6:1 on the #F2F2F7 grey. Draft 4's #008270
    passed on white but fell to 4.25:1 on grey.
  - The iPhone's #0B7A55 is a greener, different hue. Matching the web to it would move
    the brand off the scrubs. The better fix is the other way: give the iPhone #007C6A
    too, so both apps share one pair (B1).
  - For reference, the store's email pop-up already uses a darker green
    (#157551, measured live), so a deeper shade beside #00a38b is not new to the site.
- Dark mode: the tokens get a second set of values later. Light ships first, because
  the Shopify theme around the widget is light.

### 2. The top bar and "Sign in"

A slim bar sits at the top of the widget. The label on its right comes from
`storageState()` (guest, connected, reconnect) plus `pendingSync` for "Saving…", so it never claims what is not true:

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
- Each answer saves (weight on leaving its field; see below). Each new tile appears in
  My plan as soon as it can be worked out, and on phones the plan tab shows a small dot so the
  person knows something new arrived.
- **Every step is required, no Skip**, the iPhone's rule. The rest of the form opens
  only after step 3.
- **Resume at the first missing answer** (Codex R1). Someone who saves height and weight
  and then leaves comes back to the sex question. Tests: reload after step 1 and after
  step 2.

**What this changes underneath** (adversary R1–R4, draft 5):

- **The stage rule.** Today any plausible weight, typed or saved, opens stage 3
  (`mappings.ts` 579), so step 1 would open the whole form, unmute the chat and the
  microvitamin.com chatbot embed (US-15 AC10, `chatbot-embed.tsx`), and start the email
  glow. `computeFormStage` is redefined from what the record lacks: stage 1 asks
  height and weight; stage 2 sex; stage 3 birth date; the full form, the chat and the
  embed open only when all four are known. A saved blood test still opens the full
  form, with the missing profile questions pinned at the top. Re-pin
  `mappings.test.ts`, US-01 AC1/AC3, US-15 AC10 and the §10 table.
- **Weight saves when the person leaves the field**, using the grid's existing
  commit-on-leave and its one-active-row-per-day rule. Today weight is longitudinal
  and waits for "Save New Values" (`StartingInfoVitals.tsx` 477-499), so a step-1
  weight would be lost on leaving the page. Height, sex and birth date already save
  as typed.
- **The engine change, aimed at the right places.** `calculateHealthResults` already
  returns without sex; the real gates are the Zod schema (`validation.ts` 31, used by
  `chat-context.ts`), the widget (`HealthTool.tsx` 772, 787) and `plan.ts` 236-243,
  which throws `PlanError` asking the agent for sex. Once sex can be missing, these
  quietly give wrong answers and the compiler will not catch them:
  - `calculateIBW` falls to the female target (`calculations.ts` 15);
  - `calculateEGFR` takes the male branch (89-97);
  - the HDL card uses the female threshold and says "for women" (`suggestions.ts` 656, 663);
  - the protein-target card always renders (`suggestions.ts` 248-256), so it would read
    "undefinedg";
  - `statTiles` always pushes the IBW and protein tiles (123-136).
  Each one gets an explicit "needs sex" gate and a test with `sex: undefined` that fails
  today. **`withLabEgfr` too** (`plan.ts` 160-168; whole-tree Codex review, 2026-10-31): it
  drops a lab eGFR whenever a newer creatinine and a birth year exist, without asking
  for sex. With sex missing, the calculated eGFR is then gated off, so the person
  loses both (US-07 AC7). A calculated eGFR may only outrank the lab's once sex is
  usable; regression test: no sex, an older lab eGFR, a newer creatinine, and the lab
  eGFR is kept. Callers to update: `stat-tiles.ts`, `suggestions.ts`, `plan.ts` and its
  PlanError hint, `NO_PLAN_CHAT_RULE` (US-15 AC36), `tools/get-plan.ts`,
  `ios/engine/bridge-contract.json` and Swift's `.needsDetails` mapping
  (`HealthEngine.swift` 151), plus a rebuilt iPhone engine and Brad's signed engine
  update. Adversary and Codex review it, since it is clinical and changes what agents
  read.
- **Three-file scope.** Beyond §10 it touches algorithm §1 (IBW, protein always
  present), §3 (HDL by sex), §4 (the always-shown protein row and the "Unknown (no
  birth year)" row, 621-623) and `roadmap_text.html` 546 (eGFR "uses ... your age and
  sex"). `evidence.ts` likely unchanged; the commit says why.
- **Children (B9).** Today a child can already get the full adult plan, because birth
  date is optional and weight opens everything. The new order is safer: it requires
  birth date before the plan's cards. Until step 3, only the BMI, healthy-weight and
  protein tiles show, labelled "adult ranges"; the suggestion cards (alcohol at BMI 30
  and the rest) wait for the birth date. A known minor then gets today's handling.
- A returning person on a new device who answers before tapping Sign in: weight is a
  new dated reading, which is right. Height, sex and now birth date (required, where
  today it was optional) follow newest-wins (`merge.ts` 813), so typed values replace
  stored ones. That is today's behaviour, now with one more field exposed.

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
    (`HealthTool.tsx` around 838-856, 1141, 1232; lines drift, find by name);
  - the `<Swiper>`/`<SwiperSlide>` block (around 1263-1292), replaced by three panels
    where only the active one renders visibly;
  - `ResultsPanel`'s `onLayoutChange` prop, which exists only to re-measure Swiper, and
    the source-string assertion on it in `ResultsPanel.skip-gate.test.tsx` 252-265;
  - `styles.css` 231-250, the chat-slide autoHeight rule (4546-4552) and the Swiper
    comments near 4750 and 4936; `HealthTool.swiper.test.tsx`, replaced by a tab test;
  - `MobileTabBar.tsx` (the top tabs) and the Liquid skeleton's top tab bar
    (`hr-skel-tabbar` in `app-block.liquid`), which moves to the bottom so first paint
    does not shift (adversary R13);
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
    pressure, weight and waist targets come from the plan (`StartingInfoVitals`), and
    catalogue tests carry their own printed `referenceLow`/`referenceHigh`. So one
    health-core function, `rowTarget(metric, unit, grading, plan)`, gathers all four
    sources, and the minor rule moves into it from the widget's `cellHint`
    (`blood-test-cell.ts` 41-44). The web grid, the new rows and the iPhone all call it;
  - the target carries no unit, since the unit shows on the right: `RefHint` gains a
    unit-free field rather than trimming strings ("Normal: <5.7%" has no space before
    its unit). Before sex is known, the combined hint ("Optimal: >1.0/>1.3") is sized
    for 375px too (adversary R6);
  - middle: the trend line, as the iPhone draws it now;
  - right: the latest value with the previous one in brackets, smaller and grey,
    and the unit under it: **"81 (74)" / "mg/dL"** (Brad, 2026-10-31, replacing "was").
    A first result shows the value alone. Screen readers hear "81, previous 74", since
    brackets alone say nothing out loud.
  - A known minor loses only the adult targets, as today. **The waist target stays**,
    because waist-to-height applies to children too (US-07 AC6; Codex R3). A row with
    no target (PSA, eGFR, which is derived, and any catalogue test printed without a
    range) shows just the date.
- Tapping a row opens the value's page: chart, full history, add a value, correct one.
  It is built on today's history panel. **Its Add keeps the one-active-row-per-day
  rule**: a second value on a day that already has one becomes a correction or is
  refused, exactly as the grid's `expected` slots do today (adversary R10).
- Row and capsule status classes join US-09 AC7d's Sentry breadcrumb scrub list, or a
  tap on a row would leak its grade (adversary R12).
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
| Blood-test matrix, additional blood tests | My data › Blood tests rows; "All results as a table" for both |
| Corrections (US-04, US-21 AC5) | Value page history row › Correct |
| Move a test to another day (shipped 29 Oct) | "All results as a table" date header, as now |
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
    step. So the throttle key adds the step as a detail suffix, the way `choice` and
    `product` events do, so each step counts once per tab. Not `PER_ACTION_EVENT_NAMES`,
    which skips the throttle and would count a re-answered step twice (adversary N3).
    A test checks three steps in one tab all arrive (Codex R3);
  - `onboarding_done`;
  - `signin_opened` with its placement;
  - `guide_opened` `plan_footer`.
  - Every new name, metadata key (`tool_opened`'s device, `onboarding_step`'s step) and
    placement goes into the server's closed list. **CI deploys the widget before the
    server** (`deploy.yml` 282-292 before 300-310), so the server change ships in its
    own PR and deploy first, and the widget that sends the events ships in a later
    one (adversary R5).
- **`results_viewed` is pinned before the baseline** (adversary R9). Today it fires when
  ResultsPanel mounts with suggestions, and all three Swiper slides mount, so it fires
  without the plan being seen. Phase 0 changes it to fire when the plan is actually on
  screen (the plan tab or column visible), on the old layout, so before and after
  count the same thing.
- **Clarity masking.** Onboarding, value pages and sheets that render outside the
  widget root carry `data-clarity-mask`, as the lightbox, chat and upload modal do
  (US-09 AC8).
- **Baseline before anything ships.** These come from `metrics.csv` and Clarity:
  - mobile stage reached and `results_viewed`;
  - `cloud_connect_success` (5 to 19 a week);
  - guide opens;
  - the iPhone/Android split.

## How we roll it out

- **Localhost first, as close to Shopify as we can get** (adversary R8). `dev:pages` is
  the Pages build, which lacks the email box, Save as PDF gating, the feedback form and
  the US-61 product blocks, all controls this plan moves. So phase 1 adds a localhost
  entry built with `VITE_SHOPIFY_SURFACE` and a stubbed app proxy (never `shopify app
  dev`). Brad and I iterate there at phone width.
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
    before a deploy. It is partial: the theme's inline section styles, settings
    variables and script-injected styles will not all come across, so WebKit on the
    live page still checks after.
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

0. **Decisions and baseline.** First a server-only PR adds the new event names and keys,
   and deploys. Then a widget PR ships `tool_opened` and the pinned `results_viewed` on
   the old layout; two weeks of baseline follow while later phases build on localhost.
   Write the new story and the AC changes to US-01, US-02, US-03, US-04, US-05, US-06,
   US-07 (AC6 and the plan without sex), US-08, US-09 (AC7d), US-11, US-12, US-13,
   US-14, US-15 (AC10, AC36), US-16, US-18, US-19, US-20, US-21, US-22 AC13, US-23,
   US-25 AC3, US-30 and US-32 (`get_plan` stops refusing a record without sex),
   US-38 and US-44 (adversary R11).
1. **Tokens, greens, the top bar and the Supercharge card.**
2. **The engine works without sex**, each sex-dependent output gated and tested, then
   **the new form order** with tiles appearing as answers land. Clinical three-file
   rule, adversary and Codex; the iPhone engine is rebuilt and Brad signs the update.
3. **Mobile shell:** bottom tab bar, Swiper deleted, About you low. (The compact hero
   shipped on its own: PR 387, live 2026-10-31.)
4. **My data rows (`rowTarget`), value pages and "All results as a table".**
5. **Before-and-after read.**

Every phase follows the same steps:

- story ACs first;
- tests rewritten in the same commit;
- /simplify;
- adversary and Codex, for anything touching storage, sign-in or saving;
- `test:all`;
- each phase is its own worktree branch and PR (CLAUDE.md, 2026-10-31);
- deploy to production, then WebKit and Brad's phone on the live page.

## Calls for Brad

Decided 2026-10-31: Sign in in Supercharge's spot, labelled "Sign in"; Supercharge to
the foot of My plan; the form as onboarding in the new order, with visible why-text;
the engine changed to work without sex; tab bar with Swiper removed; plan cards
unchanged; localhost (with the live theme CSS) then production; #00a38b brand plus
#007C6A (draft 5; was #008270) for green text and white-label buttons, and the iPhone moves to it too; lab rows with target ·
date, the previous value in brackets and the unit under it, plus "All results as a
table"; the compact phone hero (live).

- **B9. Children before the birth date.** Until step 3, show only the BMI, healthy-weight
  and protein tiles, labelled "adult ranges", and hold the suggestion cards until the
  birth date arrives (recommended); or ask birth date first, before any tile.
- **B10. Weight saving.** Save the step-1 weight when the person leaves the field
  (recommended: it uses the grid's existing commit-on-leave and day rule); or keep an
  explicit Add button.
- **B8. Dark mode.** Later (recommended).

## Review

Draft 1 went to a fresh Opus adversary (2026-10-30). Draft 2 accepts its five blocking
findings:

- R1: onboarding would have saved each answer as given, and on a new phone those
  answers could overwrite the cloud record. Draft 3 wrote nothing until the last
  answer. Brad's draft-4 decision (the form as onboarding, no sign-in step) replaced
  that; the newest-wins exposure is stated in section 4.
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

Draft 4 (Brad's answers) went to a fresh Opus adversary and to Codex on 2026-10-31.
Draft 5 accepts all of it:

- Codex R1: resume at the first missing answer. Codex R2: every target the web shows
  today survives (`rowTarget`). Codex R3: the waist target stays for children.
- Adversary R1 (blocking): weight opened the full form. The stage rule is redefined
  from what the record lacks.
- Adversary R2 (blocking): the engine change was aimed at the wrong function and would
  have given silent wrong answers (female IBW, male eGFR, "undefinedg" protein). Each
  sex-dependent output is now gated and tested.
- R3 three-file scope and B9 reframed; R4 weight saves on leaving its field; R5 the
  server deploys in its own PR first; R6 `rowTarget` sources and a unit-free hint
  field; R7 #007C6A replaces #008270; R8 a Shopify-surface localhost entry; R9
  `results_viewed` pinned; R10 the Add sheet keeps the day rule; R11 the story list;
  R12 the Sentry scrub; R13 the Swiper and skeleton leftovers; N1-N6 folded in.
