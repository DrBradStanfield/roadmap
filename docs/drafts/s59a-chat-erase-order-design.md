# S59a: the chat erase follows the record erase (design note)

Evidence: origin/main at 50da2fced (25 Nov). Root fix R3. Paths under packages/health-core/src unless named.

## The goal

An erase side step runs only once the erase stands. Chat history is tombstoned only after the record's erase has
landed or is held. A chat session opened under an erase shows and keeps nothing from before it, on whichever device
opens it next.

This follows a pattern the record already uses: an owed step, judged from the record's erase identity, settled by
whichever session next reads the record under that erase (`clearOwed`, `settleClear`, record-session.ts:325-328,
:358-370).

## The order today

`deleteAllDataSession` runs `steps.chat().eraseAll()` inside `beforeErase` (record-session-erase.ts:195-200, called at
:110), before the build (:114) and the flush (:126). Tombstones are monotonic (chat-history.ts:11).

Chat sits first for a reason. On the iPhone, US-25 AC16 asks that a kill between the two steps never leaves the
record erased and the chat whole (ios/engine/cloud.ts:259-261, :285-302). Moving the chat step after the flush, and
nothing else, would give up that promise. So the move comes with a read rule.

## The design chosen (option B)

1. **Order.** `deleteAllDataSession` runs the chat step after `s.erase()` returns, when `s.eraseIdentity` moved: the
   same "the erased copy stands, landed or held" test the page's erase commit uses (widget-src/src/lib/roadmap-data.ts:409).
   An erase that does not stand never touches chat. On the device tier the chat commit runs before
   `clearNamedFiles` (:141-145), whose comment changes.
2. **Read rule.** A `ChatSession` opened or reloaded under record erase E does not list, and does not save replies
   into, any conversation last updated before E's `erasedAt`. Its next write tombstones them: an owed chat erase.
   `listConversations` (chat-session.ts:170-172) and `liveOf` (:101) take the rule from an
   `underErase: () => string` passed at `open` (:152). The web passes chat-history-access's `eraseIdentity`; the
   engine passes the session's. No new field: the marker and the record's `erasedAt` already exist.
   - Any session that takes the erase in shows no pre-erase chat, whatever the order of the two writes.
   - A kill between the record write and the chat write is settled at the next open, anywhere.
3. **iPhone.** ios/engine/cloud.ts moves its chat step after `deleteAllData` the same way. The device-only erase
   (ios/engine/erase.ts:5, :29) moves too, for parity.

Costs. The rule compares times across devices: a device whose clock runs far behind could hold back a conversation
started after the erase. The same `erasedAt` order already governs same-epoch erases (`eraseTimeLater`).

### Options weighed

- **A: a dry build before `beforeErase`.** A build that would throw refuses before any chat write. Small
  (record-session-erase.ts only), but the order otherwise stays, so it reaches only part of the goal.
- **B (chosen): chat after the erase stands, plus the read rule.** Replaces A; A is not built.
- **C: chat after the flush, no read rule.** Rejected: it gives up US-25 AC16's kill promise.

## PR split

Reaches the iPhone engine, so it needs an engine release and a simulator run.

1. **Read rule.** chat-session.ts (`underErase` at `open`), widget-src/src/lib/chat-history-access.ts (passes it),
   chat-history tests. Lands first: the order cannot move until every reader holds the rule.
2. **Order, web and health-core.** record-session-erase.ts, widget-src/src/lib/roadmap-data.ts (`deleteUserData`).
3. **Order, iPhone engine.** ios/engine/cloud.ts, ios/engine/erase.ts, DataEraserTests.swift. Its "refusal after the
   chat step" branch becomes unreachable and is deleted in the same PR, with its sentence in EraseText.swift (a
   removal for Brad, not a rewording). Engine release.

Story text: US-11 AC2/AC3 and US-25 AC16.

## Tests

Each cites US-11 AC2/AC3, S59a.

1. record-session-erase.pins.test.ts: "a build refused before the swap writes no chat tombstone". Mutation caught: chat
   back in `beforeErase`.
2. Same file: "a write refused and put back (S57) writes no chat tombstone and `chatErased` is false". Mutation: chat
   committed before the flush.
3. Same file: "an erase whose write failed but is held (identity moved) still commits the chat". Mutation: the commit
   gated on `success`.
4. chat-history.test.ts: "a session under erase E lists no conversation last updated before E's erasedAt" (AC2g).
   Mutation: the filter removed.
5. Same file: "a conversation updated after erasedAt stays listed and saved". Mutation: the filter holds everything.
6. Same file: "the held conversations are tombstoned by the session's next write". Mutation: filter at read only.
7. widget-src/src/components/HealthTool.chat-prefetch-remote-erase.test.tsx (extend): "a tab that takes the erase in
   before the chat commit shows none of the old chat". Mutation: the web passes no `underErase`.
8. ios/engine/cloud.test.ts "cloudErase": the pin "the chat written before the cloud write" flips to after. New:
   "killed after the record write: the next open settles the chat". Mutation: no read rule.

**Words:** none new. One iPhone sentence is deleted with its dead branch.

## Owner rulings (2026-11-25)

- Option B is the target: chat tombstones only once the record erase stands, plus the read rule.
- Not started. It reaches the iPhone engine and needs an engine release.
- Open question: does the read rule also cover the iPhone's own chat? Yes would close US-25 AC16's "Known gap": an
  erase made on another device would then erase the phone's chat too, a behaviour change that needs Brad's yes. No
  keeps the rule to cloud chat files.
