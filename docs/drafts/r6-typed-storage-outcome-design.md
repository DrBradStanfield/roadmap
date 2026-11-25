# R6: every storage failure carries a typed outcome (design note)

Evidence: origin/main at 0145be0ee (25 Nov, after PRs 2063 and 2070). This note covers the health-core half
(leads S62b, S57c, H127, M8 web). The phone half (H134, M6, M8 phone, S57d) follows the same field.

## The goal

The adapter that raises a storage error says what happened: refused, may have landed, or no answer. Every reader
reads that one field. No reader decides from a status code, an error name or the message text.

## Where readers decide today

| Where | Reads | Decides |
|---|---|---|
| write-refusal.ts:54, :63-71 `isDefiniteRefusal` | status table, `error.name`, `cause.name` | landed or not |
| sync-manager.ts:143, record-session-erase.ts:214 | `isDefiniteRefusal` | applies the may-have-landed mark after the fact |
| sync-manager.ts:160, :254 `describeStorageFailure` | `status === 401 \|\| 403` | which words (the words stay) |
| sync-manager.ts:259 | `error.hint?.startsWith(EARLIER)` | keeps the earlier-landed hint |
| save-state.ts:128 `saveFailureCause` | `status === 401` | auth or retry |
| standalone/connect.ts:61 `lostAtLoad` | `status === 401` | signed out or unreachable |
| lib/error-diagnostics.ts:47 `recordFailure` | a regex on `message` | Sentry: no answer or a failure |
| ios/engine/cloud-adapters.ts:87, :265-313; entry.ts:368 | text and status | phone half |

Decisions made inside the raising adapter are fine and stay: dropbox.ts:320, :355; drive.ts:437;
drive-token-reply.ts:51; github.ts; webdav.ts; dropbox-rest.ts.

Two raise points mark the wrong outcome today. Drive's update branch reads the file version before it uploads
(drive-rest-files.ts:242-256), inside the try that marks every error "may have landed" (drive-rest-record.ts:251-261).
The create branch marks its own POST's 4xx the same way (:232, :244-246). An answer to a request sent before any
upload, or a 4xx to the upload itself, stored nothing.

## The design chosen

`StorageError` gains one typed field, set at construction:

```ts
type StorageOutcome = 'refused' | 'may-have-landed' | 'no-answer';
// reason widens: 'storage-full' | 'not-found' | 'reconnect' | 'auth' | 'rate-limited'
```

- `fetchOrFail` and `untilAborted` (adapter.ts:116-148, :155-164) raise `'no-answer'`. For a write, no answer still
  counts as may-have-landed.
- An adapter raises `'refused'` only for an answer to the upload itself, through one shared helper `refusalOf(res)`.
  It holds today's status table (write-refusal.ts:54) and sets `reason: 'auth'` on 401.
- Drive's `fail()` parses its error reason once: `storageQuotaExceeded` becomes `'storage-full'`, a rate or daily
  limit becomes `'rate-limited'`. The phone half then drops its regexes.
- `uncertainWrite` and `mayHaveLanded` keep their names (PR 2063's API) but read and write the field, not the
  WeakSet. A rewrap (sync-manager.ts:164) copies the field, as it copies `reason` today.
- sync-manager.ts:259 reads a typed `earlierLanded` flag, not the hint's first words.

### Options weighed

- **A (chosen): a field on the error.** It survives rewraps and a second bundle's copy of the module. The web upload
  engine is its own bundle (adapter.ts:84-88), and a module-level WeakSet does not cross bundles. Cost: one migration
  PR over every adapter.
- **B: keep the WeakSet, add a mark for no-answer, move the status table into the adapters.** Smaller, but the mark
  lives per bundle and is lost on any rewrap that forgets to re-mark. Readers still need fallbacks for unmarked errors.

## PR split

Serial. None runs in parallel with R4, R5 or R20, which share record-session.ts.

1. **S62b (Lane A).** drive-rest-record.ts: the version read moves out of the may-have-landed try; the create's own
   4xx stays a refusal. drive-rest-files.ts if the read is split out. Stale comments: write-refusal.ts:49,
   mcp-hosted-t9-pins.test.ts:6 and :32, ios/engine/entry.ts:259. Changes phone Drive behaviour: engine release and
   simulator run.
2. **Pins (test-only).** A table: each adapter failure, as the caller sees it, to `isDefiniteRefusal`,
   `saveFailureCause`, the `describeStorageFailure` kind and `lostAtLoad`. Plus the M8 pin: a Dropbox 5xx refresh
   gives `saveFailureCause` 'other' and `lostAtLoad` unreachable.
3. **Move, health-core.** adapter.ts, write-refusal.ts, sync-manager.ts, save-state.ts, drive-rest-files.ts,
   drive-rest-record.ts, dropbox-rest.ts; record-session-erase.ts:214 loses its re-mark. No phone behaviour change,
   but the bundle changes: engine release, simulator run at the checkpoint.
4. **Move, web only.** standalone/connect.ts:61, lib/error-diagnostics.ts:47; the widget's dropbox.ts and drive.ts
   set the field on their own refresh refusals.
5. **S57c.** save-state.ts:126-129: a 401 on a write that may have landed is cause 'other', so a retry is owed.
   Engine release (the phone does not read `retryDue`, so no phone behaviour change).

PR 1 lands first; PR 2's pins land before the moves in PRs 3 and 4.

## Tests

- PR 1: "US-09 AC43 (S62b): a 403 on Drive's pre-upload version read is a definite refusal, and the erase is put
  back". Mutation caught: the read back inside the may-have-landed try.
- PR 1: "a 400 answer to Drive's record create stored nothing". Mutation: the catch at :244 marks it again.
- PR 2: the outcome table. Mutations: 401 dropped from the refused set; every failure marked may-have-landed.
- PR 3: "a failure after a write keeps may-have-landed through SyncManager's rewrap". Mutation: the field copy at
  sync-manager.ts:164 dropped.
- PR 4: "a fetch with no answer reports 'Network request did not answer'". Mutation: the field dropped in
  `fetchOrFail`'s catch.
- PR 5: "US-09 AC30 (S57c): a 401 on Drive's verify read owes a retry, and the retry asks for a fresh token first".
  Mutation: `saveFailureCause` ignores the field.

**Words:** none change. **Net prod LOC:** about +25 (field, helper), -15 (WeakSet, the hint check, the re-mark).

## Owner rulings (2026-11-25)

- Option A: a typed `outcome` on `StorageError`, set where the error is raised.
- S57c: a 401 that came after an upload that may have landed owes a retry. The web Drive adapter already drops its
  token on any 401 (drive.ts:437), so the retry refreshes first; a failed refresh is a definite `reconnect` and the
  retry stops.
- Status: PRs 1 and 2 in flight.
- PR 3 (PR 2108) claims only what it migrated: it names the outcome on the record write paths of Dropbox, Drive,
  GitHub and WebDAV, Drive's record lookup and version check, document uploads' status classification and
  localStorage's full store. Raise sites it did not reach keep main's default, read as "may have landed".
- PR 3b: `outcome` becomes a required constructor argument on `StorageError`, with no default from a status table,
  so a raise site that forgets it does not compile. The status table becomes a helper (`answerOutcome`) the raise
  site calls on purpose. Its list of known sites is in US-10 AC16's Limit sentence.
- Waiting on Brad (wording, raised by PR 3): (1) a full Drive on the hosted MCP keeps the access-refusal text
  ("reconnect") until it has words of its own; what should it say? (2) a failure that may have landed with no words
  of its own reads "{provider} did not answer", though for a 408, 429 or 5xx the provider did answer, with an error;
  keep it, or word it as an error answer?
