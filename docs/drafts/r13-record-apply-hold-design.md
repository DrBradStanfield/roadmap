# R13: one record-apply hold state (design note)

Evidence: origin/main at 0145be0ee (25 Nov). Paths under widget-src/src unless named. Leads: H14, H15, H16.

## The goal

While the person edits their profile, another writer's change waits in one named hold state. The hold ends at the
next profile save that settles. The page and the chat always read the same record: the one on screen.

## How the hold works today

The relay in lib/remote-replay.ts:25 holds a union, `loading | loading-held | idle | held`. A held remote change is
applied when `saved()` fires (:47-52). Three behaviours follow from details around it:

- **H14.** The page fires `saved()` only when no field was refused (hooks/useProfileSave.ts:115). While a refused
  value (say, an out-of-range height) stays in the form, the profile stays dirty (`profileDirty`, :130), and a held
  remote change waits until the person repairs it. Pinned: HealthTool.record-read-pins.test.tsx (height 400, then a
  remote birth year).
- **H15.** Under a hold, an own save's values read (`reloadValues`, hooks/useRecordReads.ts:48-56) writes the chat
  mirror from the new record (`mirrorRecord`, :15-18), held profile included, while the page shows the old one. The
  chat checks a proposal against the form (components/ChatEdits.tsx:164, :222). Pinned:
  HealthTool.record-read-pins.test.tsx:1059.
- **H16.** The own-save read is values-only (hooks/useRecordApply.ts:184). `apply()` guards against a read under a
  different erase (:129-132); the values read does not. Pinned: useRecordApply.test.tsx:230.

## The design chosen

The relay's union becomes the one hold state, changed only through an exported pure `transition(state, event)` with
a table test. Three rules follow:

1. The hold ends at the next profile save that settles, landed or refused. A refused value rides through the re-read
   anyway (useRecordApply.ts:159-161 keeps every `inputRangeFault` field), so nothing typed is lost.
2. Readers ask the state what is shown. While `held`, the chat mirror carries the profile the page shows, not the
   held one, so the chat proposes from and is checked against the same profile.
3. A values-only read under an erase other than the one shown shows nothing. It goes to the erase machine as an
   arrival, as `apply()` already does.

### Options weighed

- **A (chosen): keep the hold, as one union.** Small, and US-34 AC4 keeps its meaning.
- **B: drop the hold.** Apply every remote change at once and let every dirty field ride through. It deletes `held`,
  `saved()`, `profileClean` and `profileDirty` from the read path. But US-34 AC4 must be rewritten, and per-field
  ride-through can pair a local birth year with a remote birth month (the US-54 AC5b pair rule), which the hold
  avoids.

## PR split

All web only (widget-src); no engine, no Swift. Serial. Not in parallel with R5 PR 2 or R21, which edit
HealthTool.tsx.

1. **Move.** lib/remote-replay.ts gains `transition` and a table test (remote-replay.test.ts). No behaviour change;
   the existing pins stay green. Lands first.
2. **H14.** Flips the H14 pin. hooks/useProfileSave.ts (a `settled` event on landed or refused), lib/remote-replay.ts,
   hooks/useRecordApply.ts, components/HealthTool.tsx (wiring at :150, :273-275).
3. **H15.** Flips :1059. hooks/useRecordReads.ts (`mirrorRecord` takes the shown profile), hooks/useRecordApply.ts.
   ChatEdits.tsx likely untouched: it already reads the form.
4. **H16.** Flips useRecordApply.test.tsx:230. hooks/useRecordApply.ts, hooks/useRecordReads.ts (the read is checked
   against the shown erase before the mirror is written).

## Tests

- PR 1: the table, each state crossed with each event. Mutation caught: `settled` in `held` returns `held`.
- PR 2: "US-34 AC4a (H14): height 400 left, a remote birthYear 1981 shows at the next save, and 400 stays with its
  error". Mutation: the end fired only when nothing was refused (today's :115).
- PR 3: "US-34 AC4a (H15): under a hold the chat mirror carries the profile the page shows". Mutation: the read's
  inputs written to the mirror while held.
- PR 4: "US-34 AC4a (H16): an own-save read after another device's erase leaves the values and mirror as they were;
  the erase's read shows the new record". Mutation: the erase check dropped.

**Words:** none change; a refused field keeps its existing error text. **Net prod LOC:** about +20 in PR 1, small
after that.

## Owner rulings (2026-11-25)

- Option A: keep the hold. The relay union is the one hold state, behind a pure `transition`.
- Status: PR 1 in flight.
