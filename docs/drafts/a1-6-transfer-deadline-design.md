# A1-6: one transfer deadline for every cloud call (design note)

Ledger row `docs/untangle/leads/A1-6.csv`. Read from `main` at `80fa11cf9`.

## Today

Every bounded call goes through `fetchOrFail` (`packages/health-core/src/adapter.ts:104`). It aborts the
real request with `timeoutDeadline` (`AbortSignal.timeout`, or a timer on Safari 14/15), never a race.
A caller's own signal joins it with `AbortSignal.any`. On the iPhone the engine shim turns the abort into
`URLSessionTask.cancel` (`ios/engine/shim.ts:213`). On timeout it throws `StorageError('<Provider> did not
answer')`, with "may have landed" when the call passed `mayHaveWritten`, else "Try once more". It never retries.
Web, iPhone engine (`ios/engine/cloud-adapters.ts:120`) and hosted MCP (`app/lib/mcp.server.ts`) share the
health-core Dropbox and Drive adapters. The CLI and stdio MCP use `file-adapter.ts` (disk, no network).

| Call | Deadline | Enforced by | On timeout | file:line |
|---|---|---|---|---|
| Record read/write, list, delete, lookups, version (Dropbox, Drive, GitHub, WebDAV) | 30 s | fetchOrFail default | error; write says "may have landed"; next save reads, merges, verifies | adapter.ts:93 |
| Dropbox document upload | 300 s | fetchOrFail | metadata-only row, orphan blob harmless (§5.3) | dropbox-rest.ts:159 |
| Drive document upload (multipart create) | 30 s + 1 s per 10 KB, max 300 s | fetchOrFail | same | drive-rest.ts:195 |
| GitHub document read, upload | 300 s | fetchOrFail | viewer error / metadata-only row; upload says "Try once more" (no `mayHaveWritten`) | widget github.ts:28 |
| WebDAV document read, upload | 300 s | fetchOrFail | same as GitHub | widget webdav.ts:28 |
| Dropbox document download (viewer, iPhone, MCP import) | 30 s | fetchOrFail default | viewer error; MCP: its 40 s budget also applies | dropbox-rest.ts:143 |
| Drive document download | **none**; caller signal ignored | bare `fetch` | hangs until the platform gives up | drive-rest.ts:220 |
| Drive document lookup before it (`driveFindFileId`, `docTarget`) | 30 s, no caller signal | fetchOrFail | error | drive-rest.ts:218, :673 |
| Token refresh (Drive via server, Dropbox) | 5 s | timeoutDeadline / fetchOrFail | transient; Reconnect only on a refused grant | drive-token-reply.ts:42, dropbox.ts:340 |
| Account email (GitHub, Dropbox) | 10 s | timeoutDeadline | throws; retried next visit | github.ts:69, dropbox.ts:299 |
| Dropbox code exchange / Drive exchange | 10 s / 15 s | fetchOrFail | error on connect | dropbox.ts:155, drive.ts:230 |
| Drive folder rename, root-file move (cosmetic) | **none** | bare `fetch` | swallowed | widget drive.ts:531, :574, :578 |
| Dropbox long-poll, Drive changes poll | loop signal only (long-poll must outlive 30 s) | bare `fetch` | backoff, re-cursor | dropbox.ts:277, drive-watch.ts:77 |
| Hosted MCP import, every adapter call | min(own, 40 s budget) | deadlineSignal + AbortSignal.any | refusal text, file skipped | mcp-import.server.ts:72, :342 |
| iPhone: any engine request | Swift idle timeout 60 s (URLSession default) on top of the JS bound | URLSession | rejects as no answer | ios/HealthRoadmap/Engine/EngineHTTP.swift:97 |

## Proposal

One module, `packages/health-core/src/transfer-deadline.ts`: `TRANSFER_DEADLINE_MS` with one constant per
kind (`call` 30 s, `document` 300 s, `tokenRefresh` 5 s, `accountEmail` 10 s), `documentUploadMs(bytes)`
for Drive's scaled upload, and `timeoutDeadline`, the one helper that aborts the request (moved from
adapter.ts). `fetchOrFail` and every caller above read their number from it. `deadlineSignal` (an epoch
deadline for a whole tool call) stays in adapter.ts: it bounds a call budget, not one request.
The two exchange bounds (10 s, 15 s) stay at their call sites: one site each, each with its own reason.

**Built here (no number changes):** the module; adapter.ts, dropbox-rest.ts, drive-rest.ts, widget
github.ts, webdav.ts, dropbox.ts, drive-token-reply.ts read it; the four copies of 300 000 and two local
`DOCUMENT_TIMEOUT_MS` go.

## Questions for the owner (each changes a number or words a person could notice)

1. **Drive document download has no deadline** and ignores the caller's signal (drive-rest.ts:217-223,
   `DriveAdapter.readDocument` takes none, :633). The hosted import's Drive download is not aborted at its
   40 s budget, despite US-35 AC5. Adopt `document`: none -> 300 s, and pass the signal through.
2. **Dropbox document download is 30 s**; GitHub and WebDAV reads are 300 s. Adopt `document`: 30 -> 300 s
   (web viewer, iPhone viewer; MCP keeps its 40 s budget).
3. **Drive upload scales** (a 100 KB file: 40 s); the other three are a flat 300 s. Keep, or flat 300 s?
4. **GitHub and WebDAV document uploads omit `mayHaveWritten`**, so a stalled upload says "Try once more"
   where Dropbox and Drive say "may have landed". Same existing words, different hint shown.
5. **Cosmetic Drive calls** (drive.ts:531, :574, :578) have no bound: adopt `call`, none -> 30 s?
6. **iPhone's 60 s URLSession idle timeout** is a second bound beside the JS one: leave, or set it from
   the policy in Swift?
7. Out of scope, noted: `upload-pipeline.ts:139` races local file processing with a timer and leaves the
   work running (not a cloud call).
