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
  not zero usage: `chat_opened` never fired (158 chat messages that same week)
  because every live surface mounts ChatSection `startExpanded`, making its only
  emit site unreachable. Rule now in the charter: classify every zero (inspect
  the emit site) before reporting it. Verify each NEW event fires in production
  within its first week. **Confirmed again 2026-08-16, second layer:** the
  08-10 ChatSection fix reached only the widget bundle — side bundles
  (site-chat, chatbot) have their OWN vite configs and never define
  `VITE_SHOPIFY_SURFACE`, so `trackProductEvent` no-ops in the bundle carrying
  most chat traffic. A shared-component event fix ships only where each
  bundle's config defines the flag: check every bundle that mounts the component.
  **Closed 2026-08-22:** PR #23's define deployed 08-15T22:49Z; `chat_opened`
  fired 29 times in W34, first event 22:52:36Z (~3 min later) — when a
  container can't reach the live site, production telemetry with a tight
  deploy-to-first-event timestamp IS the live verification.
- **2026-08-10 [usage]** First instrumented week (W32, ~4 days): 190
  results_viewed; uploads complete at 100% (7/7); corrections (9) and
  additional-lab expansion (15, ~8% of viewers) both have real usage;
  reminder_optin fired 0 times ever — the strongest kill-signal yet (US-17).
  *(Superseded 2026-08-16: the zero measured reach, not demand — default-on +
  the typed lane shipped 08-13/14 and the first week brought 18 enrolments,
  0 opt-outs.)*
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
  a flooded pull is a named gap, not a data point. **Confirmed again
  2026-08-29 (week 2):** 200k sessions/3d, same ~98% fingerprint, country mix
  shifted (Singapore #2) — persistent infrastructure-level load, not a blip.
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
  client route): W36 classifies its first number like any new event; sends are
  rare by design (90/180/365d cooldowns), so a small count is expected, not a bug.
