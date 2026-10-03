# Product-Health Learnings — append-only

Durable, non-obvious learnings about how the Health Roadmap tool is used and
how to improve it. Maintained by the weekly loop (see [LOOP.md](LOOP.md)) and by
build sessions. Dated, tagged, newest at the bottom. Read before appending — no
duplicates.

- **2026-08-06 [usage]** First audit: a small, deeply engaged audience (23–69-min
  sessions); blog→CTA→tool is the working funnel; the chatbot doubles as
  customer support (~17% of queries). Detail: docs/usage-audit-2026-08.md.
- **2026-08-07 [bug-class]** The three defects found this week (eraseEpoch
  resurrection, reminder-optout revert, BP validation hole) share one shape:
  a mutation path that bypasses the established stamped/validated helper. When
  auditing, look for the sibling that doesn't use the shared helper.
- **2026-08-07 [funnel]** Product events went live 2026-08-06; treat earlier
  weeks as no-data, not zero-usage. lab_rows_viewed/lab_row_added went live
  2026-08-07 (US-21 phase 1).
- **2026-08-10 [funnel]** A funnel event reading 0 can be dead instrumentation,
  not zero usage (`chat_opened`: unreachable emit site, then a second layer —
  side bundles with their own vite configs never define `VITE_SHOPIFY_SURFACE`,
  so shared-component events no-op there; check every bundle that mounts the
  component). Charter rules born here: classify every zero at its emit site;
  verify each NEW event fires in production within its first week. Closed
  2026-08-22 — a tight deploy-to-first-event timestamp IS the live verification
  when a container can't reach the site. (Full saga: W32–W34 reports.)
- **2026-08-10 [usage]** W32's "reminder_optin 0 ever = kill-signal" was wrong
  in a durable way: the zero measured REACH, not demand — default-on + the
  typed lane (08-13/14) brought 18 enrolments in a week. A zero on an
  opt-in-shaped event indicts the surface before the feature.
- **2026-08-16 [tooling]** Sentry per-issue event COUNTS are not reproducible
  across pulls: the same two chat issues returned 86/24 (W32), then 1/1 in two
  W33 pulls (identical under statsPeriod=14d and 90d), and summed `stats`
  buckets returned 0 even for an issue with a real in-window event. Treat any
  Sentry count as soft; trend on the stable fields (firstSeen/lastSeen,
  status) and say so whenever a count drives a conclusion. (The W33 report's
  first draft "explained" W32's figures as lifetime counts — the adversarial
  review disproved that same-run; the true origin of 86/24 is unidentified.)
- **2026-08-22 [tooling]** PostgREST silently caps any response at 1000 rows,
  and two identical UNORDERED queries can return *different* arbitrary
  1000-row subsets — an unordered fetch is never "all rows" past 1k. Always
  pair `Prefer: count=exact` with explicit-`order` pagination and reconcile
  the aggregate against the exact count (bit the W34 `ab_events` pull; caught
  same-run by the worker's cross-check).
- **2026-08-22 [usage]** The router "miss rate" (W32 73%→W33 35%→W34 49%) has
  always conflated platforms: `router_context` shows ~80% of W34's routed
  `chat_match_events` are the YOUTUBE COMMENT BOT (argumentative video
  comments, where no blog match is often correct), not tool users. Web-chat
  only: 12/16 matched; 2 of the 4 misses are mid-conversation fragments
  ("female", a height reply) the classifier should arguably have skipped.
  Real failure classes found: content gaps (turkesterone, BPC-157/peptides —
  no post exists) and ONE router JSON-parse `router_error` (1/222). Segment
  by `router_context` platform before drawing any router conclusion —
  chat-health should re-baseline this way.
- **2026-08-22 [tooling]** Email `product_events` (report_email_sent/clicked)
  carry one constant visitor_id and empty metadata — click:send is an EVENT
  ratio, never a per-recipient CTR (21 clicks could be one person), and the
  numerator is uncohorted (a W34 click may be on a W33 send). Trend only
  while computed identically week-to-week.
- **2026-08-22 [tooling]** Clarity session counts can be ~99% synthetic:
  W34's drstanfield pull showed 357k sessions/3d (~79× normal) that were one
  fingerprint — Chrome+macOS+PC+no-referrer, ~22s engagement, US/BR/VN/MX —
  a scraper wave, with Clarity's own bot filter catching only ~3%. Before
  trusting a Clarity session count, check Browser/OS/referrer concentration;
  a flooded pull is a named gap, not a data point. Confirmed 08-29 (200k/3d,
  same fingerprint). **Receded by 2026-09-05:** 4,133 sessions/3d, organic
  mobile/Google-led shape, `/pages/roadmap` extractable again — floods can
  end on their own; re-check shape every pull rather than carrying the gap.
- **2026-08-16 [usage]** The typed reminder lane outdraws cloud (W33: 17 vs 3;
  W40: 194 vs 20 all-time, ~10:1). A partial first week fakes a "doubling":
  compare per-day rates across a series' first two weeks.
- **2026-08-29 [tooling]** git approxidate parses `--since=8d` as "August 8"
  (day-of-month), NOT "8 days ago" — so the charter's workflow-integrity
  command over-scans mid-month and, in the first days of a month, resolves to
  a FUTURE date and silently returns empty: a falsely-clean tripwire. Use
  `--since="8 days ago"` or an explicit ISO date. (Adversarial-review catch,
  W35; substance re-verified with explicit dates — the window was clean.)
- **2026-08-29 [usage]** The typed lane enrols already-overdue items, so real
  reminder sends happen any week (first 08-28); check live `reminder_optin_v2`
  schedules, never memory, before saying "nothing due". `reminder_sent`
  (server-only) has matched the in-window `last_sent` stamps every week since
  W36 (W40: 3 = 3); a mismatch is the finding.
- **2026-09-05 [bug-class]** A docs-rewrite commit can silently delete a third
  of the product spec: `2285724` (09-01, message describes only US-32 edits)
  removed US-12–US-28 + Epics D–G from `user-stories.md` (+18/−221) and
  regenerated the HTML in the same commit, so both copies agreed and nothing
  errored for 4 days. **Mechanism (patch-verified 09-06):** the deletion was
  the file's entire tail — a session's Read of this 110KB file is truncated
  (the tool caps at ~25k tokens; this run's own Read showed "1–129 of 238"),
  and a whole-file Write from that view drops everything past the cap. Any
  file too big to Read whole must be edited with Edit, never rewritten with
  Write. Detection was dangling US-id references; recovery was git
  archaeology via the GitHub API (shallow session clones cannot see it).
  Restored + gated 2026-09-06: the HTML build now refuses a source that
  drops a published story or references an undefined one.
- **2026-09-05 [usage]** First MCP-instrumented week (US-32/34/35 events live
  09-02/09-04): treat the counts as Brad's verification traffic, not adoption
  — `client` resolved to `other` on 45/50 tool calls because MCP Inspector /
  Claude Code CLI sit outside the closed chatgpt/claude enum. Until the enum
  widens and the ChatGPT app verdict lands, per-assistant adoption is
  unreadable and any MCP trend line starts at W37, not W36.
- **2026-09-19 [fleet]** The cloud fleet went silent 2026-09-11 → 09-16: no
  product-health or chat-health W37, no sentry-fix report between 09-10 and
  09-17, and sentry-fix's 09-17 report records five routines FAILED on
  09-11/09-12. From inside the repo a missed run leaves no trace — a report
  that is not there is easy not to notice. Cost: the Drive 403 blank-widget
  regression (REMIX-6G, 09-10 → 09-17) went a week without this loop's read.
  Recovery convention (W38): compute BOTH windows, append the missed week's
  rows marked "backfilled", derive what must be derived and say so, and name
  the Clarity sample (3-day window) as lost. A shallow session clone's graft
  root shows up in `git log -- <path>` for EVERY path — cite workflow commits
  from the GitHub API, not from the graft.
- **2026-09-19 [instrumentation]** A success-only counter cannot tell "nobody
  came" from "everyone bounced": OpenAI's reviewer failed our OAuth flow some
  time 09-02 → 09-15 (rejected 09-15) and no window shows it — `mcp_connect`
  was the only counter until AC34 added refused/`token-*` events on 09-17
  (refused 3, `token-dead-code` 1 in their first three days). Give every
  success-shaped event its failure sibling from birth; a zero on a success
  event with no failure counter is unreadable, not reassuring (cousin of the
  08-10 reminder-optin zero).
- **2026-09-19 [tooling]** `reminder_optin_v2.last_sent` is a jsonb map
  `{screening-type: YYYY-MM-DD}`, not a timestamp — cross-check `reminder_sent`
  by counting nested dates inside the window (W37: 2 = 2, W38: 0 = 0), never
  by a range filter on the column (PostgREST answers 22P02). Server-side
  `product_events` carry the nil-UUID `visitor_id`, so burst detection groups
  on `metadata.client`. The email unsubscribe TOMBSTONES the row (empty
  schedule, `reminder-v2.server.ts:379-393`); a verified Drive cancel, a bounce
  or complaint DELETES it, and the cron purges tombstones after 90 days. Count
  live rows apart (W40: 214 rows, 210 live).
- **2026-09-19 [usage]** An `mcp_authorize_shown` burst marks the REFUSAL
  path, not a scan and not a normal connect: on 09-17 two 4-row bursts
  (02:18, 02:24, client chatgpt) were each followed ~1 s later by a
  `mcp_authorize_refused reason=resource`, while the three later ChatGPT flows
  rendered the page once or twice and consented. Both bursts sat inside Brad's
  own re-test (AC34 commits 01:04Z/02:38Z, his OpenAI reply 02:20Z). Read the
  charter's probe rule with the refusal and consent rows beside it, or Brad's
  tests count as attacks. Confirmed again 09-30: the reviewer left quiet
  shown→consent rows with no return (15:55Z, 16:03Z), while the 19:50Z burst
  with every refusal reason was Brad's probes. His `docs/reviews/` write-up
  for the week names both; read it before attributing any connector row.
- **2026-09-26 [fleet]** A GitHub account flag (~09-18, support ticket open a
  week) removed three sources at once: Actions (the CI tripwire, Tier 3, deploys —
  the API just shows zero runs and a truncated history), Pages (the US-38
  self-host, 404) and the `loop-issue-notify` relay (#118 never reached Brad).
  sentry-fix's 09-20 report had recorded the flag; this loop's Gather never reads
  sibling reports, so the fact arrived via Brad's Gmail support thread instead.
  Read the week's sibling-loop reports before the pulls, and read "0 Actions
  runs" as a question about the account, never a quiet week. While the relay is
  dead an issue is the durable record, not a delivery. (Cousin of the 09-19
  silent-fleet entry: that one was our routines, this one is the platform.)
- **2026-09-26 [usage]** Reach can double in a week with no source we hold able
  to say why: `results_viewed` 172 → 384, the 09-20 spike (91 views, 73 visitors,
  22 of 24 hours), while Clarity's 3-day window had already rolled past it and
  `product_events` carry no referrer. The tempting correlate was false: the
  YouTube-bot's rise (37 → 86) came from a video first seen 09-23 (checkable via
  `router_context.videoId`). A referrer HOST on `results_viewed` (no path, no
  query) is the missing instrument (W39 backlog #3).
- **2026-10-03 [usage]** The plan-ready email's button brings a guest's plan
  back only in the browser that made it, and mostly lands elsewhere: 14 of 17
  W40 clicks fired `email_landing_empty` within ~3.4 s (16 of 21 since 09-24);
  1 of 8 visitors clearly recovered. A connect is not a recovery: require
  `results_viewed` after it (W39's "recovered" visitor connected, saw nothing,
  and kept looking). Pair clicks to landings by timestamp; the email events'
  constant `visitor_id` cannot.
- **2026-10-03 [instrumentation]** A deploy can silently change what a counter
  counts: `remote_change_applied` fell 190 → 5 with its old rows ending
  09-24T21:49 while the old code was still live. The obvious suspect
  (94627c07, "never repeat one") shipped 8 h later, so it is ruled out; the
  cause is one of three bundles that night. Check the suspect commit's deploy
  time against the last row before naming it (W40 review R2).
