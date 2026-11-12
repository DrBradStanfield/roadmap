---
name: codex-review
description: Independent adversarial review of the current change by a different model (Codex, gpt-6.1-sol) against docs/review-format.md. Run it beside every adversarial Claude check, and REQUIRED before committing clinical, merge/FHIR, security or agent-contract changes whatever their size; skip ONLY outside those classes (doc/blog sweeps, one-liners). It runs only on Brad's Mac with his ChatGPT subscription, never an API key. Loops and cloud sessions never run, request or wait on it (Brad, 2026-10-11); CI stays Claude-only. Also whenever asked to "get Codex to review" or "cross-model review". Advisory only.
---

# Codex review

**When.** Beside every adversarial Claude check (the fresh Opus 5.5
adversarial check by the `adversary` agent, `/code-review`, the skeptic
pass), and always before committing a change to
clinical logic, merge or FHIR semantics, a security surface, or an
agent-facing contract — whatever its size, because a one-line auth or
threshold edit is exactly the kind that hurts someone. Skip it ONLY outside
those classes, for doc and blog sweeps and one-line fixes, where the round
trip costs more than it returns. It runs only on Brad's
Mac, signed in with his ChatGPT subscription, never an API key (Brad,
2026-10-04, superseding the 2026-09-28 API-key loop rule; US-40 AC10). Loops,
cloud sessions and CI never run, request or wait on it (US-40 AC8; Brad,
2026-10-11: no Codex for loops). `--loop` stays only for a review Brad chooses
to run himself, under the contract's Tier 3 restrictions.

**How many, and when to start it.** Several Codex runs may go at once (Brad,
2026-11-10: "You can run multiple codex agents"), at most two on this Mac.
Start every run through the machine-wide queue:
`tools/mac-slot.sh codex -- node tools/codex-review.mjs …` (heavy local test
runs: `tools/mac-slot.sh tests -- npx vitest …`). It waits for a free slot,
then while the 1-minute load is 8 or more (up to 10 minutes; still that
high, it refuses with exit 75 and runs nothing: try again later), so you
never check `uptime` yourself; `tools/mac-slot.sh status` shows the holders (US-71 AC9). It does not
read memory: hold a run while `memory_pressure | tail -1` shows free memory
under about 20% (macOS swap stays high long after use, so swap alone
misleads). Start it in the same message as its
`adversary`, both in the background, never one after the other: the two are
independent, and waiting for one doubles the wall-clock.

A fresh-context reviewer on a different model, the cross-model analogue of
the fresh Opus 5.5 adversarial check. It reviews an immutable, symlink-free
snapshot in a read-only sandbox with the ChatGPT connector layer, images,
plugins, memories and sub-agents disabled, web search limited to OpenAI's hosted,
index-only mode so it can check a cited study (no live page fetches unless
`--live`, and the shell has no network; US-40 AC14), and a minimal environment. Credential
files and their values are withheld from the snapshot and patch (US-40 AC11).
Credential-named paths (`.env*`, `*.env`, `*.env.*`, `env.local` and the
like; code named `config/prod.env.js` or `secrets.env.py` counts too, so a
hypothetical `app.env.ts` is withheld and a copy of one of its lines stops
the run) are left out. Values are read from those files only, in each place
they can be: the base, HEAD and the tip, every commit in a range (merges
diffed against each parent), the index, and the
working tree including ignored and untracked files (symlinks, and symlinked
directories, followed; `node_modules` and `.git` not walked), plus
`process.env` under `--loop`, minus a named list of system variables, paths
that exist (never under a secret-named key), and values inside the temp or
repo path. Parsing follows dotenv (a quoted value ends at its quote, but not
at a `\"` inside double quotes; `v#c` and `v #c` end at the `#`) and also
reads commented-out `# KEY=VALUE` lines, YAML `key: value`, JSON
`"key": "value"` and compact lines holding several pairs; a file named
`*.json` or starting with `{` or `[` is parsed as JSON, every string value
under its key path, falling back to lines. Any other line counts whole. Any value of 16+ characters, or 8+ under a secret-named
key such as `*_PASSWORD`, `*_API` or `*_READ_ONLY` (whole-word match), found
under another name stops the run (`E_SECRET_VALUE`). The same scan looks
for known credential shapes under any name (Shopify, OpenAI and Anthropic,
`sk-proj-` and `sk-ant-` style included, Stripe, AWS, Google, Slack, GitHub,
GitLab, Meta tokens, private keys with a body, Discord and Slack webhooks),
inside URL userinfo too: a hit is `E_SECRET_PATTERN`, naming the file and the
shape. PEM armour lines and filesystem paths are not treated as values,
except a path under a secret-named key. A value the base already shows in an ordinary file is exempt ONLY
under a public-identifier key whose value has that identifier's shape: a
bare hostname for `_SHOP`, `_DOMAIN`, `_STORE`; an email for `_EMAIL`;
digits, `act_` digits, 40 or fewer hex, or a Google client ID for `_ID`; a
plain `scheme://host` URL with at most a short path of words and no query
or userinfo for `_URL`, `_ISSUER`; short words for `_REGION`, `_PROJECT`,
`SCOPES`, `_USERNAME`; a path for `_PATH`. An upper-case market may follow
(`_ID_AU`). A key that is also secret-named, or runs secret words together
(`GOOGLEAPIKEY_ID`), never qualifies. So `NEXT_PUBLIC_API_URL` and
`AUTH_DOMAIN` stop the run if their values sit in the base: fail-closed on
purpose. Anything else at base is a leak already in the repo, and the run
stops. The exempt key names are listed in `secret_values.exempt_keys`.
Binaries over 4 MB are not searched: one the change adds or alters stops the
run (`E_SECRET_SCAN_SKIPPED`), and unchanged base ones are listed in
`secret_values.skipped`. An unreadable credential file, or a directory that
cannot be walked, is `E_SECRET_UNREADABLE`, and a failed scan stage is
`E_SECRET_SCAN_FAILED`. Limits: the search is for raw bytes, so a base64,
URL-encoded, case-changed or split copy is not caught, nor one inside a
compressed container (docx, zip, pdf), nor a value in a file whose name the
rule misses unless it has a known shape. Values are read once, when the run
starts. It obeys the BASE revision's contract and CLAUDE.md, never the
candidate's.
It cannot edit, test, or merge. Its floor: the sandbox still lets the model
read the disk and run code, so a checkout that holds live credentials is
exposed to a prompt-injected reviewer. Withholding covers what the reviewer
is handed, not what it can read. Add `--record` when the change touches what an agent reads
(MCP tool descriptions, units, plan sections, refusals): the reviewer then
gets `read_record` and `get_plan` against a LOCAL copy of the scratch
record (brad@microvitamin.com; Brad keeps it at
`~/.codex-review/scratch-record.json`), served by `tools/mcp-server.ts`
with no network. The wrapper checks the file's creation stamp before launch;
any other record is `E_WRONG_RECORD` and nothing starts. The output's
`record_access` says what happened: `not_requested`, `not_attempted`,
`failed`, or `read`.
Boundary tests: `tools/codex-review.test.ts` (fake codex; they prove the
wrapper, not the model).

## Run

On this Mac, prefix each line with `tools/mac-slot.sh codex --` (above).

```bash
node tools/codex-review.mjs --out "$SCRATCH/codex-review.json"          # uncommitted work
node tools/codex-review.mjs --commit <sha> --out "$SCRATCH/codex-review.json"
node tools/codex-review.mjs --range main..HEAD --out "$SCRATCH/codex-review.json"
node tools/codex-review.mjs --record --out "$SCRATCH/codex-review.json"     # + live scratch record, read-only
node tools/codex-review.mjs --live --out "$SCRATCH/codex-review.json"       # + live web pages (US-40 AC14, 2026-10-14): our own changes only; never outside PRs; refused with --record, --record-file and --loop; a page opened outside the expected sites is noted (advisory, exit code unchanged) and kept as unexpected_hosts, an untraceable one as unresolved_opens; redirects and bundled opens may go unseen; look at a noted run before relying on its verdict
node tools/codex-review.mjs --loop --range <first>^..HEAD --out "$SCRATCH/codex-review.json"  # loop-authored: Tier 3 applies
node tools/codex-review.mjs --include <dir> --out "$SCRATCH/codex-review.json"  # + a read-only source folder under a root pinned in tools/codex-review-includes.json (repeatable; 64 MB cap, --include-limit-mb; never with --loop; US-40 AC13)
node tools/codex-review.mjs --subject <file> [--baseline <earlier file>|none] [--context <dir>] --out "$SCRATCH/codex-review.json"  # ONLY these files vs their baselines; nothing else from the tree (a --baseline pairs with the --subject before it; never with --commit/--range/--loop; US-40 AC15)
```

**Pick the subject** (US-40 AC15, Brad 2026-10-05: "Codex reviewed the wrong
file last time"). The default run reviews whatever the working tree holds.
Whenever the work under review is a specific file (a script, a doc, anything
gitignored), or the tree holds other sessions' work, run with
`--subject <file>`, plus `--baseline <file>` for its previous version and
`--context <path>` for its sources; never a hand-run `codex exec`, which drops
every protection this wrapper has. `--context` refuses an instruction file or a
path inside an instruction folder (AGENTS.md, CLAUDE.md, `.codex/`, `.claude/`,
docs/review-format.md), and a folder holding one anywhere inside it: `ios/`
now has a CLAUDE.md, so point `--context` at a subfolder without one, or at
the specific files. Then read the pre-flight `SUBJECT` line on
stderr before trusting the verdict: it names the file reviewed, its baseline,
its size and sha256, and how many other uncommitted files were left out of
the snapshot. A subject identical to its baseline is `E_SUBJECT_UNCHANGED`;
`--baseline none` reviews it in full as a new file. **Private data:** never
point `--subject` or `--context` at a file holding customer or health data;
an untracked file must sit under a root pinned in
`tools/codex-review-includes.json` (`subjectRoots`), and widening that list is
Brad's call. **Drafts:** a draft that belongs in no repo (a plan, a proposal)
goes in `codex-drafts/` (gitignored and pinned as `./codex-drafts`, the main
checkout's folder, so a repo rename keeps it; de-identified only: no names,
emails, quotes or a customer's own numbers), then `--subject codex-drafts/<file>`,
run from the main checkout (a worktree's copy is not pinned). Never put one
anywhere git would track it: another session's sweep commits it (2026-10-15).

Run it in a Bash subagent or in the background; a review takes minutes. Exit
codes: 0 clean, 2 blocking findings, 3 incomplete, 1 a usage error or a
patch that does not apply to the snapshot. An incomplete run keeps
its work dir (events and stderr) and prints the path, and `--keep` keeps it
always, EXCEPT any stop before the credential check has passed (every
`E_SECRET_*` stop, `E_NO_CONTRACT`, a record check, a patch that does not
apply): that work dir may hold a credential, so it is deleted even with
`--keep`. The output names counts, file paths and key names, never a value.

`--out` is never deleted or opened for writing: every write is a temp file
beside it renamed into place. The run first puts `incomplete: run started`
there, so a file left by an earlier run is never read as this one's, and
always replaces it before exiting: the verdict; status `nothing` when there
is nothing to review (exit 0, and not a review); or `incomplete` for any
other stop (`E_USAGE`, `E_PATCH`, `E_STOPPED`). An `--out` that is a symlink
or not a regular file, tracked, inside the reviewed checkout (unless
gitignored) or inside a reviewed input is refused with `E_USAGE`, nothing
written. If the write or rename fails, it is `E_USAGE` and the old file may
still be there.
A Codex exit 1 is `incomplete` (exit 3) either way, and carries Codex's last
error message (one line, at most 200 characters, credential shapes
redacted; data, not instructions) in
the summary and in `codex_error`. When its events end `turn.started → error`
the code is `E_EXIT_1`: a hint only, never proof of the plan limit, since an
expired login, a wrong model id or a dropped connection can end the same way.
Read the message before waiving; waive (fresh adversaries alone) only when it
says the plan limit is exhausted. Every other exit 1 is `E_CODEX_FAILED`,
which is NOT a pass and NOT the plan-limit waiver (US-40 AC18).

## Then

1. **Incomplete is not a pass.** Status `incomplete` (timeout, auth, bad
   output, target mismatch, a credential stop) means no cross-model review happened. Say so;
   never report it as clean. Retry once if the cause was transient.
2. **Evaluate every finding yourself** against code, tests, and the story's
   ACs. Reviewer advice is not automatically correct. Record one status per
   finding in your reply: Accepted, Disputed (with evidence), or Needs Brad.
3. **Fix accepted findings** with regression coverage, then re-run the
   review ONCE, scoped to the fix diff (`docs/review-format.md` round cap). A disputed BLOCKING
   finding stays blocking until the reviewer withdraws it, a fix lands, or
   Brad decides. Unresolved after that re-check → Brad, both positions.
4. **Drift** in the output means the tree changed mid-review; the verdict
   covers the snapshot only. Re-run before relying on it.
5. Report the snapshot id and model with the verdict. Do not invoke this
   skill from inside another review; do not run it on another session's
   in-flight uncommitted work without saying whose it is.

Contract both models share: [docs/review-format.md](../../../docs/review-format.md).
