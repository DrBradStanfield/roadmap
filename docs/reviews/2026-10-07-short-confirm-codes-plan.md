# UUID-shaped step receipts instead of sealed step blobs (US-36 AC5/AC9, US-35 AC7)

2026-10-07, v2. Revised after Codex (R1, R2) and a fresh Opus 5.5 adversary (B1–B4, R5–R13, S1, S2).

## What happened

The 1.0.2 demo run was on the reviewer record, in live ChatGPT (Instant), through our own
"Health by Dr Brad" developer app.

- **Positive 4 (`file_results`):** the extract ran at 01:04:21 UTC.
  - The commit's approval card read: "Suspicious content: opaque or disguised payload. Long
    encoded receipt/token in commit".
  - After Allow once, ChatGPT answered "the confirmation step was blocked before anything was
    written". No commit reached the server.
  - The retry showed the same warning and passed (commit at 01:06:42).
- **Positive 5 (`correct_value`):** the proposal ran at 01:07:40.
  - After the user's "Yes, correct it.", ChatGPT answered "The correction was blocked before it
    could be written".
  - It showed no approval card, and no confirm reached the server.

## Why

Both two-call paths hand the model a `seal()` blob of about 400 characters: AES-256-GCM over JSON,
padded and base64url. The model must copy it back. Every confirm that differed from its proposal
only by that blob was the one flagged or blocked.

The values that passed unflagged were row ids. Those are UUIDs (`correct_value`'s `id`). Nothing
in a step needs secrecy; only integrity matters.

## Design

**Imports (S1): the receipt is the pending file's own id, a plain UUID.**

- **The id:** `payloadId` stays `crypto.randomUUID()`, so nothing changes at mcp-tools.ts:1852
  and the UUID guard stays.
- **The pending file:** it becomes `{ v: 2, payload, issued, mac }`.
  - `issued` is epoch seconds as a JSON number.
  - `mac` is 32 lowercase hex characters: HMAC-SHA256 truncated to 128 bits.
- **MAC input:** `"import" \n payloadId \n issued \n sha256hex(JSON.stringify(payload)) \n
  hash(connection) \n hash(clientId) \n hash(resource)`.
- **What `stash` returns:** `{ receipt: payloadId, expiresAt: issued + RECEIPT_LIFETIME }`.
- **`open`, in this order:**
  1. The UUID regex (otherwise "not valid").
  2. Read `imports/pending-<id>.json`. If it is missing: "That receipt names no pending import:
     it was committed, discarded or mistyped. Nothing was written. Extract again if the user
     still wants it." (B3)
  3. Check the shape `v === 2` (otherwise "not readable, extract again").
  4. Recompute the MAC with this connection's values and compare with `timingSafeEqual`
     (otherwise "not valid for this connection").
  5. Check the window (otherwise "expired").
  6. Everything after that is unchanged: ids checked, then charge, then write, then delete.
- **Old files:** a pending file from before the deploy has no `v` and refuses as not readable.
  The sweep is name-based and removes it.

**Proposals (S2): the confirm receipt is UUID-shaped, 128 bits.**

- **Format:** `iiiiiiii-jjjj-mmmm-mmmm-mmmmmmmmmmmm`, lowercase hex only.
  - `i` is `issued` as 8 hex characters: 32 bits, unsigned, good until 2106.
  - `j` is 16 random bits.
  - `m` is 80 bits of HMAC-SHA256.
- **Strict regex:** `^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`. Uppercase,
  padding, whitespace and any other length are refused before anything else runs.
- **MAC input:** `"proposal" \n <the received 12 characters of i and j, verbatim> \n subject \n
  conn \n hash(clientId) \n hash(resource)`, where `subject = callIdentity(name, args)`. The MAC
  covers the exact characters received, never a re-encoding (B1).
- **Comparison:** recompute the 20 hex characters of the MAC and compare them as strings with
  `timingSafeEqual`, so no decoder is involved. `issued` is parsed with `parseInt(_, 16)` only for
  the window.
- **Window:**
  - `issued > now + 60 s` is invalid; within 60 s ahead counts as early (R8 skew).
  - `now < issued + 10` is early.
  - `now > issued + 15 min` is expired.
- **Single use:** the spend map is keyed on the whole receipt plus the connection hash (R10).
- **One message for invalid (R6):** "That confirm receipt does not match these arguments on this
  connection, or is not ours. Nothing was written. Call `<tool>` again without confirm, with
  exactly what the user approved, to propose afresh." Expired and early keep their own wording.
  The AC and the tests state this change.

**Shared parts**

- **One window table** in the seal module, `STEP_WINDOWS[kind] = { nbfSeconds, ttlSeconds }`. Issue
  and verify both read it (R9).
- **Keys:** HKDF from each seal key, with info `mcp/<kind>-step/v1`, which is distinct from every
  `typeKey` info. We sign with `sealKeys()[0]` and verify against all of them. A code signed with a
  key since removed is refused.
- **Deleted:**
  - `issueStep` and the old blob `openStep` (a new `openStep` in `app/lib/mcp-step.server.ts` is the shared MAC-then-window check);
  - `'import' | 'proposal'` leave `BlobType`, so `seal()` and `typeKey` no longer take them;
  - the forged-`seal('import')` test and the "id not readable off the wire" assertion retire, with
    the reason stated.
- **Kept:** the schema keys (`receipt`, `confirm`) and the word "receipt" (R7: no "code" wording).
  - `MAX_RECEIPT_LENGTH` drops from 1024 to 64. An old blob sent within its last hour gets the
    schema refusal, and the AC says so.
- **One fix in passing:** the plan's v1 claim that candidate ids are UUIDs was wrong. They are
  `c1`, `c2` and so on (R12).

## Docs and ACs updated in the same commit (Codex R2, B4)

- **Stories:** US-35 AC7 and US-36 AC5/AC9 get the new format and its guarantees. The connection
  and client binding, the window, single use, verify-before-charge and the refusal wording are all
  kept. Then regenerate `user-stories.html`.
- **Other docs:** `docs/mcp-architecture.md`, `docs/mcp-import-design.md`,
  `docs/lab-upload-connector.md`, `docs/reference.md` and `docs/mcp-build-notes.md`, wherever they
  say the steps are sealed blobs.
- **Usage signal:** the existing `mcp_tool_call` rows. The confirm rate is confirms divided by
  proposals for each two-phase tool.

## Tests (each cites US-36 AC9 or US-35 AC7)

- **Proposals:**
  - a round trip;
  - changing each MAC input gives `invalid`: kind, the `i` part, the `j` part, the MAC part,
    subject, conn, client and resource;
  - uppercase, padding and whitespace variants are refused;
  - a timestamp above 2^31 round-trips;
  - 9 s gives `early`;
  - 15 min + 1 s gives `expired`;
  - a time 61 s in the future gives `invalid`, and 30 s ahead gives `early`;
  - rotation in and out;
  - reuse gives "already used";
  - a proposal receipt sent as `commit.receipt`, an import receipt sent as `confirm`, and an old
    AES blob of either kind each get a worded refusal, with no throw and no charge.
- **Imports:**
  - extract then commit, end to end, through `hostedImporter`;
  - a missing file gives "names no pending import";
  - a tampered payload or MAC, another connection, or another client gives `invalid`, with no
    charge and the file not deleted;
  - an expired receipt gives `expired`;
  - a v1 pending file gives "not readable";
  - a forged UUID never charges.
- **Keys:** the HKDF info per kind differs from every `typeKey` info, matching the guard at
  `mcp-auth.server.test.ts:74`.
- **Size:** tools/list stays under its cap.
- **Existing tests:** the "different arguments" assertions move to the new wording.

## Then (R5)

1. Run `test:all`, then `/simplify`.
2. A fresh adversary and Codex on the diff.
3. Commit, then deploy edu.
4. Live in ChatGPT on the reviewer record, three trials each on Instant of `correct_value`, the
   `file_results` commit and `update_profile`. Count every "Suspicious content" card and every
   block, and claim fixed only on 0 of 9.
5. Then record the demo.

## As built (after /simplify)

- **The step module:** step code lives in `app/lib/mcp-step.server.ts`. `mcp-seal.server.ts` is back to blobs only and shares `deriveKey` with it.
- **One lifecycle:** `signStep(kind, fields, conn, …)` and `openStep(kind, fields, conn, mac, issued, …)` serve both kinds, and the connection is a required parameter of every MAC.
- **The MAC input:** `kind, issued (decimal), …fields, conn, hash(client), hash(resource)`. The issue time is bound directly. For proposals, `i` and `j` are still covered exactly as received.
- **The pending-file pre-check:** it keeps the `payload` object check. A file without one gets the worded "not readable" refusal, never a thrown error.
