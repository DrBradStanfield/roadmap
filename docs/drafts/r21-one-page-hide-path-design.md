# R21: one page-hide path (design note)

Evidence: origin/main at 0145be0ee (25 Nov). Paths under widget-src/src unless named. Lead: H92.

## The goal

When the page hides or closes, every open cell and the page stage their waiting saves, then the store flushes once.
The order is written in one place, not implied by which listener was registered first.

## The listeners today

Three listeners flush on hide, each on its own:

- the entrypoint: widget-src/standalone/page-departure.ts:4-15, on `visibilitychange` and `beforeunload` (no
  `pagehide`), registered by standalone/app.tsx:81 and widgets.tsx:48;
- the page: components/HealthTool.tsx:318-340 stages its waiting saves, then calls `flushRoadmapStoreSync()` (:327),
  on `beforeunload`, `pagehide` and `visibilitychange`;
- each open value cell: components/MatrixSavedCells.tsx:186-193 sends `pageHidden`, then calls
  `flushRoadmapStoreSync()` itself (imported at :12). Its comment names this an ordering patch until one hide path
  stages every cell, then flushes once.

The order holds today because `flushSync` is cheap when nothing is unsaved (record-session.ts:291-292) and the
correction is synchronous (roadmap-store.ts:311).

## The design chosen

A module registry in a new lib/page-hide.ts (lib/roadmap-data.ts is at 487 of its 500 lines):

```ts
onPageHide(stage: (closing: boolean) => void): () => void
```

- One set of listeners: `beforeunload`, `pagehide`, and `visibilitychange` to hidden.
- On each, it runs every registered stage, each in its own try, then `flushRoadmapStoreSync()` once, then the
  entrypoint's after-hook (the reminder push, on hidden only, as today).
- HealthTool registers its stage. A ValueCell registers `() => sendLeave('hidden')` while open. No cell reaches the
  store.
- page-departure.ts installs the path, keeping its signature, so app.tsx and widgets.tsx do not change.
- The entrypoint path also listens for `pagehide`, so a back-forward-cache departure flushes even with no HealthTool
  mounted. The flush does nothing when nothing is unsaved.

This is a registry, not a mode, so no union is needed.

### Options weighed

- **A (chosen): module registry.** Serves both entrypoints and needs no React tree.
- **B: a React context from HealthTool**, cells calling `useStageOnHide`. It keeps the page in charge, but the
  entrypoint's own flush stays a second listener, so "one flush" is not reached.

## PR split

Web only; no engine, no Swift. It waits for erase-by-type (R5) PR 2, which makes `CorrectFn`'s erase required and
touches MatrixSavedCells.tsx, HealthTool.tsx and the roadmap-data writers. Not in parallel with R13 (HealthTool.tsx).

1. **Pins (test-only).** One `pagehide` with an open cell's click-away pending, and one hidden `visibilitychange`,
   each leave the record on disk holding the cell's correction and the page's waiting saves. Run with the cell's
   listener registered before the page's and after it.
2. **Move.** New lib/page-hide.ts. HealthTool.tsx:318-340 (its listeners go; its stage registers).
   MatrixSavedCells.tsx:12, :186-197 (the flush and its import go). standalone/page-departure.ts installs the path.

## Tests

- PR 1: "US-04 AC1 (H92): a click-away save asked for before the tab hides is on disk after one hide, whatever the
  listener order". Mutation caught: the cell's staging dropped (after PR 2: the flush registered before the stages).
- PR 2: "one hide flushes the store once". Mutation: a cell calls the flush again.
- PR 2: "a stage that throws does not skip the flush or the other stages". Mutation: the per-stage try dropped.
- PR 2: "a pagehide with no HealthTool mounted still flushes". Mutation: the entrypoint listens on hidden only.
- PR 2: the existing pins of US-06 AC13/AC15 (waiting list saves, PSA blur on close) stay green.

**Words:** none change. **Net prod LOC:** about -10 (+30 new file; -20 HealthTool, -8 cell, -10 page-departure).

## Owner rulings (2026-11-25)

- Option A: one page-hide registry.
- The one path also listens for `pagehide` at the entrypoint; the after-hook stays on hidden only.
- Waits for erase-by-type PR 2. Not started.
