---
name: untangle
description: This repo's method for untangling code so a change lands in one place and agents break less without noticing. Use when splitting a busy file, surveying an area for hidden links or special cases, turning flags, refs and timers that encode a mode into one named state, or planning an untangle PR. Small Lane A PRs, bugs first, Brad's yes on clinical and workflow items. Adapted from caldoai's untangle-codebase skill (MIT).
---

# Untangle

Adapted from the untangle-codebase skill in github.com/caldoai/skills (MIT, copyright 2026 Maze).
We kept its one question and its three kinds of error. We replaced its one-pass,
whole-codebase refactor with Brad's terms: small PRs, one area at a time.

## The one question

Should these pieces change together? Every tangle answers it wrongly in one of
three ways.

- **Hidden links.** Pieces must change together, and nothing shows it: copied
  logic or values, a module that reads state another module sets, a feature
  scattered across folders, a call order callers must just know.
- **Needless links.** Pieces are tied, yet change for different reasons:
  callers that reach into internals, stable code importing volatile code, a
  general function with a parameter only one caller understands, a shallow
  module whose interface moves with its insides.
- **Surplus.** Pieces with no reason of their own to change: pass-through
  wrappers, config for things that never vary, dead code.

**Special cases** are the best clue. An `if` for one value, a parameter for one
caller, a swallowed error, a retry or sleep, a skipped test: each is a
requirement the design never planned for. Read them to learn what the system
needs, then fix the design so most of them go.

## Brad's terms (these override the source skill)

- Small Lane A PRs, one per fix. Each cites a US-xx AC and lands a test that
  failed first (CLAUDE.md, Development Pathway).
- Order: bugs first, then scripted moves of the busy files, then quiet sections.
- No bulk comment deletion.
- A test is removed only from a list Brad approved.
- Brad's yes first on clinical items and on workflow changes.
- Announce a section lock in the agent channel (docs/agent-channel.md) before
  work starts there. No repo-wide freeze.
- Low-risk PRs merge in batches of 8-10. High-risk ones merge one at a time.

## Per area: the steps

1. **Survey (read-only).** Change nothing. List the implicit states (below),
   the special cases, and every hidden or needless link, each with file:line.
2. **Redesign (required).** Before any per-lead PR, ask: what one fix sits
   behind several of these leads? It often looks nothing like them. Design as
   if today's requirements were known from the start. Check each fix: what
   changes together ends up together, nothing else is tied, and everything
   depends on what changes less.
3. **Bugs first.** Each bug lead is its own Lane A PR: AC, failing test, fix.
4. **Pin before a move.** Before moving code, add tests that pin what the
   caller sees today. They must fail if the moved code is broken or dropped.
5. **Move.** One move per PR, with its pins kept and green.

## Implicit state machines

A flow with modes (saving, reading, sending, reviewing) often holds its mode in
scattered pieces: an `isX` boolean, a ref, a timer. They drift apart, and the
drift is the bug. Make them one discriminated union that carries its own data:

```ts
type Glow = { phase: 'still' } | { phase: 'glowing'; ids: Set<string> } | { phase: 'fading'; ids: Set<string> };
```

- Change it only through a pure `transition(state, event)`.
- Test it with a table: each state x event row names the state that follows.
- **Warranted** where async work races: upload, chat send, saves, erase.
- **Not warranted** for plain view state: a tab, a toggle.
- **Synchronous claim refs stay.** A ref set in the same turn as a click,
  so a second press sees the claim before React re-renders, is not a mode.
- Convert one machine per PR, with its pins kept.

Examples in this repo:

- `widget-src/src/hooks/useHighlights.ts`: the `Glow` union above, data inside
  each phase; `useHighlights.test.tsx` walks the phases (US-07 AC3). Copy the union
  only: the hook still keeps a fourth mode, settling (the first 3 s), in `settledRef`
  and a `setTimeout` beside the union, which the rule forbids.
- `widget-src/src/lib/remote-replay.ts`: one named state
  (`loading | loading-held | idle | held`), each event a method;
  `remote-replay.test.ts` drives it through its states and events (US-34 AC4).
- `widget-src/src/hooks/useErase.ts`: names its three states (shown, unshown,
  erasing) in its header. It still holds `erasing` as a boolean beside the
  `erasingNow` ref (the synchronous copy), so it is a named-but-not-yet-union
  case, not the model to copy.

None of these yet has a separate pure `transition` function. The first PR that
writes one sets the pattern; keep it small.

### Composition

Hooks talk to each other: one hook's event drives another's transition. Survey
that protocol too. Write it as a table of events x machines (who sends, who
reacts, in what order) and test the pairs that can race.

## Split by what changes together

Split a file by what changes together, never by line count alone. A feature's
files belong together by domain. A folder move is one pure-move PR per domain,
with Brad's yes first; this skill prescribes no layout.

Empty slots: a slot that may be empty returns `null`, never an element that
renders nothing. An element is truthy even when its component renders null, so
a parent that draws a section for any truthy slot draws an empty one
(docs/gotchas.md, 2026-11-09).

## When an area is done

- Few special cases left. The count is the best gauge of progress.
- A typical change lands in one place.
- Imports point from volatile to stable code, never the reverse.
- Git co-change agrees: files that change together in `git log` sit together.
- Behaviour is unchanged apart from the bugs fixed, checked by the pins.

Line counts are a vital sign, not the goal (CLAUDE.md, Code entropy).

## Decision log

The log lives in `docs/untangle/`, one file per area. The folder does not exist
yet; the first area to keep a log creates it. Write each fix above the
problems it solves, so a reader sees why it exists. The shape (names made up):

```md
- One send state carries the message it sends, so the flag and the timer go.
  - `Composer.tsx:40` sets `isSending` and a ref; they disagree after a retry.
  - `Thread.tsx:88` waits 200 ms for the flag to clear.
```

The repo is public. No unfixed security lead goes in the log; report it to the
orchestrator instead.

## Tips

- Survey with a skeleton: function signatures only, so an area fits in context.
- Script an import graph and rerun it after each move.
- `git log --name-only` shows how often files change and what changes with them.

## Licence of the adapted source

The untangle-codebase skill (github.com/caldoai/skills) is used under this licence:

```text
MIT License

Copyright (c) 2026 Maze

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
