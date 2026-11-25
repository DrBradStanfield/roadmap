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

## Owner's answers (2026-11-13), built in the follow-up PR

1. Yes: Drive document download none -> 300 s; `DriveAdapter.readDocument` passes the caller's signal.
   Correction to the question: the hosted import refuses Drive before any download
   (mcp-import.server.ts:346), so no hosted call reaches this today; the fix holds the adapter contract.
2. Yes: Dropbox document download 30 s -> 300 s.
3. Keep Drive's size-scaled upload bound.
4. Yes: GitHub and WebDAV uploads pass `mayHaveWritten` (existing string). Their failed upload
   reconciles as the other two do: `saveDocuments` is provider-agnostic.
5. Yes: the three cosmetic Drive calls get 30 s through `fetchOrFail`, still fire-and-forget.
6. Leave the iPhone's 60 s idle timeout; one sentence in ios/architecture.md.
7. Filed as state lead U15.
