# R9: how reminder opt-ins and cancels merge (design note)

Evidence: main at 5c3c5ae65 (27 Nov). Leads: H115 (this root fix), H126 (R1), A4 (R19). Paths under
packages/health-core/src unless named. Owner's call: merge semantics.

## The goal

Every live reminder row on the server stays reachable from the record: some copy of the file names its
token, so a Turn off on any device can reach it. The fix must converge: every device, in any merge order,
ends with the same opt-in.

## 1. Today's rule

The record holds one opt-in, a singleton: `reminderOptIn?: { status: 'active' | 'cancelled', token, email,
provider, updatedAt, lamport }` (roadmap-file.ts:235-242). A cancel flips `status` and keeps the object, so the
cancel can win a merge (:228-234).

The equal-epoch merge picks one of the two singletons (merge.ts:735-738, `pickNewerOptional`, :347-354):
present beats absent; otherwise the newer by `stampIsNewer` (:279-282): time first, then lamport
(`cmpClock`, record-time.ts:76-80), then the whole object's stable string. Token and status play no part
except in that last tie-break. Across an erase the higher `eraseEpoch` wins and the opt-in is the winner's,
whatever the loser holds (merge.ts:590-596, :668-707).

Writers (all on the web, widget-src/standalone/reminders.ts; each goes through `setReminderOptIn`,
state-edits.ts:153-155, which stamps past the prior stamp and bumps the lamport):

| Writer | Writes | Where |
|---|---|---|
| Turn on (manual or auto-enrol) | active, new token | :239 |
| Cloud switch, same address | same token, new provider | :311 |
| Cloud switch, new address | posts a cancel for the old token, keeps it in the file, then Turn on writes the new token over it | :329-349 |
| Turn off | cancelled, same token | :440 |
| A 404 on a schedule push (email unsubscribe) | cancelled, same token | :488-491 |
| Erase | cancelled, token `''` | erase.ts:79-84 |

The iPhone app writes no opt-in (ios/HealthRoadmap/Reminders/ReminderScheduler.swift:18; its reminders are
local notifications) but merges the record through the engine, so it carries the field. MCP reads strip it
(mcp-tools.ts:86).

Two devices, tokens A and B, stamps t1 < t2:

| # | Device 1 | Device 2 | Merged today |
|---|---|---|---|
| 1 | active A (t1) | cancelled A (t2) | cancelled A |
| 2 | cancelled A (t2) | active A (t1) | cancelled A |
| 3 | active A (t1) | active B (t2) | active B |
| 4 | active B (t1) | cancelled A (t2) | cancelled A |
| 5 | cancelled A (t1) | active B (t2) | active B |
| 6 | cancelled A (t1) | cancelled B (t2) | cancelled B |
| 7 | anything, epoch n | erased, epoch n+1 | cancelled, token `''` |

Case 4 arises when one device turns reminders on while another, not yet merged with it (the poll is
60 s, record-session.ts:38), turns off the token it showed. Today's rule is a max over a total order, so it
is commutative, associative and idempotent (property test below: zero failures).

## 2. The proposed rule

"A cancel beats an active opt-in only for its own token." As a function of two singletons a, b:

- same token: the newer, as today;
- different tokens, one active and one cancelled: the active one;
- different tokens, same status: the newer, as today.

Against the table, only case 4 changes: it merges to active B. Cases 1-3 and 5-7 are unchanged.

## 3. Convergence

**On the singleton, the rule is not associative.** It is commutative and idempotent, but a singleton
forgets the rows it beat, so grouping decides the answer. The lead's example, active B (t1), active A (t3),
cancelled A (t4):

- (B ⊔ A) ⊔ cA = A ⊔ cA = cancelled A
- B ⊔ (A ⊔ cA) = B ⊔ cA = active B
- (B ⊔ cA) ⊔ A = B ⊔ A = active A

Three merge orders, three records. Devices that sync in different orders diverge for good.

**On a per-token set, it is.** Keep one row per token, merged per token by today's order (the same
`mergeByKey` the medications use, merge.ts:287). That is a join of last-write-wins registers: commutative,
associative and idempotent. Derive the opt-in from the set: the newest active row if any, otherwise the
newest row. A cancel then replaces only its own token's row, which is the proposed rule, and because the
view is a function of a converging set, every order gives one opt-in.

**Throwaway property test** (prototype of all three rules in the scratchpad, not committed): rows over
3 tokens × 2 statuses × 3 times × 2 lamports, plus absent.

| Rule | Exhaustive triples | Commutative | Idempotent | Associative | Random sets: more than one result |
|---|---|---|---|---|---|
| Today (singleton, newest) | 50,653 | 0 failures | 0 | 0 | 0 of 5,000 |
| Proposed, on the singleton | 50,653 | 0 | 0 | 3,276 failures | 522 of 5,000 |
| Proposed, per-token set | 27,270,901 | 0 | 0 | 0 | 0 of 5,000 |

Random sets: 2-5 rows each, every permutation (188,902), each folded in three tree shapes. On the set, no
draw had a cancel hide another token's active row (0 of 5,000).

## 4. Interactions

**Erase.** The epoch gate already takes the winner's non-row fields (merge.ts:590-596). A per-token set must
be one of them: the erase writes it empty beside the `''` cancel, and a losing copy's tokens do not travel.
So the set changes nothing for H126 (R1): a token dropped by the gate is still in no copy. The erase teardown
(reminders.ts:387-408) could cancel every active token in the set, not only the shown one.

**The switch hold (A4, R19).** Between the old row's cancel and the new token landing, the file keeps the old
token active on purpose: auto-enrol treats a cancelled opt-in as the person's decision and never enrols again
(reminders.ts:294), so a cancel written there would end reminders for good. With a per-token set the switch
must write the old token cancelled in the same edit that writes the new one, or a later Turn off of the new
token would surface the old one as active. And Turn off must cancel every active token in the set. Both edits
sit in the functions R19 restructures, so R19 should land first.

**R1 (H126).** Owner lean there: the device that wrote a token re-checks after its write lands. That
mechanism also covers case 4 without a merge change; see option C.

**Records in the field.** No existing file changes meaning under the set design: a file with only the
singleton reads as a one-row set, whose view is that row. A file that merged case 4 before the change holds
only cancelled A, so no new merge rule changes it, and option C watches only tokens minted after it ships.

**Schema and fleet.** Older readers keep unknown top-level fields but take the local copy's whole
(merge.ts:710-713), so an old engine or web tab merging two new files keeps one side's set and drops the
other's rows, and they fall back to today's rule. The repo's precedent is a version raised only when a file
carries the new shape (`recordSchemaVersion`, roadmap-file.ts:30-45): a file whose set holds more than one
token would be v4, and an older reader refuses it; files with one token stay v3. The engine bundles
merge.ts, so the set needs an engine release with a `minVersion` floor; no new native, so the bridge id and
`minAppBuild` stay. Old stdio MCP and CLI installs would refuse a v4 file until updated.

## 5. Options

**A. Keep today's rule.** No change, converges. Case 4 merges to cancelled A, as US-17 AC17's Limit records.

**B. The proposed rule, on a per-token set.** Converges (shown above). Case 4 merges to active B, and the
switch shows on, which matches the live row; any Turn off reaches it. Costs: a new field, a conditional
schema v4, an engine release, two writer changes (switch writes the old token cancelled; Turn off cancels
every active token), and the set keeps every token ever issued (a few per person; a cancelled row can drop
its address). Mixed-fleet merges fall back to today's rule until old readers update. Never build the rule
on the singleton: it diverges.

**C. Merge unchanged; the device that minted a token cancels it once no record names it.** After a Turn on
lands, the minting device keeps the token (memory and local storage, like `SWITCH_CANCELLED_KEY`) and checks
each merged record it reads under the same erase. If the opt-in no longer names that token (a newer cancel
of another token, a newer Turn on, a 404), it posts a cancel for its own row and forgets it. If an erase
moved the record, the same check covers R1's first route. Converges trivially, since the merge does not
change. Case 4 ends off everywhere with no live row, which honours the later stamp, as today's merge does.
Web only (the only opt-in writer), no schema or engine change. Limit: it needs the minting device to read
the record again; a device never opened again does not run the check. One check serves H115 and H126.

**Recommendation: C.** It reaches the goal for every case where the minting device returns, with no merge,
schema or engine change, and it is the same mechanism R1 needs, so one PR closes two leads. B is the
stronger guarantee but carries a fleet migration for a race that needs two devices inside one poll. If C's
usage signal shows rows the check never reached, B is the follow-up, and this note's proof stands for it.

## 6. Test plan and PR split (option C)

Usage signal: the server already counts cancels; add a status-only `product_events` event for a
minter's cancel (`reminder_unreferenced_cancel`, provider tag only; no address, token or schedule).

**PR 1 (web, Lane A, R19 landed first).**
- A pure `transition(state, event)` for the minted-token watch (`idle | watching(token, erase)`), with a
  table test: written, merged-still-named, merged-not-named, erase-moved, cancel-ok, cancel-failed (keeps
  watching; next visit retries).
- Failing first, citing US-17 and the H115 limit in AC17: the real store over an in-memory cloud, two
  devices, case 4. Device 2's cancel lands after device 1's Turn on; device 1's next merge posts a cancel
  for B, counts no `reminder_optout`, and both copies read cancelled A.
- Same for case 3 (a newer Turn on elsewhere) and H126's first route (an erase moved the record).
- Holds: the token survives a reload (local storage) and is cleared after its cancel; a blocked storage
  falls back to memory; the same-address switch (:311, same token) is not a trigger.
- Guard tests touching reminders.ts: `reminders.test.ts` AC17 table, `reminders-erase-cancel.test.ts`,
  `reminders-cancel-superseded.test.ts`, `reminders-control.test.tsx`.

**If B is chosen instead,** three PRs: (1) health-core: the set, its migrate path and the v4 rule, with
`mergeFiles` property tests over the set (the scratchpad prototype's three properties, all orders) and the
US-64 seeded snapshot (merge-property-pins.test.ts) unchanged, since it draws one token and the field is
written only when present; (2) web writers: switch and Turn off over the set, erase teardown over every
active token; (3) engine release with a `minVersion` floor. Merge class: fresh adversary and Codex on PR 1.
