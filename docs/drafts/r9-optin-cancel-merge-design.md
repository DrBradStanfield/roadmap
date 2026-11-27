# R9: how reminder opt-ins and cancels merge (design note)

Evidence: main at 5c3c5ae65 (27 Nov). Leads: H115 (this root fix), H126 (R1), A4 (R19). Paths under
packages/health-core/src unless named. Merge class: one fresh adversary and Codex pass before any build.

**Decision (owner, 27 Nov 2026):** the per-token set below is the design. In his words: "just do option B
now. that's the proper fix". No bridge is built.

## The goal

Every live reminder row stays reachable from the record, so a Turn off on any device can reach it. Every
device, in any merge order, ends with the same opt-in.

## 1. Today's rule

The record holds one opt-in object: `reminderOptIn?: { status, token, email, provider, updatedAt, lamport }`
(roadmap-file.ts:235-242). A cancel flips `status` and keeps the object (:228-234). The equal-epoch merge
keeps the newer object (merge.ts:735-738, `pickNewerOptional` :347-354, `stampIsNewer` :279-282: time, then
lamport, record-time.ts:76-80, then the object's stable string). Across an erase the winner's object stands
(merge.ts:590-596, :668-707). Only the web writes it (widget-src/standalone/reminders.ts: Turn on :239,
same-address switch :311, address-change switch :329-349, Turn off :440, a push's 404 :488-491), plus the
erase (erase.ts:79-84), all through `setReminderOptIn` (state-edits.ts:153-155).

Two devices, tokens A and B, t1 < t2:

| # | Device 1 | Device 2 | Merged today | Per-token set (shown opt-in) |
|---|---|---|---|---|
| 1 | active A (t1) | cancelled A (t2) | cancelled A | cancelled A |
| 2 | active A (t1) | active B (t2) | active B | active B |
| 3 | active B (t1) | cancelled A (t2) | cancelled A | **active B** |
| 4 | cancelled A (t1) | active B (t2) | active B | active B |
| 5 | cancelled A (t1) | cancelled B (t2) | cancelled B | cancelled B |
| 6 | anything, epoch n | erased, epoch n+1 | cancelled, token `''` | cancelled, token `''` |

Case 3: one device turns reminders on while another, not yet merged with it (60 s poll, record-session.ts:38), turns off.

## 2. The design

**Shape.** `reminderOptIn` keeps every field and today's meaning: the newest row overall, chosen by
today's rule. It gains one optional field, `tokens?: ReminderTokenRow[]`, where a row is the opt-in's own
fields and stamp (status, token, email, provider, updatedAt, lamport), with one row per token. `tokens` is
written only when the rows hold two or more tokens. A file with one token is byte-for-byte what it is today.

**Rows of a copy.** `rowsOf(optIn)` returns the `tokens` rows plus the object's own row, one per token by
`stampIsNewer`. migrate sanitizes each row's stamp as it does the object's (migrate.ts:357) and drops a row
whose token is not a string.

**Merge (equal epoch).** `rows = mergeByKey(rowsOf(L), rowsOf(R), (r) => r.token)` (merge.ts:287).
`reminderOptIn = { ...newest(rows), tokens? }`, with the rows sorted by token. **Across an erase** nothing
changes: the winner's whole object stands, `tokens` included.

**Shown opt-in.** One pure function, `shownOptIn(file)` in health-core: the newest active row if there is
one, otherwise the newest row. The control, Turn off, the push and the auto-enrol gate read this, not the raw
object (roadmap-store.ts:396 `getReminderOptIn`).

**Writers.** A new `setReminderRow(file, row, now)` stamps the row past every clock in the rows (laterStamp,
then the highest lamport + 1), so the row it writes is also the newest overall.
- Turn on: an active row for the new token.
- Same-address switch: the same token with the new provider.
- Address-change switch: the hold stays as it is. When the new token lands, the same edit writes the old
  token cancelled (its server cancel has already succeeded, :332-340).
- Turn off: posts a cancel for every active row's token (the route is idempotent,
  app/routes/api.reminders-v2.ts:174-177), then writes a cancelled row for each that succeeded.
- A push's 404: a cancelled row for that token only.
- Erase: unchanged. A fresh object with no `tokens`. The teardown cancels every active row it read.

## 3. Convergence

**Why it converges.** Rows form a map of last-write-wins registers. A per-key max over a total order is
commutative, associative and idempotent. The epoch gate orders copies by epoch first, and a lexicographic
product of semilattices is a semilattice. The stored object (`newest(rows)`) and the shown opt-in are pure
functions of the converged rows. The stored object also equals today's rule exactly, because a max
distributes over the join: the newest of all rows is the newer of each side's newest. That holds even when an
old reader runs the merge, because old code keeps the newer object.

**The proposed rule on today's single object does not converge.** Example: active B (t1), active A (t3),
cancelled A (t4). The three groupings give cancelled A, active B and active A.

**Throwaway prototypes** (scratchpad, not committed; rows ordered by t, lamport, then a stand-in string):

| Check | Size | Commutative | Idempotent | Associative | Orders with more than one result |
|---|---|---|---|---|---|
| Today's rule, single object | all 50,653 triples (3 tokens, 2 statuses, 3 times, 2 lamports, absent) | 0 failures | 0 | 0 | 0 of 5,000 sets |
| Proposed rule on the single object | same 50,653 | 0 | 0 | 3,276 failures | 522 of 5,000 |
| Per-token set, sample | one in three states with at most 2 tokens (27,270,901 triples) | 0 | 0 | 0 | 0 of 5,000 |
| Per-token set with epoch gate | 300,000 random triples, up to 3 tokens, epochs 0-1 | 0 | 0 | 0 | 0 of 3,000 sets (352,206 orders × shapes) |

**Mixed fleet.** 20,000 random histories of 2-4 copies, 6 merges each, 40% run by old code. Each merge
overwrites both copies, as a device writing to the cloud does. Then new code gossips until quiet.
- The stored object matched today's rule after every merge (0 mismatches).
- After old merges stopped, every copy converged to one shown opt-in (0 failures).
- No copy ever showed a row nobody wrote (0).
- 576 histories ended differently from the all-new run, because an old merge dropped a row:
  - 384 matched today's outcome;
  - 78 showed a token whose later cancel was dropped (in real flows its server row is already off; see §4);
  - 114 showed an older active row because a newer one was dropped.
- Keeping the set in its own top-level field gives the same picture (605 / 411 / 80 / 114).

**What the prototypes leave out:** the real `stableStringify` tie-break; migrate's clamp of a future stamp
to the file's last write; `erasedRows`; and writer discipline. Their random rows let an old active token
stay uncancelled, which the writers in §2 do not.

## 4. Old readers, from the code

Every engine and client in use reads schema 3. The engines bundled with builds 7 and 8 already state
`CURRENT_SCHEMA_VERSION = 3` (0433e99ac, 64bd85e73).

| Reader | Gets the change | With a v4 file | With the additive field (this design) |
|---|---|---|---|
| Old web tab | on reload | refuses the record and says to update (`SchemaTooNewError`, migrate.ts:262-263, widget-src/src/storage/index.ts:13-15) | keeps it (migrate.ts:7-10; `sanitizeStamp` keeps extra keys). Its merge keeps the newer object with its `tokens`; its Turn on writes a fresh object without them (state-edits.ts:153-155); its Turn off spreads the object, so they ride along. Shows today's rule |
| CLI and stdio MCP (a git clone, at its commit) | on `git pull` | refuses through SyncManager's migrate | keeps it; never writes the opt-in. `read_record` has stripped the whole `reminderOptIn` since ba6bc358b (2 Oct), so nested rows never reach an agent |
| Hosted MCP | at Deploy | refuses between merge and Deploy | same as the CLI |
| iPhone, App Store 0.1 (builds 8 and below) | never: the floor is `minAppBuild` 11 | My health cannot open the record (the newer-app path, DemoRecord.swift:25-31) until a new store build | keeps it; writes the opt-in only by erase, which drops the rows by design; its merges keep the newer object |
| iPhone TestFlight 0.2, builds 11-14, and build 15 | OTA engine | refuses, and no OTA engine can lift it: an engine must match the bundled schema (EngineManifest.swift:65; ios/engine-updates.md:73-75) | runs old merge until its OTA engine arrives, then new |

**Schema version: no bump.** A v4, even one written only when the set is present, locks every iPhone build out
of that record until a new store build ships. The additive field converges with old readers (§3).

**What old code does to the set, and why the shown opt-in tolerates it.** Old code can drop rows: its merge
keeps one side's object whole, and an old web Turn on writes a fresh object. It never invents a row or moves a
stamp, and the stored object always keeps today's meaning. A dropped row has one of two effects:
- The outcome falls back to today's rule.
- A token whose cancel was dropped shows as active. Every writer marks a token cancelled only after its row is
  already off on the server (reminders.ts:434-440; the 404 and erase paths likewise). An update never refills
  an off row (app/lib/reminder-v2.server.ts:355-373). So that token's next schedule push gets a 404 and
  writes its cancelled row back. Turn off cancels every active row, so a second cancel of an off row changes
  nothing.

## 5. Redaction

The rows live inside `reminderOptIn`, which `redactRecord` strips by name (mcp-tools.ts:84-88), so old and
new MCPs hold them back. A top-level field would pass through its `...rest` (:87, :96) in every MCP built
before the change. The schema PR still adds `reminderOptIn.tokens` to docs/agent-access.md rule 12 (:226).
It also adds tests through `read_record` and tool dispatch, on a record holding two tokens, asserting that
no token or address appears anywhere in the output (US-32 AC41).

## 6. What the set keeps

The server keeps one row per address (`enrolByEmail`, reminder-v2.server.ts:238-259). A new token appears
only for a new address or after a proved delete. The verified lane hands back the same token for an existing
row, and the per-token register takes that as a newer row of the same token. So a person holds a few rows.
- **Drop cancelled rows?** No. A dropped row stops the join being idempotent: a stale copy's active row for
  that token comes back, shows as on until its next push's 404, and repeats on every stale merge.
- **Addresses:** a cancelled row needs its token as its key, not its address (ruling 2).

## 7. Files already in the field

No migration. A file reads as one row, its object, and shows that row. On first merge no existing file
changes meaning, and files with one token are rewritten byte for byte. A file that merged case 3 before the
change keeps cancelled A.

## 8. Erase, the switch hold and R1

- **Erase:** the gate is unchanged. The erase writes a fresh object, and the teardown (reminders.ts:387-408,
  `toCancel`) cancels every active row in the set, not only the shown one.
- **Switch hold (A4, R19):** unchanged. The switch's one new write rides the edit that saves the new token.
- **R1 (H126):** the gate still drops a losing copy's rows, so R9 does not cover a token written after an
  erase's read. R1's re-check (B re-reads; under a newer erase holding no active row for its token, B cancels
  its own row) reads `rowsOf`.
- **Order (owner's ruling stands):** R1, then R9, then R19's hold union.

## 9. Considered and not chosen: a bridge

A tab holding token T active would cancel T on merging a strictly newer opt-in naming another token. The owner
chose the set. A bridge cannot be bound to one record (no record identity exists; every never-erased record
shares the erase identity `[0, null]`), and it fixes nothing the set does not.

## 10. What stays open

R9 narrows H115; it does not close every route:
- the address-lane refresh, which refills an off row and issues no token, so no record can hold it;
- tokens dropped before the change ships;
- a mixed-fleet window, where old merges fall back to today's rule (permanent for App Store 0.1 until
  updated, but its merges only drop rows, §4);
- the erase gate's drop (R1), and R1's own limit: a device that never returns.

## 11. Engine release

The engine runs `mergeFiles`, so PR 1 needs an engine release. No new native means the same bridge id and the
same `minAppBuild` (11). Schema 3 means the release can go over the air. Ruling 3: raise `minVersion` with it.

## 12. PR split and test plan

1. **health-core (merge class: adversary and Codex).** `ReminderTokenRow`, `rowsOf`, the migrate step, the
   merge, `shownOptIn`, `setReminderRow`, the rule 12 line.
   - Failing first, citing US-17 (new AC, `tools/next-ac.mjs` at build time): case 3 merges to active B in
     both orders.
   - Cases 1-6 as a table, both orders.
   - A seeded property test ported from the prototype: the three laws plus all orders, up to 3 tokens, epochs.
   - The stored object equals `pickNewerOptional` over all rows.
   - A one-token file round-trips byte for byte; `tokens` with a non-string token is dropped.
   - The US-64 seeded snapshot (merge-property-pins.test.ts) stays unchanged: it draws one token, so no
     `tokens` is written.
   - Redaction tests (§5).
   - Run the pins that scan these files: merge*.test.ts, erase-stale-optin.test.ts,
     roadmap-file.schema.test.ts, state-edits.test.ts, record-writers-stamp-anchor.test.ts, mcp-tools.test.ts,
     ios/engine/stamp-anchor.test.ts, ios/engine/read-record-cache.test.ts.
2. **web writers.** reminders.ts and reminders-control.tsx over `shownOptIn` and `setReminderRow`.
   - Failing first: two devices over the real store and an in-memory cloud. Case 3 shows on, and its Turn off
     cancels B.
   - Turn off with two active rows posts two cancels; a 404 cancels one token; the switch writes the old token
     cancelled in the new token's edit; the erase teardown cancels every active row.
   - The AC17 table rows still pass.
3. **engine release** after PR 1 merges, with the `minVersion` floor if ruled. The parity fixtures cover the
   new merge.

## 13. Rulings needed before code

1. **Where the rows live.** (a) nested `reminderOptIn.tokens`: every MCP since 2 Oct holds it back; old web
   Turn on drops it. (b) a top-level field: old writers never drop it, but every MCP built before the change
   shows it to an agent. **Pick (a).**
2. **Cancelled rows' address.** (a) keep it, the least code; (b) new writers blank it on cancelled rows,
   since nothing reads an off row's address. **Pick (b).** It drops old addresses as rows go off, at the cost
   of one more rule in `setReminderRow`.
3. **Engine floor.** (a) raise `minVersion` with the release: it shortens the window for builds 11-15 and
   costs nothing, since the bridge is the same; (b) leave it. **Pick (a).**
4. **Usage signal.** A status-only `product_events` event when a Turn off or erase cancels more than the
   shown token (provider tag only). It counts cleanups attempted, not rows left live: that residual cannot be
   seen from the client. **Pick: add it**, and judge R9 by the tests, not by the event.
5. **Story.** One new US-17 AC for the set; AC17's Limit then names only what §10 keeps open. **Pick: yes.**
