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
  `PROXY_PATH` endpoints — extend only on Sentry evidence. Known residuals
  (documented, not defects): send retry can duplicate the user row when
  attempt 1 died mid-pipeline (same as a manual retype; pinning it needs a
  server test); a 504 while attempt 1 still runs costs one extra LLM spend.
- `[expected][sentry]` 2026-08-12 — The info-level issue titled
  "Chat transient upstream 5xx, retrying once" IS the retry instrumentation
  from PR #11 — ledger it `wontfix` (expected) on first appearance; its rate
  is the transient-failure trend, worth reading, never "fixing".
- `[process][review]` 2026-08-12 — Verify a safety claim at the CALL SITE
  that enforces it, not the helper that implements it (round-1 REJECT: dedup
  helper was sound, but the route gates it behind `if (conversationId)`).
- `[gotcha][sentry-api]` 2026-08-12 — Issues-list `count` is LIFETIME and
  `statsPeriod` does not filter the list (valid values only ''/24h/14d);
  rank by summing `stats[period]` buckets and test newness via `lastSeen` vs
  the ledger. Only the latest event per issue is retained at current tier —
  event-history pulls return 1 row.
- `[noise][server]` 2026-08-12 — youtube-bot `logTickError` captures whole
  upstream HTML error pages as the exception value → garbage grouping (two
  separate Sentry issues for one cause). If volume grows, propose normalizing
  (status + first 200 chars) before capture — server file, propose-only.
- `[class][widget]` 2026-08-14 — Any DESIGNED "log it and carry on" failure
  path is a silent-data-at-risk candidate: cloud persist failures were
  memory-only by design, so no test could flag the loss (US-09 had no AC).
  Fixed for the roadmap file via marker-gated on-device mirror (PR #19);
  chat-history shares the machinery unmirrored (declared best-effort — flip
  needs a product call). The PR #11 transient-upstream class confirmed again
  in cross-origin form: an edge 5xx without CORS headers surfaces as an
  immediate fetch REJECTION, not a status code.
- `[defect][widget]` 2026-08-14 — `standalone/connect.ts` migrateLocalInto /
  copyDownToDevice were type-broken and silently no-oped (read() without
  fileName; `{file}` destructured from `{body,version}`; SyncManager missing
  its DocumentSpec). US-09 AC3 dead in source, no Sentry signal — silence was
  the symptom. FIXED same day on Brad's live authorization (failing tests
  first, `connect-migrate.test.ts`); widget-src/tsconfig now includes
  `standalone/` so tsc sees the directory (13 pre-existing errors surfaced —
  burn-down list). Root enabler CLOSED same day (Brad-authorized): both
  project tsconfigs burned down 36→0 and gated in ci.yml; the burn-down
  itself surfaced a second latent crash (Object.hasOwn on iOS WebKit <15.4
  in the statin cascade — replaced with hasOwnProperty.call, floors kept at
  ES2020). app/ still ungated — its burn-down is a standing task.
- `[gotcha][process]` 2026-08-14 — Fresh cloud containers start on a detached
  HEAD at origin/main's tip while the local `main` REF lags: diff/typecheck
  comparisons against `main` silently use stale code. `git checkout -B main
  origin/main` first. Related: on SHALLOW clones, `git log -S`/`--stat`
  falsely attribute changes to graft-boundary commits (they diff as whole-tree
  adds) — verify blob ids across parents before blaming a commit.
