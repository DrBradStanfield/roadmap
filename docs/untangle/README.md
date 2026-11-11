# Untangle ledger

Two ledgers track the untangle work (method: `.claude/skills/untangle`).

- `leads/`: where each item of the November 2026 structural audit stands on `main`.
- `state-leads/`: the leads from our own surveys of implicit state in the web widget.

## One file per lead

Each lead is its own file, `<ledger>/<id>.csv`: the header line, then that
lead's row. Several sessions edit the ledgers at once. In one shared CSV,
two PRs that each append a row conflicted on GitHub, and a conflicting PR
gets no CI run (PRs 1225 and 1250 each lost about 90 minutes). Now two
sessions collide only when they touch the same id, which is a real conflict.

- **Add a lead:** add one file named by its id, say `state-leads/C7.csv`,
  with that ledger's header line and your row.
- **Change a lead:** edit only its file.
- **Never** recreate a single `leads.csv` or `state-leads.csv`.
  `tools/untangle-ledger.test.ts` fails if one comes back, or if a file
  holds more than one row, a different header, or an id unlike its name.

Print a whole ledger as one table:

```bash
d=docs/untangle/state-leads; { head -1 "$(ls $d/*.csv | head -1)"; tail -q -n +2 $d/*.csv; }
```

## leads/

The audit is a private report by an outside contributor, taken at commit
`263053b` on 2026-11-06. Bug leads are
`B-1` to `B-9`. Fixes keep the audit's ids (`T-1`, `S-4`, `A1-1`, `W1-2`
and so on).

Status was set from the code and git history on 2026-11-10 (`main` at
`7c63ecf8`). Nobody tracked these ids while the refactor ran, so no status
was assumed from a PR title alone. Three rows say "Inferred, unverified":
the audit's detail for them was not to hand, so the match to code is a guess.

| Column | Meaning |
|---|---|
| `id`, `section` | Audit id and section |
| `title` | Short neutral summary, our words |
| `status` | See the vocabulary below |
| `evidence` | The file and line that shows the status |
| `pr` | PR numbers that did the work, `;`-separated |
| `durability_check` | The test or lint that fails if the copy or link comes back, or `none` |
| `needs_brad` | `yes` when the item touches clinical rules, the privacy scrubber, merge or sync, auth, CORS, workflows or deploy, or the audit named it as Brad's decision |

Status vocabulary:

- **done**: the end state exists on `main`. Evidence names the file or symbol.
- **partial**: some of it exists. Evidence says what is left.
- **not started**: the old state is still in the code. Evidence cites it.
- **superseded**: the code it refers to is gone or changed, so the fix is moot.
- **cannot tell**: the audit gave too little to check. Evidence says what was looked at.

### Some rows are added later

This repo is public, and the audit is not. The ledger keeps our own columns
only, and a row may be added after its work ships. Brad holds the full list.

### When a fix lands

1. Set `status` and replace `evidence` with the file or symbol that now shows it.
2. Add the PR number to `pr`.
3. Name the check that stops the copy coming back in `durability_check`.
   A fix without one gets `none`, and that is worth a follow-up: at this
   repo's pace, an unchecked copy tends to return.

### Counts

Count from the files; no copy is kept here, since every fix PR would have to
edit it and two PRs would collide:

```bash
python3 -c "import csv,glob,collections;print(collections.Counter(r['status'] for f in glob.glob('docs/untangle/leads/*.csv') for r in csv.DictReader(open(f))))"
```

## state-leads/

Since 2026-11-08 the refactor has split `HealthTool`, `ResultsPanel` and
the upload flow into state hooks. The audit has no id for that work. Each
area was surveyed first for modes held in flags, refs and timers; the
leads are `D` (onboarding), `R` (record read), `P` (plan view), `U`
(upload), `H` (composition, the machines meeting in `HealthTool`), `M`
(phone mirrors: values the iPhone keeps beside the engine's) and `C` (the
server: chat prompt `C1`, chat purge `C2`-`C4`, crons and reminders from `C5`).
This ledger has no `durability_check` column: a done row names its check in
`evidence`.

Status here comes from the survey sessions' notes and the merged PR list
on 2026-11-10. It was not rechecked line by line against the code. Rows may be
added later, as above.

Extra status words: **decided: leave** and **decided: change** (Brad chose;
the second still needs its PR), **awaits Brad**, **no change needed**.

`kind` says what the lead is: a bug, a hidden link (two places that must
change together with nothing saying so), an implicit state, surplus code,
a behaviour for Brad to choose, or a note.

Still to survey: the composition of these machines in `HealthTool`
(events against machines), `BloodTestTimeline`, and chat send.
