# R4: each off-file leftover carries the erase it was written under (design note)

Evidence: origin/main at 0145be0ee (25 Nov). Paths under widget-src/src unless named. Lead: A23.

## The goal

An erase clears every leftover written before it and keeps every one written after it, in any tab, whatever order
the tabs take the erase in. A clear that fails reports once.

## The leftovers today

Three kinds live in the browser, outside the record file:

- matrix drafts: lib/useMatrixDraft.ts:148 (`BT_TIMELINE_DRAFT_KEY`, `VITALS_DRAFT_KEY`);
- stored originals: storage/local-storage-adapter.ts:233 (`DOC_KEY_PREFIX`), a raw data URL (:221-223);
- Lp(a) kept answers: lib/lpa-unit.ts:123.

One clearer, lib/storage.ts:297-310. One browser key, `health_roadmap_cleared_erase` (lib/cleared-erase.ts:13), names
the erase the whole set was last cleared for. The key describes the set, not each entry, so a clear cannot tell an
entry written after an erase from one written before it. The pin at
packages/health-core/src/record-session.clear-owed.test.ts:485-486 records this as today's limit.

A failed clear also reports twice: once from the session's `tryClear` (record-session.ts:330-335, via
record-session-erase.ts:139), then from the store's `clearOffFileData` (roadmap-store.ts:565-566), reached from
`clearOffFileAfterErase` (roadmap-data.ts:121-127, HealthTool.tsx:478).

The iPhone keeps no leftovers (ios/engine/cloud.ts:64 and app-doors.ts:49 are no-ops).

## The design chosen

Each leftover is stored as `{ erase, value }`: the erase shown when it was written, in the same `setItem` as the
value. A clear for erase E removes only entries stamped older than E (`eraseLater(E, stamp)`). The clear is then
idempotent, so it can run at every open, re-read and erase. A lagging copy (an older erase) clears nothing newer, by
the same rule.

The per-browser key and its machinery lose their job and are deleted: `clearedFor`, `clearOwed`, `keepCleared`,
`clearedAtOpen`, and `RecordHost.clearedErase` / `noteCleared`.

The double report has a smaller fix: the store's `clearOffFileData` calls the session's `tryClear`, which already
reports once per erase (`clearReportedFor`). The store's own report goes.

All three kinds take stamps, stored originals included. `readDocument` reads both shapes (stamped and the raw data
URL). Lp(a)'s list becomes `{ id, erase }[]`.

Legacy entries, written before the change, carry no stamp. At the first open each is stamped with the kept key's
erase, or the record's erase when there is no key. That matches what today's key would clear, so nothing is lost or
kept that today would not be.

### Options weighed

- **A (chosen): the stamp inside each stored value.** One write, so value and stamp cannot drift.
- **B: one sidecar map** `{ key: erase }`. Values stay as they are, but two writes can drift (a quota failure on the
  second leaves a value unstamped), and two tabs updating one map race.

## PR split

Serial. It waits for the erase-by-type series (R5, docs/drafts/h18-h24-erase-by-type-design.md) to finish: R5 PR 3
moves the shown erase into lib/roadmap-data.ts, which the stamps read. Never in parallel with R5, R6 or R20, which
share record-session.ts and roadmap-store.ts.

1. **One report per failed clear (Lane A).** roadmap-store.ts:565-566 calls `session.tryClear()`;
   roadmap-data.ts:121-127 loses its empty catch; record-session.ts drops `@internal` on `tryClear` (comment only).
2. **Pins (test-only).** What must still clear: a draft typed before the erase in any tab, every Lp(a) answer from
   before it, every original the erase did not keep (`keepOriginals`), everything at log-off.
3. **Stamp, and clear older only.** lib/storage.ts, lib/useMatrixDraft.ts, lib/lpa-unit.ts,
   storage/local-storage-adapter.ts, storage/web-record-host.ts, packages/health-core/src/record-host.ts
   (`clearOffFileData(keepOriginals, erase)`). Legacy entries stamped at open. The phone's hosts are no-ops, so no
   phone behaviour change; it rides the next engine release.
4. **Delete the key machinery.** lib/cleared-erase.ts; record-host.ts (`clearedAtOpen`, `keepCleared`, two interface
   members); erase-identity.ts `clearOwed`; record-session.ts `clearedFor`; record-session-erase.ts:68, :115, :168;
   the two no-op members in ios/engine/cloud.ts:64 and app-doors.ts:49. Swift untouched. Engine release and
   simulator run. Conflicts with R3 on record-session-erase.ts, so serialize.

## Tests

- PR 1: "US-11 AC6: an own erase whose clear fails twice sends one 'Record upkeep failed' report, and the done
  message carries no warning". Mutation caught: the store's own report restored.
- PR 2: the pins above catch a mutation that skips the clear for older entries.
- PR 3: the flipped clear-owed.test.ts:486, "a tab taking E3 in late keeps the draft another tab typed under E3".
  Mutation: the stamp compared with `>=` instead of later-than.
- PR 3: "same tab: both clears fail; a draft typed after the erase survives the next load". Mutation: stamped with
  the record's erase at the clear, not the shown erase at the write.
- PR 3: "a legacy unstamped draft from before the kept erase is cleared; one after it is kept". Mutation: unstamped
  treated as oldest.

**Words:** none change. **Net prod LOC:** about +30 in PR 3, about -70 in PR 4.

## Owner rulings (2026-11-25)

- Option A: each leftover stored as `{ erase, value }`.
- All three kinds are stamped, stored originals included, for one rule.
- Waits for the erase-by-type series to finish. Not started.
