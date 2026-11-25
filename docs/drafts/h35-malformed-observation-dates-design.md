# H35: a Health Records result keeps its own date or is not read (design note)

Evidence: origin/main at 50da2fced (25 Nov). Root fix R14. Paths under packages/health-core/src unless named.

## The goal

A lab result imported from Apple Health Records lands on the day it was drawn, or not at all. Its version order
(US-72 AC5) is judged from its own `meta`. A field the schema cannot read never moves a result to another day.

## The schema today

The top-level Observation schema reads `meta: meta.optional().catch(undefined)` and
`effectivePeriod: period.optional().catch(undefined)` (health-records-fhir.ts:57, :62). A malformed period (wrong
type, or a start over 64 characters) reads as absent, so `readingOf` dates the result by `issued` (the
`drawnAt(obs.effectiveDateTime ?? obs.effectivePeriod?.start ?? obs.issued)` line in health-records-import.ts). A
contained result takes its report's draw or release instead (`reportDay`, fhir.ts:113-115). A malformed `meta` drops
`lastUpdated` and `versionId` from `versionOf` (import.ts:139-142). The report-level copies are already strict
(fhir.ts:78-83, PR 1269; pinned at import.test.ts:1372).

## What "not read" shows today

- The import's own refusal: `{ identity: null }` counts `notRead` (import.ts:299, :344, :347). Nothing is written. The
  count reaches no screen: HealthReading.swift:78-84 reads only `landed`. The HealthKit anchor moves on once the batch
  is saved (US-72 AC15), so that version is not offered again unless the lab amends it.
- The record's unreadable rows: "1 entry in your record could not be read, so it is kept unchanged and not shown."
  (readable-rows.ts:176-180). That note covers rows already in the file, on the web and in iPhone My data
  (ios/engine/my-data.ts:278).

## Options (not ruled)

**A. Strict, as the report already is.** Drop `.catch(undefined)` on `effectivePeriod` everywhere, and on `meta` for
a top-level Observation. A malformed one counts `notRead`. A contained result keeps `meta` lenient or ignored:
`asReported` always replaces it with the report's (fhir.ts:106), and FHIR dom-4 says a contained resource carries no
meta. `referenceRange` keeps its `.catch`: it drops a range, never a date.
- A wrong date never enters the record.
- The cost: the result is missing, silently. The person does not learn it was skipped.
- Not a clinical threshold change, so the three-file sync does not apply. US-72 AC3/AC4 text changes.

**B. Keep today's fall-back.** A malformed period dates the result by `issued`; a malformed `meta` leaves the version
unjudged. Every result lands, but some on the day it was issued rather than drawn.

Two options were set aside: write the row flagged undated (lab rows need a `recordedAt`, so a row-shape change, and
Health Records import has no review step or approved words for it), and write it as an unreadable row (an
append-only record would keep a row known to be wrong for good).

## PR split (if A is chosen)

One PR. packages/health-core/src/health-records-fhir.ts (a contained-result schema, or `observation.omit({meta})` for
contained), health-records-import.test.ts, health-records-from-panel.test.ts, the US-72 AC3/AC4 text. The import runs
only in ios/engine, so it needs an engine release. No web or MCP code. Nothing must land first.

## Tests (if A is chosen)

Each cites US-72 AC3, H35.

1. "a top-level Observation whose effectivePeriod is malformed (a number, a start over 64 characters) is one
   not-read, never a row on `issued`". Mutation caught: `.catch(undefined)` restored on `period`.
2. "a contained result with a malformed own effectivePeriod is one not-read, never on the report's draw, and the
   report's other results still land". Mutation: the catch restored, or the whole report refused.
3. "a top-level Observation with a malformed meta is one not-read". Mutation: `.catch` restored on top-level `meta`.
4. "a contained result with a malformed own meta still lands, versioned by the report's meta". Mutation: strict meta
   applied to contained results.
5. "a well-formed period with no start still falls to `issued`, as AC3 says". Mutation: a missing start refused.

**Words:** none under A. Refused results stay silent, as every `notRead` is today.

## Owner rulings (2026-11-25)

Not ruled. Both options stand for the owner.

Open question: skip a malformed result silently (option A; the HealthKit anchor moves on, so it does not come back
unless the lab amends it), or keep today's fall-back to the issued date (option B)? A third path is to hold A until
a "some results could not be read" line is approved for the iPhone's Apple Health section.
