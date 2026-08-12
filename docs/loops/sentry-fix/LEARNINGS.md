# sentry-fix — learnings index

(Constitution rules apply: ≤200 lines/25KB, dedup by tag+subsystem — update in
place, depth goes to `notes/<slug>.md`, raw pulls stay worker-local.)

## Triage priors (seeded from the repo's known noise, 2026-08-10)

- `[noise][server]` Dev-mode react-router frames in server stacks are EXPECTED
  residue, not a bug signal — react-router-serve runs the dev build in prod
  (see memory/project_react_router_serve_dev_build.md). Don't chase.
- `[noise][widget]` Theme-origin errors: drstanfield.com runs Horizon — errors
  with frames only in theme assets (not our bundles) are not ours.
- `[prior][widget]` iOS WebKit-only layout/interaction bugs are a known class
  (CLAUDE.md list: content-box flex default, 280px input min-content, sticky
  in max-content parents). If a fix touches layout, the escape analysis should
  ask "would tools/webkit-verify have caught this?"
- `[prior][process]` Three blanket-rewrite attempts on 2026-08-07 (chat-health)
  all regressed retrieval: fix ONE issue at a time, measure, never batch-fix.

## Run learnings

- `[class][widget]` 2026-08-12 — A 5xx whose body isn't our handler's JSON is
  the proxy/edge answering (machine restart / cold start), not an application
  answer; client code must not treat it as final. Fixed for chat via one-shot
  retry (US-15 AC3, PR #11); same class likely reachable on the other
  `PROXY_PATH` endpoints — extend only on Sentry evidence.
- `[gotcha][sentry-api]` 2026-08-12 — Issues-list `count` is LIFETIME and
  `statsPeriod` does not filter the list (valid values only ''/24h/14d);
  rank by summing `stats[period]` buckets and test newness via `lastSeen` vs
  the ledger. Only the latest event per issue is retained at current tier —
  event-history pulls return 1 row.
- `[noise][server]` 2026-08-12 — youtube-bot `logTickError` captures whole
  upstream HTML error pages as the exception value → garbage grouping (two
  separate Sentry issues for one cause). If volume grows, propose normalizing
  (status + first 200 chars) before capture — server file, propose-only.
