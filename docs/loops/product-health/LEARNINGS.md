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
- **2026-08-07 [loop]** Clarity's MCP/API window is ~1–3 days — weekly runs see
  a sample, not the week; trends need the accumulated weekly reports, not any
  single pull.
