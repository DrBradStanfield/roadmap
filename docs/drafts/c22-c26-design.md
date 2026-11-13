# C22 and C26: a late reply and a failed list read (design note)

## Today

The web chat's turn, list and load are one union in `ChatState` (packages/health-core/src/chat-turn.ts:50-56),
changed only by `transition` (:266). No booleans, refs or timers hold a mode. The list is
`unread | waiting | reading | read` (:46); a thread read is `Load` `none | loading | failed` (:48), and a
failed load already has its own Try again (widget-src/src/hooks/useChatState.ts:240). chat-session.ts (the
engine's history file) holds no mode for either; chat-turn.ts is not in the engine bundle.

## C26: two failure paths, neither retried

(a) `listConversations` answers null (an error status, a bad body, a caught throw:
widget-src/src/lib/chat-api.ts:159-183). `listLanded` (chat-turn.ts:244) moves the list to `read` and keeps
the old titles. `list-wanted` (:309-310) acts only on `unread`, so no later open reads again.
(b) It throws: `cloudHistory()` and `store.listConversations()` sit before the try (chat-api.ts:151-153).
`readList` (useChatState.ts:176-178) never dispatches `list-landed`; the list stays `reading` and the
rejection reaches the callers uncaught (ChatSection.tsx:85,97; ChatEmbed.tsx:55).
Only an erase shown (chat-turn.ts:237-238) or a reload reads again.

Fix:
- List gains `{ phase: 'failed' }`. `list-landed` with null goes there and keeps the old titles.
- `list-wanted` reads from `unread` or `failed`, with today's guard (an erase moving waits) and today's
  auto-open rule (a guest, untouched chat: Q7). An erase shown still reads from `failed`, as from `read`.
- chat-api.ts: the store open and its list move inside the try, so a throw is reported and answers null
  (path b becomes path a). `readList` is unchanged.
- The retry moment is the one the code has: the chat being opened. The tool page's Chat tab stays
  mounted and hidden (HealthTool.tsx:700-713); showing it fires ChatEmbed's visibility observer
  (ChatEmbed.tsx:53-56), which sends `list-wanted`. The blog embed does the same on scroll-in. The FABs
  remount ChatSection on every open, so they already read afresh. No timer, no loop: one read per
  open, and only after the last read failed.

User-visible change: after a failed read, opening Chat again shows the saved conversations in History.
No strings show or change. Pinned today by useChatState.slice3-pins.test.tsx (US-15 C26), which flips.

## C22: a reply after the person left its thread

Sequence: ask in thread A; open thread B before the reply lands. `sendMessage` gets the reply and, at
chat-api.ts:324-336, writes question and reply to chat-history.json (`recordExchange`,
chat-session.ts:210-257) whatever the person has on screen. Then `done` (chat-turn.ts:190-191) sees the key
changed: memory keeps B, A's edits go out with `stayed: false`, and ChatEdits applies nothing (Fable,
PR 1306). The "Not saved" words exist only as a banner in memory (ChatEdits.tsx:282,
RECORD_CHANGED_SINCE_ASKED, "Not saved: your record changed since you asked.").
Reopen A: `open-thread` reads the stored turns (useChatState.ts:182-187), which hold the reply with no
marker. Stored wins today; memory never had A's reply. So the reopened thread is already "what is
stored"; what is stored is the problem.

The owner's ruling (C22 row): store the marker on that turn so reopening A shows
"Not saved: you opened another conversation before this reply arrived." That needs:
1. New user-facing words (that sentence exists nowhere in the code).
2. A new optional field on the stored message (chat-history.ts:41-49 `ChatFileMessage`, the widget's
   `ChatMessage`), written by `recordExchange` (chat-session.ts, in the engine: bytes change) or patched
   after it, since the reply is saved before `done` knows the person left. A file-shape and merge call.
3. The iPhone's parity (Swift chat view and the engine door, ios/engine/app-doors.ts:101).
Saving A's edits instead would reverse the PR 1306 ruling, so it is not an option here.

Decision: C22 is not built. Options for the owner: (A) as ruled: the words above, the stored field
(`notSaved?: 'left'`, set once, immutable per id like `isFallback`), web and iPhone together; (B) the marker
only when the reply carried edits (a reply with no edits saved nothing to lose), same words and field;
(C) hold until the iPhone chat series.

## Verify at batch end

- Tool page, phone width: block the list request, open Chat (empty History), unblock, switch tabs away
  and back: History lists the saved conversations. Blog embed: same by scrolling away and back.
