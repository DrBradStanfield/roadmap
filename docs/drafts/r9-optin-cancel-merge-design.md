# R9: how reminder opt-ins and cancels merge (design of record)

Status: built in PRs 2221 and 2230 (merged 27 Nov 2026, US-17 AC19, US-11 AC15); this note is history.

Evidence: main at 5c3c5ae65 (27 Nov); amendments checked at 0065415e7. Leads: H115 (this root fix), H126 (R1),
A4 (R19). Paths under packages/health-core/src unless named. Reviewed three times; this is the design the build follows.

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
by `stampIsNewer`. A row whose token is `''` is skipped. A nested row is kept only if its token is a non-empty
string (as the object's own has no maximum), its status is `active` or `cancelled`, its email is a string and its
provider is one the app writes (`REMINDER_PROVIDERS`); any other row is dropped. migrate sanitizes each row's stamp as it does the object's (migrate.ts:357). Every comparison,
`stableStringify` included, runs on rows with `tokens` stripped.

**Merge (equal epoch).** `rows = mergeByKey(rowsOf(L), rowsOf(R), (r) => r.token)` (merge.ts:287). The stored object is the newest of
both objects' own rows and every `tokens` row, the erase marker included. App writers keep each object the
newest of its own rows, so this equals `pickNewerOptional` over the two objects, exactly as today; the max over
all rows also keeps a hand-edited row newer than its object. `tokens` holds every row in `rows` except the
stored object's own, sorted by token, written only when not empty. So a file with one real token (any erase
marker superseded) is byte for byte what it is today. **Across an erase:** unchanged; the winner's object stands.
**Two erases from one epoch (owner decision, 27 Nov).** The merge reads neither `meta.erasedAt` nor
`erasedRows`. An erase reaches only the rows of the epoch it erased: a row another device wrote at the new
epoch, such as a re-enrolment between two unsynced erases, stays as a real row, on top if it is newer than the
other erase marker and nested under it if older, and shows on until that device or this one turns it off. Its
server row is live, since that erase never held its token, so the record can still cancel it.

**Two readers, two jobs:**
- The **stored object** (newest row overall) drives the auto-enrol gate and the provider-switch path, as
  today: a cancelled object returns (reminders.ts:294); a switch acts only when the object itself is active
  (:295-306). A stale active row in `tokens` never enrols or switches anything.
- **`shownOptIn(file)`** (pure, health-core) drives the control, Turn off and the schedule push. It is the
  newest active row in `rowsOf` if there is one, otherwise the stored object (which covers the erase marker).

**Writers.** A new `setReminderRow(file, row, now)` stamps past every clock in `rowsOf` and past the stored
object's own clock, the erase marker included (laterStamp, then highest lamport + 1): its row is the stored object.
- Turn on: an active row for the new token. `optInToReminders`' `held` check (:236) asks whether `rowsOf`
  holds the reply's token active; its `superseded` check (:233) compares the stored object, as the gate does.
- Same-address switch: the same token, new provider. Address-change switch: the hold stays; the edit that
  saves the new token also writes the old token cancelled (its server cancel succeeded first, :332-340).
- Turn off: §3. A push's 404: a cancelled row for the pushed token only. Erase: unchanged, no `tokens`.
- Cancelled rows keep their address. On a clock tie today a cancel and its active twin differ only in `status`,
  and "cancelled" sorts above "active"; with a blank address the first difference would be `email`, and the stale active row would win.

## 3. Turn off

One named state, changed only through a pure transition with a table test:
`TurnOff = idle | posting { erase, read: Row[], owed: string[], landed: string[] } | writing | failed`.
1. Read `rowsOf` under the shown erase. Post a cancel for EVERY token in the set, active or not: the route is
   idempotent (app/routes/api.reminders-v2.ts:174-177), so a token whose cancel a mixed fleet dropped is reached.
2. Each answer moves a token from `owed` to `landed`. Then write every landed token's cancelled row in ONE
   `session.edit` under the read erase, each only if its row is unchanged since the read (this replaces
   `sameOptIn` on one object, :438). A refused write or failed cancel goes to `failed` with today's words.
   Unchanged means the same status, token, provider, `updatedAt` and lamport. Landed rows are written even when
   another cancel failed. A failed cancel for a row already cancelled at the read never moves Turn off to
   `failed`. Cancels go out for active rows first.
3. `reminder_optout` is counted once per Turn off that wrote a row that was active at the read.

## 4. Erase

Every erase reader that takes one object reads rows instead:
- **record-session-erase.ts:98-109.** The erase adopts the merged object of every copy it read whenever ANY
  row in `rowsOf(merged)` is active (today: only when the top status is active). It ships in PR 2: the web
  bundles health-core, so the prepare must read rows in the same deploy, or a tab's own active row is demoted
  and not cancelled.
- **reminders.ts:390-392 (prepare).** The `read` event carries `rowsOf(optIn)`. Each active token is proved
  in turn: the first with its Drive proof, the rest bare, as today.
- **reminders-erase-cancel.ts.** `kept` (:47-50) adds each active token in the rows it is given; `remote`
  (:33, :95) carries `rowsOf(getReminderOptIn())`; `toCancel` (:75-78) spares a token only if
  `rowsOf(standing)` holds it active.
- The gate is unchanged. A losing copy's rows do not travel; R1 owns that route.

## 5. Convergence

**Why it converges.** Rows form a map of last-write-wins registers; a per-key max over a total order is
commutative, associative and idempotent. The epoch gate orders copies by epoch first, and a lexicographic
product of semilattices is a semilattice. The stored object and `shownOptIn` are pure functions of the converged
state; the stored object equals today's rule even when old code merges, because old code keeps the newer object.

**On today's single object the rule does not converge:** active B (t1), active A (t3), cancelled A (t4) give
cancelled A, active B or active A by grouping.

**Throwaway prototypes** (scratchpad, not committed; rows ordered by t, lamport, then a stand-in string):

| Check | Size | Commutative | Idempotent | Associative | Orders with more than one result |
|---|---|---|---|---|---|
| Today's rule, single object | all 50,653 triples (3 tokens, 2 statuses, 3 times, 2 lamports, absent) | 0 failures | 0 | 0 | 0 of 5,000 sets |
| Proposed rule on the single object | same 50,653 | 0 | 0 | 3,276 failures | 522 of 5,000 |
| Per-token set, sample | one in three states with at most 2 tokens (27,270,901 triples) | 0 | 0 | 0 | 0 of 5,000 |
| Per-token set with epoch gate | 300,000 random triples, up to 3 tokens, epochs 0-1 | 0 | 0 | 0 | 0 of 3,000 sets (352,206 orders × shapes) |

**Mixed fleet (nested model).** 20,000 random histories of 2-4 copies, 6 merges each (40% by old code, each
overwriting both copies), then new-code gossip. Zero failures on each of: the stored object matched today's rule
after every merge; copies converged once old merges stopped; no row nobody wrote was shown; the end view was
never off where today's is on; the set never missed a token today's object reaches. 605 histories ended unlike
an all-new run (an old merge dropped a row): 411 match today's outcome, 80 show a token whose later cancel was
dropped, 114 fall in the prototype's catch-all. (A top-level field gives 576 / 384 / 78 / 114.)

**Left out of the prototypes** (PR 1's property tests add the first two): the real `stableStringify`
tie-break; `eraseEpoch` inside the property test; migrate's clamp of a future stamp; `erasedRows`; writer
discipline (the random rows let an old active token stay uncancelled); and the tied old-comparator case in §6,
so the mixed-fleet counts understate how often old code strips the set.

## 6. Old readers, from the code

Every app engine and current client reads schema 3. The engines bundled with builds 7 and 8 already state
`CURRENT_SCHEMA_VERSION = 3` (0433e99ac, 64bd85e73). A git checkout of the CLI may be older.

| Reader | Gets the change | With a v4 file | With the additive field (this design) |
|---|---|---|---|
| Old web tab | on reload | refuses the record and says to update (migrate.ts:262-263, widget-src/src/storage/index.ts:13-15) | keeps it (migrate.ts:7-10; `sanitizeStamp` keeps extra keys). Its merge keeps the newer object with its `tokens`; its Turn on writes a fresh object without them (state-edits.ts:153-155); its Turn off spreads the object, so they ride along. Shows today's rule |
| CLI and stdio MCP (a git clone, at its commit) | on `git pull` | refuses through SyncManager's migrate | keeps it; never writes the opt-in. `read_record` has stripped the whole `reminderOptIn` since ba6bc358b (2 Oct) |
| stdio checkout from before 20 Oct | on `git pull` | refuses | refuses a file whose `tokens` is not empty (version 2, below) and says to update |
| Hosted MCP | at Deploy | refuses between merge and Deploy | same as the CLI |
| iPhone, App Store 0.1 (builds 8 and below) | never: the floor is `minAppBuild` 11 | My health cannot open the record (the newer-app path, DemoRecord.swift:25-31) until a new store build | keeps it; writes the opt-in only by erase, which drops the rows by design; its merges keep the newer object |
| iPhone TestFlight 0.2, builds 11-14, and build 15 | OTA engine | refuses, and no OTA engine can lift it: an engine must match the bundled schema (EngineManifest.swift:65, ios/engine-updates.md:73-75) | runs old merge until its OTA engine arrives, then new |

**Schema version: no new version.** A v4, even a conditional one, locks every iPhone build out of that record
until a new store build ships; the additive field converges with old readers (§5). A file whose
`reminderOptIn.tokens` is not empty is stamped at least 2, so a reader from before 20 Oct refuses it (e1269ee49
brought version 2; before it `CURRENT_SCHEMA_VERSION` was 1). That includes every reader that strips only
`token` (§7). The merge passes the merged opt-in to `recordSchemaVersion` (roadmap-file.ts:53-58, called at
merge.ts:654).

**What old code does to the set.** It can drop rows (its merge keeps one side's object whole; an old web Turn
on writes a fresh object), but it never invents a row or moves a stamp, and the stored object keeps today's
meaning. A dropped row either falls back to today's rule, or shows a token whose cancel was dropped as active
again. Every writer marks a token cancelled only after its row is off on the server (reminders.ts:434-440; the
404 and erase paths likewise). A schedule update never refills an off row (app/lib/reminder-v2.server.ts:355-373);
a verified enrolment does (:305-310) and hands back the same token (:316-317). So when that token is the shown
row, its next push gets a 404 and writes the cancel back; only the shown row's token is pushed, and any other
is reached by the next Turn off (§3). **On a clock tie old code keeps the object without `tokens`:** under the
real comparator (merge.ts:279-282; `stableStringify`, roadmap-file.ts:393-409, keys sorted) the same row with
the added key sorts lower, since `"tokens"` sorts below `"updatedAt"`. So an old device that already holds the
stored object strips the set on its next write, and new code restores it only while a new copy still holds it.
The result is today's outcome, never worse.

## 7. Redaction

The rows live inside `reminderOptIn`, which `redactRecord` strips by name (mcp-tools.ts:84-88), so old and
new MCPs hold them back. A top-level field would pass through its `...rest` (:87, :96). PR 1 adds
`reminderOptIn.tokens` to docs/agent-access.md rule 12 (:226) and tests that the rows never leave. A stdio
checkout from before 2 Oct (ba6bc358b) strips only `token` (its mcp-tools.ts:510-512) and would return nested
rows; the version floor in §6 makes it refuse the file.

## 8. What the set keeps; files in the field

The server keeps one row per address (`enrolByEmail`, reminder-v2.server.ts:238-259). A new token appears for
a new address, after a proved delete, when a verified enrolment takes over an address-lane row (rotation,
:299-304), and on re-enrolment after a tombstone's 90-day purge (:477, :501-524). Retained rows have no fixed
bound; growth is a few a year at most. Cancelled rows stay, with their address (dropping one stops the join
being idempotent). **No migration:** a file reads as its object's one row, so no existing file changes meaning
on first merge; a file that merged case 3 before the change keeps cancelled A.

## 9. The switch hold, R1 and order

The switch hold (A4, R19) is unchanged; the switch's one new write rides the edit that saves the new token. The
gate still drops a losing copy's rows, so a token written after an erase's read is R1's (H126); its re-check
reads `rowsOf`. Order, per the owner's ruling: R1, then R9, then R19's hold union. **Not chosen, a bridge**
(cancel T on merging a strictly newer opt-in naming another token): no record identity binds it to one record.

## 10. What stays open

R9 narrows H115. Still open: the address-lane refresh, which refills an off row and issues no token; tokens
dropped before the change ships; a mixed-fleet window where old merges drop rows (permanent for App Store 0.1
until it updates); the erase gate's drop (R1) and R1's limit, a device that never returns; the iPhone erase path
sends no reminder cancel on any engine (US-25 AC16c, not built); a verified re-enrolment that refills a token
between another device's cancel and its file write (exists today); two active addresses, pending the owner's ruling.

## 11. Settled rulings

(1) The rows live nested, in `reminderOptIn.tokens`. (2) Cancelled rows keep their address (reversed after
review: a blank address would let a stale active row win a clock tie, §2). (3) The engine `minVersion` is not raised: the floor only prunes staged downloads, never the bundled engine,
cannot be lowered again, and does not shorten the mixed window. (4) Usage signal: a status-only `product_events`
event (provider tag only) when a Turn off posts cancels for more than one token; it counts cleanups attempted,
and rows left live cannot be seen from the client. (5) One new US-17 AC for the set; AC17's Limit trimmed to §10.

## 12. Build plan

AC ids: run `node tools/next-ac.mjs US-17` and `US-11` after `git fetch`, right before each push (on 27 Nov:
US-17 AC19, US-11 AC15). PR 1 adds US-17 AC19 with its half; PR 2 extends it, adds US-11 AC15 and trims
AC17's Limit. Merge class: a fresh adversary and Codex pass on each PR.

**PR 1: health-core, engine path.**
- **Files.** roadmap-file.ts (`ReminderTokenRow`, optional `tokens`, `recordSchemaVersion` raised to 2 for a
  non-empty `tokens`); migrate.ts (sanitize and validate `tokens` rows, §2); new `reminder-rows.ts` (`rowsOf`,
  `mergeOptIn` with the join and the `tokens` rule, `shownOptIn`, `setReminderRow`); merge.ts (766 lines, must
  not grow: :735-738 call `mergeOptIn` in place of `pickNewerOptional`, and :654 passes the merged opt-in to
  `recordSchemaVersion`); agent-access rule 12.
- **Tests (failing first where they pin a change).**
  - US-17 AC19: case 3 shows active B in both orders with cancelled A stored; cases 1-6 as a table, both orders.
  - A one-real-token file, with and without a superseded erase marker, round-trips byte for byte.
  - Nested-row validation: `''` or a non-string token, another status, a non-string email or a provider outside
    the closed list are each dropped; the object's own `tokens` key never reaches a comparison.
  - `recordSchemaVersion`: a two-token file is version 2; a one-token file is unchanged; a merge that first
    creates `tokens` is version 2.
  - Marker stamp: `setReminderRow` over an erase marker newer than every row writes past it. Tied-comparator
    pin: the same row with and without `tokens` at one clock, by `pickNewerOptional`, keeps the one without.
  - A seeded property test with the real `stableStringify`: up to 3 tokens, epochs 0-2, rows differing only
    by the tie-break. It checks the three laws, all orders, the stored object as the max of all rows, and
    that `shownOptIn` is order-free.
  - Redaction (US-32 AC41): a two-token record through `read_record`, `get_plan` and tool dispatch shows no
    token or address anywhere.
  - The US-64 seeded snapshot (merge-property-pins.test.ts) stays unchanged: its seeds draw one token, never
    `''`, so no `tokens` is written.
- **Pins to run.** merge*, erase*, record-session*, roadmap-file.schema, state-edits, record-writers-stamp-anchor,
  mcp-tools tests; ios/engine stamp-anchor and read-record-cache tests; the engine parity fixtures.
- **Then** an engine release: same bridge, `minAppBuild` 11, `minVersion` unchanged.
- **PR 1 alone on main for a week.** Merges write `tokens` when two copies hold different tokens, stamped
  version 2. The web still reads the stored object, so every screen and writer behaves as today; the erase path
  is unchanged until PR 2. Old readers from 20 Oct on carry the rows; no agent sees them.

**PR 2: web writers and readers.**
- **Files.** record-session-erase.ts:98-109 (adopt when any row is active, §4; engine path: an engine release
  follows); widget-src/standalone/reminders.ts (497 lines, must stay at or under 500: Turn on checks, switch,
  404, erase prepare); new `reminders-turn-off.ts` (`TurnOff` union, transition, driver); reminders-erase-cancel.ts
  (`kept`, `remote`, `toCancel` over rows); reminders-control.tsx (reads `shownOptIn` and re-reads it on every
  merge, since a clock-only change announces nothing: record-session-content.ts:28-37, record-session.ts:368);
  widget-src/src/lib/roadmap-data.ts (`getShownOptIn`).
- **Tests.**
  - US-17 AC19, end to end with two devices over the real store and an in-memory cloud: case 3 shows on, and
    its Turn off cancels B and A in one edit.
  - The `TurnOff` table: owed and landed, a failed cancel, a refused write, a row changed since the read.
  - The AC4 gate: a stale active row plus a newest cancelled row, same provider and different provider, gives
    no enrolment and no switch cancel.
  - `held` and `superseded` over rows; a 404 cancels one token; the switch writes the old token cancelled in
    the new token's edit.
  - US-11 AC15: a cancelled top row with an active nested token present only in the cloud copy (and again only
    in the device mirror) is adopted by the erase and its token cancelled; own active B with cloud cancelled A:
    the erase cancels B; `toCancel` spares a token `rowsOf(standing)` holds active.
  - The mounted control shows a row change that arrives in a clock-only merge; the usage event fires once,
    status only; placeholders for the two-address tests, filled once the owner rules (§10).
  - Existing: the AC17 table in reminders.test.ts, reminders-erase-cancel, reminders-cancel-superseded and
    reminders-control tests. **Story:** US-17 AC19 extended, US-11 AC15 written, AC17's Limit trimmed to §10.
