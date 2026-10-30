# Web app redesign to match the iPhone app: plan (draft 3, 2026-10-30)

Brad asked for this after using the iPhone app. Beside it, the web app looks shabby,
especially on a phone. He wants:

- the mobile web to look like the iPhone app;
- a sign-in button where "Supercharge this tool" sits now, and a new home for that link;
- Starting info at the bottom once it is filled in;
- better onboarding.

Nothing is built yet. Draft 1 went to a fresh Opus adversary, which found five
blockers, and Codex reviewed draft 2. This draft fixes both; see "Review" at the
end.

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

### 1. One design language, behind one scoping class

- Take the iPhone's values for the web:
  - the light grey background;
  - white cards with 20px corners;
  - the system font;
  - section symbols as inline SVG;
  - status capsules on the tiles.
- New styles live under one class (`.hr-v2`) on the widget root, so old and new run
  side by side behind the switch. The old CSS is deleted only when the switch goes away.
- **Contrast is a requirement, not a copy.** The iPhone's grey secondary text is about
  3.4:1 on white and fails, so the web keeps a darker grey, about #5a6b73 (4.97:1).
  Every text and background pair must reach 4.5:1 on both white and grey. That
  includes the capsules, whose text gets a deeper colour than its tint.
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

### 4. Onboarding, before the layout moves

This comes before the mobile shell, because About you can only sit low once onboarding
asks for it.

**Who sees it.** One rule, checked in this order (Codex R1):

1. An email arrival shows its US-22 notice first. Onboarding waits until it is
   dismissed.
2. A cloud that is connected but cannot be read yet (reconnect, or still loading) asks
   nothing. It shows the reconnect state and waits. Questions never start from a record
   we have not read.
3. Once the record is open, onboarding runs if the record lacks sex, birth year or
   height, or weight on a record with no weight at all. It asks only what is missing,
   starting at the first gap. That holds for a new browser, a half-finished one and a
   connected cloud record alike.
4. A record that has all of them skips onboarding.
5. After "Delete all my data", the record is empty again, so rule 3 runs the
   questions, on this device and on any other once the higher erase count arrives (US-54
   AC7). A connected cloud stays connected. A completion flag in localStorage, keyed to
   the erase count, only stops the tour from showing twice. It never goes in the
   record.

**Welcome.**

- **"I already have a record: sign in"** comes first and is prominent.
- It runs the picker, then waits until the cloud record has opened. Then it asks only
  for what is missing (the US-54 AC2 rule).
- "Get started" sits beside it.

**Questions:** sex, birth month and year, height, weight. Each has a progress bar and
Back.

- **Every question is required. No Skip**, as on the iPhone. Weight unlocks stage 3,
  and without it half of My data stays hidden.
- Native HTML inputs and selects. No wheel pickers, which feel wrong on Android.

**Nothing is written until the last answer** (fixes R1). The answers stay in memory.

- On the last step, before saving, the screen repeats one line: "Already have a record
  in Dropbox or Google Drive? Sign in instead."
- Then all four answers go through the existing routes in one save. The profile goes
  through its edit, and weight through the matrix-save rule (one active row per day).
- This narrows, but cannot remove, the risk that a returning person types new answers
  and then connects their old cloud. Newest wins, field by field. The same risk exists
  today with the form and on the iPhone.

**After the plan appears:** a three-tip tour in the iPhone's words (US-57). It can be
dismissed.

**Desktop:** keeps the progressive form for now (B6).

### 5. The mobile web becomes the iPhone layout

**A bottom tab bar** with My data, My plan and Chat.

- It is sticky inside the widget and shows only while the widget is on screen
  (IntersectionObserver). It must not float over the rest of the Shopify homepage.
- It replaces the fixed "See Your Personalized Plan" button.
- It replaces the Swiper with plain tab switching. That removes the sideways pan, the
  Swiper dependency, `styles.css` 231-250, `ResultsPanel`'s `onLayoutChange` prop and
  `HealthTool.swiper.test.tsx`. Only `HealthTool.tsx` uses Swiper.
- Each tab keeps its own scroll position.
- Tab semantics: `role="tablist"`, arrow keys, `aria-selected`.

**My data:** the iPhone's sections and order, as grouped cards, with About you low.

- Vitals and blood tests become rows showing name, latest value, date and status.
- A row opens the value's page (chart, history, add a value), built on today's history
  panel.
- The blood-test matrix stays on desktop. On a phone it is "Edit as table", for typing
  in a whole lab report.

**My plan:**

- Two-column tiles, one column at large text sizes.
- Cards with a title and two lines that expand on tap, with `aria-expanded`.

**Chat:** unchanged inside, restyled.

**A "+" on My data** for adding values and uploading a lab report, as on the iPhone.

**Every web-only control gets a home.** The inventory is below. Nothing is dropped
without a decision.

**Hero on a phone:** see B4. The hero renders before JavaScript, so hiding it on return
visits from JavaScript would make the page jump. Recommended: one compact hero on
phones, always, with a small photo and the headline on one row (about 120px). It needs
no JavaScript, and the page does not jump.

### 6. Desktop

Desktop keeps its two or three columns. It gets the tokens, the top bar, the tiles, the
plan cards and the Supercharge card. Desktop works today and gives most of the guide
opens, so it changes look, not structure.

## Where every current control goes (mobile)

| Control today | New home |
|---|---|
| Sex, height, birth date, units (Starting info) | Onboarding, then My data › About you (low) |
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
- **Then a hidden Shopify page.** A block setting, like US-44's `skip_email_gate`, turns
  `.hr-v2` on for one page. Its SEO setting keeps it out of the sitemap. This is where
  the theme CSS shows up, and Brad checks it on his phone. Real WebKit
  (`tools/webkit-verify.mjs`) runs on it too.
- **No A/B test** (draft 1 was wrong). No variant delivery exists today: the Liquid
  assigns none and no widget code reads one. Cloud connects run at 5 to 19 a week, too
  few to power a test. Instead: a before-and-after read over two weeks either side,
  plus Brad's own check. The primary metric is the share of phone `tool_opened` tabs
  that go on to `results_viewed`. The denominator is counted before onboarding starts,
  so people who give up part way still count (Codex R2). Stage 3 cannot be the metric:
  onboarding requires weight, so everyone who sees a plan would reach it.
- **Pages.** It gets the new layout when Shopify does, through a build flag. Its hero is
  a separate copy in `index.html`.
- **Rollback.** Until the old code is deleted, rollback means turning the block setting
  off. After deletion, it is a git revert.
- **Size.** The goal is a net fall in production lines. The Swiper code and the mobile
  half of the matrix CSS go, and new styles replace old ones rather than sit beside them.
  I will measure it per phase rather than guess now.

## Phases

0. **Decisions and baseline.** Brad answers the calls below. Ship `tool_opened` on the
   old layout and collect two weeks. Write
   the new story and the AC changes to US-01, US-02, US-04, US-09, US-11, US-15, US-16,
   US-18, US-20, US-21, US-22 AC13, US-23, US-25 AC3, US-38 and US-44.
1. **Tokens, the top bar and the Supercharge card.** Behind `.hr-v2`.
2. **Onboarding.**
3. **Mobile shell:** bottom tab bar, no Swiper, My plan cards and tiles, About you low.
4. **My data rows, value pages and "Edit as table".**
5. **Before-and-after read, switch on for everyone, delete the old layout.**

Every phase follows the same steps:

- story ACs first;
- tests rewritten in the same commit;
- /simplify;
- adversary and Codex, for anything touching storage, sign-in or saving;
- `test:all`;
- WebKit;
- deploy behind the switch, and Brad checks it on the hidden page.

## Calls for Brad

- **B1. Which green.** The web's #00a38b, or the iPhone's #0B7A55 (#33D18F dark)?
  - Recommendation: the iPhone's. One brand, and white text on #00a38b fails contrast
    today.
  - Cost: the storefront theme around the tool may use #00a38b, so the tool's buttons
    would be a shade darker than the theme's.
- **B2. The bar's word for a guest.**
  - Recommendation: "Sign in". It is what a returning person looks for.
  - Its costs:
    - a guest who never saved to a cloud may tap it expecting their plan. The picker's
      first line answers that.
    - "Sign in" hints at an account, though US-01 AC4 promises the tool works with
      none.
    - the storefront theme may already have its own account login. I will check that
      on the live page.
  - Alternatives: "Open my record", or "Save & sync".
- **B3. Supercharge.** Foot of My plan, with its name kept (recommended); or also in the
  sign-in sheet (not recommended, because of the privacy wording); or keep the desktop
  header button beside the bar.
- **B4. The hero on a phone.** A compact hero always (recommended: no jump, no
  JavaScript); or the full hero on first visit and none after (the page jumps on return
  visits).
- **B5. The blood-test matrix on a phone.** Rows that open a value page, with "Edit as
  table" (recommended); or keep the matrix as it is.
- **B6. Onboarding on desktop.** Phone first, then decide from the results
  (recommended); or both at once.
- **B7. Rollout.** A hidden page and a before-and-after read (recommended); or build A/B
  variant delivery first (more work, and too little traffic to power it).
- **B8. Dark mode.** Later (recommended), or in phase 1.

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
