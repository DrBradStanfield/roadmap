# R9: how reminder opt-ins and cancels merge (design of record)

Evidence: main at 5c3c5ae65 (27 Nov). Leads: H115 (this root fix), H126 (R1), A4 (R19). Paths under
packages/health-core/src unless named. Reviewed twice (adversary and Codex); this is the design the build follows.

**Decision (owner, 27 Nov 2026):** the per-token set below is the design. In his words: "just do option B
now. that's the proper fix". The rulings in §11 are settled.

## The goal

Every live reminder row stays reachable from the record; every device, in any merge order, ends with the same opt-in.

## 1. Today's rule

The record holds one opt-in object: `reminderOptIn?: { status, token, email, provider, updatedAt, lamport }`
(roadmap-file.ts:235-242). A cancel flips `status` and keeps the object (:228-234). The equal-epoch merge
keeps the newer object (merge.ts:735-738, `pickNewerOptional` :347-354, `stampIsNewer` :279-282: time, then
lamport, record-time.ts:76-80, then the object's stable string). Across an erase the winner's object stands
(merge.ts:590-596, :668-707). Only the web writes it (widget-src/standalone/reminders.ts: Turn on :239,
same-address switch :311, address-change switch :329-349, Turn off :440, a push's 404 :488-491), plus the
erase (erase.ts:79-84, token `''`), all through `setReminderOptIn` (state-edits.ts:153-155).

Two devices, tokens A and B, t1 < t2:

| # | Device 1 | Device 2 | Merged today | Shown under the set |
|---|---|---|---|---|
| 1 | active A (t1) | cancelled A (t2) | cancelled A | cancelled A |
| 2 | active A (t1) | active B (t2) | active B | active B |
| 3 | active B (t1) | cancelled A (t2) | cancelled A | **active B** |
| 4 | cancelled A (t1) | active B (t2) | active B | active B |
| 5 | cancelled A (t1) | cancelled B (t2) | cancelled B | cancelled B |
| 6 | anything, epoch n | erased, epoch n+1 | cancelled, token `''` | cancelled, token `''` |

Case 3: one device turns reminders on while another, not yet merged with it (60 s poll, record-session.ts:38), turns off.

## 2. The design

**Shape.** `reminderOptIn` keeps every field and today's meaning (the newest row overall) and gains one optional
field, `tokens?: ReminderTokenRow[]`: rows of the opt-in's own fields and stamp, with no `tokens` of their own.

**`rowsOf(optIn)`:** the object's own row (its `tokens` key stripped) plus every `tokens` row, one per token
by `stampIsNewer`. A row whose token is `''` or not a string is skipped. migrate sanitizes each row's stamp as
it does the object's (migrate.ts:357). Every comparison, `stableStringify` included, runs on rows with
`tokens` stripped.

**Merge (equal epoch).** `rows = mergeByKey(rowsOf(L), rowsOf(R), (r) => r.token)` (merge.ts:287). The stored object is the newest of
both objects' own rows and every `tokens` row, the erase marker included. App writers keep each object the
newest of its own rows, so this equals `pickNewerOptional` over the two objects, exactly as today; the max over
all rows also keeps a hand-edited row newer than its object. `tokens` holds every row in `rows` except the
stored object's own, sorted by token, written only when not empty. So a file with one real token (any erase
marker superseded) is byte for byte what it is today. **Across an erase:** unchanged; the winner's object stands.

**Two readers, two jobs:**
- The **stored object** (newest row overall) drives the auto-enrol gate and the provider-switch path, as
  today: a cancelled object returns (reminders.ts:294); a switch acts only when the object itself is active
  (:295-306). A stale active row in `tokens` never enrols or switches anything.
- **`shownOptIn(file)`** (pure, health-core) drives the control, Turn off and the schedule push. It is the
  newest active row in `rowsOf` if there is one, otherwise the stored object (which covers the erase marker).

**Writers.** A new `setReminderRow(file, row, now)` stamps the row past every clock in `rowsOf` (laterStamp,
then the highest lamport + 1), so the row it writes is also the stored object.
- Turn on: an active row for the new token. `optInToReminders`' `held` check (:236) asks whether `rowsOf`
  holds the reply's token active; its `superseded` check (:233) compares the stored object, as the gate does.
- Same-address switch: the same token, new provider. Address-change switch: the hold stays; the edit that
  saves the new token also writes the old token cancelled (its server cancel succeeded first, :332-340).
- Turn off: §3. A push's 404: a cancelled row for the pushed token only. Erase: unchanged, no `tokens`.
- Cancelled rows written from now on carry an empty address; the token stays as the key.

## 3. Turn off

One named state, changed only through a pure transition with a table test:
`TurnOff = idle | posting { erase, read: Row[], owed: string[], landed: string[] } | writing | failed`.

1. Read `rowsOf` under the shown erase. Post a cancel for EVERY token in the set, active or not: the route is
   idempotent (app/routes/api.reminders-v2.ts:174-177), so a token whose cancel a mixed fleet dropped is reached.
2. Each answer moves a token from `owed` to `landed`. Then write every landed token's cancelled row in ONE
   `session.edit` under the read erase, each only if its row is unchanged since the read (this replaces
   `sameOptIn` on one object, :438). A refused write or failed cancel goes to `failed` with today's words.
3. `reminder_optout` is counted once per Turn off that wrote at least one row.

## 4. Erase

Every erase reader that takes one object reads rows instead:
- **record-session-erase.ts:98-109.** The erase adopts the merged object of every copy it read whenever ANY
  row in `rowsOf(merged)` is active. Today it adopts only when the top status is active.
- **reminders.ts:390-392 (prepare).** The `read` event carries `rowsOf(optIn)`. Each active token is proved
  in turn: the first with its Drive proof, the rest bare, as today.
- **reminders-erase-cancel.ts.** `kept` (:47-50) adds each active token in the rows it is given; `remote`
  (:33, :95) carries `rowsOf(getReminderOptIn())`; `toCancel` (:75-78) spares a token only if
  `rowsOf(standing)` holds it active.
- The gate is unchanged. A losing copy's rows do not travel; R1 owns that route.

## 5. Convergence

**Why it converges.** Rows form a map of last-write-wins registers. A per-key max over a total order is
commutative, associative and idempotent. The epoch gate orders copies by epoch first, and a lexicographic
product of semilattices is a semilattice. The stored object and `shownOptIn` are pure functions of the
converged state. The stored object equals today's rule even when old code runs the merge, because old code
keeps the newer object.

**On today's single object the rule does not converge:** active B (t1), active A (t3), cancelled A (t4) give
cancelled A, active B or active A by grouping.

**Throwaway prototypes** (scratchpad, not committed; rows ordered by t, lamport, then a stand-in string):

| Check | Size | Commutative | Idempotent | Associative | Orders with more than one result |
|---|---|---|---|---|---|
| Today's rule, single object | all 50,653 triples (3 tokens, 2 statuses, 3 times, 2 lamports, absent) | 0 failures | 0 | 0 | 0 of 5,000 sets |
| Proposed rule on the single object | same 50,653 | 0 | 0 | 3,276 failures | 522 of 5,000 |
| Per-token set, sample | one in three states with at most 2 tokens (27,270,901 triples) | 0 | 0 | 0 | 0 of 5,000 |
| Per-token set with epoch gate | 300,000 random triples, up to 3 tokens, epochs 0-1 | 0 | 0 | 0 | 0 of 3,000 sets (352,206 orders × shapes) |

**Mixed fleet (nested model).** 20,000 random histories of 2-4 copies, 6 merges each, 40% run by old code.
Each merge overwrites both copies; then new code gossips until quiet. Zero failures on each of: the stored
object matched today's rule after every merge; all copies converged once old merges stopped; none showed a row
nobody wrote; the end view was never off where today's object is on; the set never missed a token today's
object reaches. 605 histories ended differently from an all-new run, because an old merge dropped a row: 411
match today's outcome, 80 show a token whose later cancel was dropped, 114 fall in the prototype's catch-all.
(A top-level field instead gives 576 / 384 / 78 / 114.)

**Left out of the prototypes** (PR 1's property tests add the first two): the real `stableStringify`
tie-break; `eraseEpoch` inside the property test; migrate's clamp of a future stamp; `erasedRows`; and writer
discipline (the random rows let an old active token stay uncancelled).

## 6. Old readers, from the code

Every engine and client in use reads schema 3. The engines bundled with builds 7 and 8 already state
`CURRENT_SCHEMA_VERSION = 3` (0433e99ac, 64bd85e73).

| Reader | Gets the change | With a v4 file | With the additive field (this design) |
|---|---|---|---|
| Old web tab | on reload | refuses the record and says to update (migrate.ts:262-263, widget-src/src/storage/index.ts:13-15) | keeps it (migrate.ts:7-10; `sanitizeStamp` keeps extra keys). Its merge keeps the newer object with its `tokens`; its Turn on writes a fresh object without them (state-edits.ts:153-155); its Turn off spreads the object, so they ride along. Shows today's rule |
| CLI and stdio MCP (a git clone, at its commit) | on `git pull` | refuses through SyncManager's migrate | keeps it; never writes the opt-in. `read_record` has stripped the whole `reminderOptIn` since ba6bc358b (2 Oct) |
| Hosted MCP | at Deploy | refuses between merge and Deploy | same as the CLI |
| iPhone, App Store 0.1 (builds 8 and below) | never: the floor is `minAppBuild` 11 | My health cannot open the record (the newer-app path, DemoRecord.swift:25-31) until a new store build | keeps it; writes the opt-in only by erase, which drops the rows by design; its merges keep the newer object |
| iPhone TestFlight 0.2, builds 11-14, and build 15 | OTA engine | refuses, and no OTA engine can lift it: an engine must match the bundled schema (EngineManifest.swift:65, ios/engine-updates.md:73-75) | runs old merge until its OTA engine arrives, then new |

**Schema version: no bump.** A v4, even a conditional one, locks every iPhone build out of that record until a
new store build ships; the additive field converges with old readers (§5).

**What old code does to the set.** It can drop rows: its merge keeps one side's object whole, and an old web
Turn on writes a fresh object. It never invents a row or moves a stamp, and the stored object keeps today's
meaning. A dropped row either falls back to today's rule, or shows a token whose cancel was dropped as active
again. Every writer marks a token cancelled only after its row is off on the server (reminders.ts:434-440;
the 404 and erase paths likewise), and an update never refills an off row (app/lib/reminder-v2.server.ts:355-373).
So when that token is the shown row, its next push gets a 404 and writes the cancel back. That holds only for
the shown row, because only its token is pushed; any other token is reached by the next Turn off (§3).

## 7. Redaction

The rows live inside `reminderOptIn`, which `redactRecord` strips by name (mcp-tools.ts:84-88), so old and
new MCPs hold them back. A top-level field would pass through its `...rest` (:87, :96). PR 1 adds
`reminderOptIn.tokens` to docs/agent-access.md rule 12 (:226) and tests that the rows never leave.

## 8. What the set keeps; files in the field

The server keeps one row per address (`enrolByEmail`, reminder-v2.server.ts:238-259). A new token appears only
for a new address or after a proved delete. The verified lane hands back the same token for an existing row,
which the per-token register takes as a newer row. So a person holds a few rows. Cancelled rows stay (dropping
one stops the join being idempotent: a stale copy's active row comes back); new writers blank their address.
**No migration:** a file reads as its object's one row and shows it, so no existing file changes meaning on
first merge. A file that merged case 3 before the change keeps cancelled A.

## 9. The switch hold, R1 and order

The switch hold (A4, R19) is unchanged; the switch's one new write rides the edit that saves the new token.
The gate still drops a losing copy's rows, so R9 does not cover a token written after an erase's read: R1
(H126) does, and its re-check reads `rowsOf`. Order, per the owner's ruling: R1, then R9, then R19's hold union.
**Considered and not chosen, a bridge:** a tab holding token T would cancel T on merging a strictly newer
opt-in naming another token. It cannot be bound to one record (no record identity exists; every never-erased
record shares the erase identity `[0, null]`), and the set covers what it would.

## 10. What stays open

R9 narrows H115; it does not close every route. Still open: the address-lane refresh, which refills an off row
and issues no token, so no record can hold it; tokens dropped before the change ships; a mixed-fleet window
where old merges drop rows (permanent for App Store 0.1 until it updates); the erase gate's drop (R1), and
R1's own limit, a device that never returns.

## 11. Settled rulings

(1) The rows live nested, in `reminderOptIn.tokens`. (2) New writers blank the address on cancelled rows.
(3) The engine `minVersion` is not raised: the floor only prunes staged downloads, never the bundled engine,
cannot be lowered again, and does not shorten the mixed window. (4) Usage signal: a status-only `product_events`
event (provider tag only) when a Turn off posts cancels for more than one token; it counts cleanups attempted,
and rows left live cannot be seen from the client. (5) One new US-17 AC for the set; AC17's Limit trimmed to §10.

## 12. Build plan

AC ids: run `node tools/next-ac.mjs US-17` and `US-11` after `git fetch`, right before each push (on 27 Nov:
US-17 AC19, US-11 AC15). PR 1 adds both ACs with its half; PR 2 extends the same two ACs and trims AC17's
Limit. Merge class: a fresh adversary and Codex pass on each PR.

**PR 1: health-core, engine path.**
- **Files.** roadmap-file.ts (`ReminderTokenRow`, optional `tokens`); migrate.ts (sanitize `tokens` rows, drop
  `''` and non-string tokens); new `reminder-rows.ts` (`rowsOf`, `mergeOptIn` with the join and the `tokens`
  rule, `shownOptIn`, `setReminderRow`); merge.ts (766 lines, must not grow: :735-738 call `mergeOptIn` in place
  of `pickNewerOptional`); record-session-erase.ts:98-109 (adopt when any row is active); agent-access rule 12.
- **Tests (failing first where they pin a change).**
  - US-17 AC19: case 3 shows active B in both orders, and the stored object is cancelled A.
  - Cases 1-6 as a table, both orders.
  - A one-real-token file, with and without a superseded erase marker, round-trips byte for byte.
  - `''` and non-string tokens are dropped; the object's own `tokens` key never reaches a comparison.
  - A seeded property test with the real `stableStringify`: up to 3 tokens, epochs 0-2, rows differing only
    by the tie-break. It checks the three laws, all orders, the stored object as the max of all rows, and
    that `shownOptIn` is order-free.
  - US-11 AC15: a cancelled top row with an active nested token present only in the cloud copy (and again only
    in the device mirror) is adopted by the erase.
  - Redaction (US-32 AC41): a two-token record through `read_record`, `get_plan` and tool dispatch shows no
    token or address anywhere.
  - The US-64 seeded snapshot (merge-property-pins.test.ts) stays unchanged: its seeds draw one token, never
    `''`, so no `tokens` is written.
- **Pins to run.** merge*, erase*, record-session*, roadmap-file.schema, state-edits,
  record-writers-stamp-anchor, mcp-tools tests; ios/engine/stamp-anchor.test.ts and read-record-cache.test.ts;
  the engine parity fixtures.
- **Then** an engine release: same bridge, `minAppBuild` 11, `minVersion` unchanged.
- **PR 1 alone on main for a week.** Merges start writing `tokens` when two copies hold different tokens. The
  web still reads the stored object, so every screen and writer behaves as today. The erase adopts a merged
  object with any active row, but the web prepare still cancels only an active stored object, so nested
  tokens wait for PR 2. Old readers carry the rows; no agent sees them.

**PR 2: web writers and readers.**
- **Files.** widget-src/standalone/reminders.ts (497 lines, must stay at or under 500: Turn on checks, switch,
  404, erase prepare); new `reminders-turn-off.ts` (the `TurnOff` union, transition and driver);
  reminders-erase-cancel.ts (`kept`, `remote`, `toCancel` over rows); reminders-control.tsx (reads
  `shownOptIn`); widget-src/src/lib/roadmap-data.ts (`getShownOptIn`).
- **Tests.**
  - US-17 AC19, end to end with two devices over the real store and an in-memory cloud: case 3 shows on, and
    its Turn off cancels B and A in one edit.
  - The `TurnOff` table: owed and landed, a failed cancel, a refused write, a row changed since the read.
  - The AC4 gate: a stale active row plus a newest cancelled row, same provider and different provider, gives
    no enrolment and no switch cancel.
  - `held` and `superseded` over rows; a 404 cancels one token; the switch writes the old token cancelled in
    the new token's edit.
  - US-11 AC15, end to end: the erase cancels a nested active token seen only in the cloud copy, and
    `toCancel` spares a token `rowsOf(standing)` holds active.
  - The usage event fires once, status only.
  - Existing: the AC17 table in reminders.test.ts, reminders-erase-cancel, reminders-cancel-superseded and
    reminders-control tests.
- **Story:** US-17 AC19 and US-11 AC15 written; AC17's Limit trimmed to §10.
