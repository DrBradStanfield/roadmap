# Knowledge-refresh batches of 2026-09-29: archive, not live content

Saved 2026-10-03. These are the re-authored and new knowledge-base bodies from the 2026-09-29 refresh (`docs/knowledge-refresh-plan-2026-09-29.md`, US-42). They existed only as uncommitted files in temporary working copies under `/private/tmp`, which macOS clears on restart.

| Patch | Base commit | Contents |
|---|---|---|
| `wt-pathways.patch` | 05d52d99 | pilot: 10 re-authored pathways |
| `wt-pathways-2.patch` | daa2b667 | batch 2: 20 re-authored pathways |
| `wt-pathways-new.patch` | daa2b667 | 40 new pathways |
| `wt-references.patch` | 05d52d99 | 5 re-authored blog references |
| `wt.patch` | 8869cfb5 | 1 file from a chat-loader working copy |

Each patch was verified on 2026-10-03 to restore byte-identical files when applied to its base commit.

**Status: not signed off.** US-42 AC8 (Brad's clinical sign-off) has not happened. Do not copy these into `docs/` (the chatbot loads `docs/`, and `fly deploy` ships the working tree) until Brad signs off. Re-run `tools/knowledge-batch-check.ts` on each batch first: the checker merged on 2026-10-03 (e5e449f5, cb7ff272) differs from the version the batches were checked with, and its open Codex findings are listed in US-42.

To restore one batch for review: `git switch --detach <base> && git apply archive/knowledge-refresh-batches-2026-09-29/<name>.patch` (or `git apply --3way` on main).
