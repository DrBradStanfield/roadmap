# Product-Health Learnings — append-only

Durable, non-obvious learnings about how the Health Roadmap tool is used and
how to improve it. Maintained by the weekly loop (see [LOOP.md](LOOP.md)) and by
build sessions. Dated, tagged, newest at the bottom. Read before appending — no
duplicates.

- **2026-08-06 [usage]** First audit: the tool's audience is small but deeply
  engaged (23–69-min sessions, returning desktop users 12+ min); blog→CTA→tool
  is the working funnel; microvitamin.com's embed had zero traffic.
- **2026-08-06 [usage]** The chatbot doubles as unpaid customer support (~17% of
  queries) and ~48% of router lookups go unmatched — both improvement levers.
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
- **2026-08-16 [usage]** First week of the email machine (US-17/22/23): 18
  enrolments — 17 typed vs 3 cloud rows all-time, so the ~10:1 typed-lane bet
  held almost exactly; 40% plan-ready click rate; 1/25 bounce; 0 opt-outs.
  Meanwhile per-day funnel rates were flat W32→W33 (results_viewed ~50/day):
  raw weekly counts "doubled" only because W32 was a partial week.
- **2026-08-29 [tooling]** git approxidate parses `--since=8d` as "August 8"
  (day-of-month), NOT "8 days ago" — so the charter's workflow-integrity
  command over-scans mid-month and, in the first days of a month, resolves to
  a FUTURE date and silently returns empty: a falsely-clean tripwire. Use
  `--since="8 days ago"` or an explicit ISO date. (Adversarial-review catch,
  W35; substance re-verified with explicit dates — the window was clean.)
- **2026-08-29 [usage]** "Nothing due until 2027" is stale since the typed
  lane shipped: enrolment now captures already-overdue items, so real sends
  can begin any week. They HAVE — the first genuine reminder send was stamped
  (`last_sent`) 2026-08-28 on a row enrolled 08-25 with an item due 08-01,
  inside the PGRST303 cron-fault window. Verify any "nothing due" claim
  against live `reminder_optin_v2` schedules, not memory of the old cohort.
  `reminder_sent` instrumented 2026-08-30 (server-only, forge-rejected at the
  client route); sends are rare by design (90/180/365d cooldowns). **Verified
  2026-09-05 (W36):** 2 fires, matching the window's only 2 `last_sent`
  stamps exactly — the event and the stamp now corroborate each other.
- **2026-09-05 [bug-class]** A docs-rewrite commit can silently delete a third
  of the product spec: `2285724` (09-01, message describes only US-32 edits)
  removed US-12–US-28 + Epics D–G from `user-stories.md` (+18/−221) and
  regenerated the HTML in the same commit, so both copies agreed and nothing
  errored for 4 days. Detection was dangling US-id references in prose/tests.
  Tripwire worth building: the HTML generator failing on referenced-but-
  undefined US-ids (W36 backlog #1 rider). Recovery: git archaeology via the
  GitHub API — shallow session clones (this one starts 09-02) cannot see it.
- **2026-09-05 [usage]** First MCP-instrumented week (US-32/34/35 events live
  09-02/09-04): treat the counts as Brad's verification traffic, not adoption
  — `client` resolved to `other` on 45/50 tool calls because MCP Inspector /
  Claude Code CLI sit outside the closed chatgpt/claude enum. Until the enum
  widens and the ChatGPT app verdict lands, per-assistant adoption is
  unreadable and any MCP trend line starts at W37, not W36.
