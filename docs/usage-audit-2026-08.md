# Usage Audit — August 2026

First systematic look at how the Health Roadmap tool is actually used. Data pulled 2026-08-06 from Microsoft Clarity (both stores), Sentry, Supabase (chat / A/B / reminders), Klaviyo, and the feedback-email inbox. This doc feeds the user-story catalogue and the test-hardening priorities; the weekly product-health loop keeps it fresh.

**Known blind spots of this audit** (motivating the funnel-events work): Clarity's MCP window is the last ~3 days only; there are no first-party product events, so form-start→save→cloud-connect→lab-upload conversion is invisible; feedback lives only in email; Sentry has no user tagging.

---

## 1. Traffic & engagement (Clarity, 2026-08-04 → 08-06)

### drstanfield.com (education store — where the tool lives)
- **3,338 sessions / 3,052 unique users** in 3 days. Top pages: homepage (302), supplement blog articles (amla 199, nattokinase 123, boron 102…), **`/pages/roadmap` #4 with 116 sessions (~3.5% of traffic)**.
- Roadmap-page device split: PC 65 (56%), Mobile 42 (36%), Tablet 11. **Returning PC users average 12.7 min on the tool** (new PC: 7.4 min; new mobile: 2.6 min). The tool has a genuinely engaged core audience; mobile engagement is much shallower.
- Friction counters on `/pages/roadmap*`: **73 dead clicks, 7 rage clicks, 4 quickbacks**; average scroll depth 72%.

### microvitamin.com (commerce store)
- 1,364 sessions / 1,206 users in 3 days, all on product/blog pages. **`/pages/roadmap`: 0 sessions, 0 users.** The roadmap + chat embeds still on this storefront (the known post-§12-split leftover) serve nobody.

### Session recordings (all 15 roadmap sessions in the window, sorted by duration)
Every matched session ran 23–69 minutes — visitors who reach the tool tend to stay. 6/15 (40%) show dead clicks; zero rage clicks in the recordings. Two hard clusters:

1. **Blood-pressure input** — dead clicks on the `▫▫▫/? mmHg` field and the `mmHg` unit label in **3 separate sessions**, each time followed by a successful click on retry. Hit-target or overlay problem on that control.
2. **Info tooltips (ⓘ)** — dead clicks on "Birth Month ⓘ", "Used to calculate age-based…", "Where should your health…", and the Starting Info units picker in **4 sessions**. Users expect the tooltips/labels to be tappable.
3. One-off but important: a dead click on `#upCartStickyButton` — **a cart/upsell app element overlapping the roadmap form** on drstanfield.com.

Conversion-shaped moments captured on video: a full form fill → **"Save to your cloud" → Dropbox** ([watch](https://clarity.microsoft.com/player/vj1f8ywkt0/4ssfj7/1w3n1xy)); a 60-click full completion incl. chat query "ACC/AHA" ([watch](https://clarity.microsoft.com/player/vj1f8ywkt0/1jdt6s0/bkt7ay)); "Get My Health Plan" completion ([watch](https://clarity.microsoft.com/player/vj1f8ywkt0/4ssfj7/12o1ouc)); email capture submit ([watch](https://clarity.microsoft.com/player/vj1f8ywkt0/1bjfbra/jm1jci)).

Also notable: ~5 sessions sat 35–50 min on the roadmap page with zero clicks and low active-time — mostly backgrounded tabs, but [this one](https://clarity.microsoft.com/player/vj1f8ywkt0/1m6br41/1xkleaa) had 45 min *active* with no clicks (and a suspicious LCP) — worth one watch to rule out a stuck widget state.

Entry paths: 10/15 landed directly on `/pages/roadmap` (several via Google organic), 5/15 arrived from blog articles via the "Build my free plan" CTA. 14/15 *ended* on the roadmap page — the tool is a destination, not a bounce point. **Blog → CTA → tool is the working funnel.**

---

## 2. Errors (Sentry, last 90 days)

One commingled project (`dr-brad-inc/javascript-remix`) holds widget + both servers. Top signal:

| Issue | Events | Read |
|---|---|---|
| `@shopify/events` module-specifier TypeError + 3 `parseModule` siblings | ~220 combined, daily since 2026-06-24 | First seen exactly at the §12 domain-split cutover. Almost certainly the storefront **theme's** script, not widget code — confirm ownership before spending fix time ([issue](https://dr-brad-inc.sentry.io/issues/7571150649/)) |
| `SyntaxError: JSON.parse … at /en-pl/pages/roadmap` | 3 | **Locale-prefixed roadmap path** — suggests an app-proxy fetch returns HTML/empty under `/en-pl/…`. Small volume but a real broken-experience signal for non-English visitors ([issue](https://dr-brad-inc.sentry.io/issues/7600858482/)) |
| `Error: Chat: Could not load health data` | 4 | Local-first chat context load failing for someone — core-path failure, low volume ([issue](https://dr-brad-inc.sentry.io/issues/7563968375/)) |
| Site-chat side-bundle: `IntersectionObserver` missing, stylesheet append timeout, cross-origin stylesheet | 1–2 each | Old-browser + theme CSS-race noise |

**Hygiene gaps:** every issue shows `users: 0` (no `Sentry.setUser`/anonymous id attached, so impact per issue is unmeasurable), and widget vs server events can't be separated. Cheap fixes: tag events with an anonymous visitor id + a `surface` tag.

---

## 3. Chatbot (Supabase, all-time unless noted)

- **926 messages, 286 conversations** total; roughly 30–100 messages/week over the last 12 weeks; **65 conversations active in the last 30 days**. Modest but steady.
- **Zero conversations join to a profile with a `shopify_customer_id`** — either logged-in-customer chat linkage is broken or no customer has ever chatted while recognized. Worth a one-off investigation.
- Router last 30 days: 97 events — ROUTE 68, PRODUCT 19, GREETING 6, ACCOUNT 3, ERROR 1; **matched 50 vs unmatched 47 (~48% unmatched)**.
- Themes from the 150 most recent user messages: BP/heart-rate targets & meds (~18), **purchasing/shipping/subscription support (~17 — users treat the chatbot as customer support)**, supplement-stack advice (~14), weight/protein/exercise (~10), lipids/ApoB/Lp(a) (~9), COA/quality skepticism (~9), MicroVitamin+ powder usage (~8), supplement–medication interactions (~8), lab interpretation (~8), chronic-condition personalization (~6), plus ~19 greetings/off-topic/spam.
- Representative: *"The plan says I need to eat 102 grams of protein a day. This seems unrealistic to me… How can I safely reach the protein goal?"* / *"I have one variant of APOE4… how much total omega 3 should I take?"*

Implications: interaction-checker and condition-personalization demand shows up here **and** in feedback emails (below); support-type questions (~17%) validate the chatbot-email-capture idea for redirecting support traffic.

---

## 4. Email capture, A/B, reminders

- **Klaviyo**: microvitamin list 857 profiles; drstanfield list 39 (new since the June split).
- **A/B**: "Subheading" test has been **running unattended since 2026-04-09**: A 243/5,290 (4.59%) vs B 219/5,691 (3.85%) — a large sample where A leads; roughly z≈1.9, right at the edge of significance. Decide and complete it. (Completed tests: "email helper" A 4.23% beat B 2.69%; "heading test" logged almost nothing.)
- **Reminders v2**: **2 opt-ins ever** (both google-drive). The feature is effectively unused — discoverability problem or genuinely unwanted; needs a deliberate decision before any more engineering goes into it.
- Profiles table: 1,307 total, 511 created in the last 90 days (chat/guest anchors).

---

## 5. Feedback inbox (all 9 threads, Feb–May 2026)

| Date | Theme | Status |
|---|---|---|
| 2026-05-01 | **Privacy concern** — "not sure how protected my health information is" | v2 local-first is the answer; messaging opportunity on-page |
| 2026-04-13 | Order/shipping support (×2 in thread) — feedback form used as store support | Recurring: users can't find a support channel |
| 2026-03-25 | Feature ask: omega-3/6 ratio in risk calc | Declined (no guideline basis) — good precedent reply |
| 2026-03-22 | **Bug: blood-test values appearing under wrong date** (Mar 16 dates user never entered) | Brad fixed by hand in v1 DB; root cause never found — date-defaulting in save path deserves a test |
| 2026-03-16 | Positive feedback | — |
| 2026-03-16 | **Guest "email me my results" never arrived** | v1-era path since replaced by Klaviyo + client PDF; verify the current path end-to-end |
| 2026-03-06 | **Bug: LDL without Total Cholesterol → no recommendation** (+3 more points) | Fixed per reply |
| 2026-03-06 | Confusion: placeholder hints read as saved values (ApoB/Lp(a)) | Fixed per reply |
| 2026-02-22 | Feature ask: medication/supplement **interaction checker** | Echoed by ~8 chat interaction questions |

Meta-finding: 9 feedback emails in ~6 months, several containing real bugs — but none became regression tests, and none are queryable. Hence the `feedback_submissions` table.

---

## 6. Prioritized backlog (top 10)

1. **Fix the blood-pressure input dead-click friction** — 3 of 15 recorded sessions fought the `mmHg` control. Inspect hit-target/overlay; verify on live site + WebKit.
2. **Make ⓘ tooltips reliably tappable** (Birth Month, age-based, units picker) — 4 sessions of dead clicks on info affordances.
3. **Remove the upCart sticky button overlap** on the drstanfield roadmap page (theme/app conflict intercepting form clicks).
4. **Investigate `/en-pl/pages/roadmap`** — locale-prefixed paths appear to break an app-proxy fetch (JSON.parse on HTML). Check `PROXY_PATH` behavior under locale prefixes.
5. **Complete the stale Subheading A/B test** (4 months running; A ahead at the edge of significance) and ship the winner.
6. **Clean up microvitamin.com embeds** — 0 roadmap sessions in the sample; the pending post-split cleanup is confirmed safe to do.
7. **Chatbot: cut the ~48% unmatched-router rate and handle support-type queries** (~17% of volume) — route store/support questions to the email-capture path; investigate why zero conversations link to a Shopify customer id.
8. **Decide reminders' fate** (2 opt-ins ever): either surface the opt-in properly and measure, or stop investing.
9. **Sentry hygiene**: confirm the `@shopify/events`/`parseModule` cluster is theme-owned (then ignore-list it), add anonymous user + surface tags so issue impact becomes measurable.
10. **Ship the telemetry layer** (feedback→DB + funnel events) so the next audit can answer: how many visitors start the form, save, connect a cloud, upload labs, and return.

### Historical bugs worth regression tests (from feedback)
- Wrong-date measurement save (Mar 2026) — pin down date-defaulting semantics in `RoadmapStore.addMeasurement`/save paths.
- LDL-without-total-cholesterol suggestion gap — confirm a test exists in `suggestions.test.ts`; add if not.
