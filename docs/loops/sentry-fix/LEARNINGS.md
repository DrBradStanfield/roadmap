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
