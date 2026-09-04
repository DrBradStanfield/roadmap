# MCP build notes

The dated build logs behind [mcp-architecture.md](mcp-architecture.md) — what was
actually built, in what order, and what each decision cost. Split out of that file on
2026-09-03, when it passed the 500-line cap. The map lives there; the receipts live
here. Everything below is verbatim from that file.

## Build notes — Phase 1, 2026-09-02

Written by the implementation, not by the decision. Four places where the build
departed from the text above, each toward the stricter reading.

**`kid` is a key fingerprint, not an index.** §2 says "`kid` = index" and, in the same
row, that rotation PREPENDS the new key. Those cannot both hold: prepending renumbers
every key, so every blob already issued would decrypt under the wrong one and every
active connection would break at the moment rotation was supposed to preserve them. The
`kid` is now a short SHA-256 fingerprint of the key itself. Prepend and append both
work, and "seal with the first, accept any" is literally true. A rotation test is what
found it.

**Every issued value carries its client id in front of the sealed blob.** The AAD binds
a blob to one client (§4), and unsealing therefore needs to know which client — but a
bearer token arrives alone and Dropbox echoes exactly one opaque `state`. The id travels
with the blob as `<client id>~<blob>`. It feeds the AAD, so it is bound rather than
trusted; at `/token`, where the request states `client_id` independently, the two are
compared, and that comparison is a real check. On `/mcp` there is nothing to compare
against, so the binding is only carried. Stated plainly: a stolen bearer token is a
stolen bearer token, and no framing fixes that.

**RFC 8252 loopback redirects are ON (2026-09-02, owner decision).** A command-line
client has no callback host of its own: it listens on an ephemeral port on the user's own
machine, and cannot know the port until it binds one. So `redirectMatches(registered,
requested)` in `app/lib/mcp-clients.server.ts` tries an exact string first, then allows a
loopback pair to differ in the PORT and in nothing else — both `http:`, host exactly
`127.0.0.1`, `[::1]` or `localhost` and identical on both sides, same path, same query, no
userinfo, no fragment. It is the only redirect comparison in the codebase, used at
`/authorize` and at `/token`. `https://localhost` is refused: the exemption exists because
a local listener cannot hold a certificate, so a URL that claims one is not it. The host
match is exact, so `localhost.evil.com` and `127.0.0.1.evil.com` are ordinary public names
and get nothing.

Why this is safe, and why it does not contradict CLAUDE.md's "localhost is never on an
allow-list": that rule is about CORS — granting a browser origin access to our endpoints.
This grants nothing. It is where the user's own browser carries an authorization code back
to a process on the user's own machine, and that code is worthless without the PKCE
verifier, which never left the process that asked for it. PKCE S256 is mandatory on every
authorization, and our consent screen names the client before anything is granted.

Claude Code publishes a second metadata document,
`https://claude.ai/oauth/claude-code-client-metadata`, behind the same Cloudflare challenge
as the web one, so it is pinned in `KNOWN_CLIENTS` too — `client_name` "Claude Code",
redirects `http://localhost/callback` and `http://127.0.0.1/callback`, copied verbatim.
Gemini CLI registers dynamically with `http://localhost:<port>/oauth/callback`.

**A fifth padding bucket, 4096.** §4 names 256/512/1024/2048. A provider refresh token
longer than the 2048 rung would otherwise fail to seal at all; the extra rung means it
fails to leak instead of failing to work.

**Guide buttons.** They stayed `soon` until the DNS and the operator steps landed, so no
guide ever pointed a reader at a 404. They flipped when the connector went live.

**Second review pass, 2026-09-02.** A fresh adversarial review found nine issues; all are
fixed on this branch, and the paragraphs above are corrected rather than annotated.
The behaviour changes worth naming here:

- **The `max_writes` pool is gone** (§3 mitigation 4, rewritten). It locked honest users
  out and bounded no attacker. The allowance is now per connection per hour, keyed on the
  hash of the provider refresh token.
- **The refresh lifetime is absolute.** It used to slide: every refresh set `exp` to 90
  days out, so a client refreshing hourly never expired. The original expiry now travels
  through the refresh grant.
- **Consent is cookie-bound and Dropbox gets a nonce** (§4). Reproduced before the fix: a
  sealed state from an unauthenticated `GET /mcp/authorize` plus a forged
  `GET /mcp/callback` minted an authorization code with no consent step at all.
- **`getClientIp` prefers `Fly-Client-IP`.** It preferred the first hop of
  `X-Forwarded-For`, which a client sets itself, so every per-IP limiter in the app was
  bypassable by one header. Fly's proxy writes `Fly-Client-IP` itself
  (https://fly.io/docs/networking/request-headers/). It now takes a second argument,
  `getClientIp(request, 'fly' | 'shopify')`, so the storefront's own app-proxy callers
  keep trusting `X-Forwarded-For` and only the MCP routes trust `Fly-Client-IP`.
- **`providerRevokeUrl()` is surfaced on the consent and callback pages**
  (`app/routes/mcp.$.tsx`), not just documented here — the page that grants access also
  names the exact provider page that revokes it.
- **Bodies are capped** — 64 KB at the OAuth doors, 1 MB at `/mcp`, 413 over — and
  `/token` (per IP) and `tools/call` (per connection) are rate-limited. The limits are
  deliberately generous: a whole vendor's users share one egress range, so a tight per-IP
  limit would lock out honest traffic rather than an attacker.
- **A malformed `MCP_SEAL_KEYS` or `MCP_CLIENT_HMAC_KEY` now disables the feature**
  (404, plus one log line naming the variable and never its value) instead of turning
  every route into a 500.
- **Not done, deliberately: no Dropbox access-token cache.** Every `tools/call` refreshes
  one. A memory cache keyed by connection would cut that to one per four hours, but it
  would put live provider credentials in a process-wide map — a new thing to leak, and a
  new line in §1's inventory of what we hold. The per-connection rate limit bounds the
  refresh rate instead.

**The canonical vendor clients are pinned (2026-09-02, first live connections).** ChatGPT
connected end to end over CIMD. Claude did not: `https://claude.ai/oauth/mcp-oauth-client-metadata`
is served behind a Cloudflare managed challenge that answers any datacenter fetch with a
403 `text/html` and `cf-mitigated: challenge`, reproduced from inside the Fly machine, so
`resolveClient` returned null and the consent page said "We do not recognise the app". Both
canonical ids now resolve from `KNOWN_CLIENTS` before any fetch, which the draft's §4 "MAY
apply its own policy" explicitly allows. Two things follow. The pinned redirect URIs must
also pass `isAllowedRedirect`, and a test asserts that so the pins and the policy cannot drift.
And the failure mode of pinning is a vendor changing its callback: the user sees a plain
refusal at `/mcp/authorize` — never a redirect, because that would make us an open
redirector — and we see one `console.error` naming the reason and the client HOST only, no
URL and no query. That log line is the whole detection mechanism, and it is enough,
because the user's report and Sentry's line arrive together.

**Residual risks noticed during the build that this document does not name.**
- **DNS rebinding on the CIMD fetch has a real window.** We resolve, check every address
  is public, then call `fetch`, which resolves again. `fetch` offers no way to pin the
  connection to the address we checked. §4 asks for the re-check at connect time and
  that is implemented; the TOCTOU gap is not closed, only narrowed.
- **The hourly write allowance is per machine.** It is an in-memory map, so N Fly
  machines multiply it by N. The 5× weighting still bounds the falsification attack, but
  by 5×-per-machine-per-hour. Stated in §3 rather than only here.
- **Dropbox's 500-byte `state` limit is believed, not verified.** The nonce is 43 chars,
  so the constraint no longer binds, but the first live connection is still the test —
  the runbook asks for it explicitly.

---

## Build notes — Phase 2, 2026-09-02

Two places where the build departed from the text above.

**`prompt=consent` is unconditional, and "only when needed" was the wrong shape.** The
brief asked for the prompt only when a refresh token is actually needed. For a stateless
server it is needed every time: Google issues a refresh token on a first authorization or
an explicit re-consent, and never on a silent re-authorization — and a connection with no
refresh token cannot be sealed, so it cannot exist. Omitting the prompt would fail for
every user who has ever connected the widget, and then need a second trip through Google
with the prompt anyway: two redirects for the same token. So we ask once. What that costs
is one of the account's 100 refresh-token slots per connection, shared with the widget,
and §4 already says never to mint a SPARE — which we do not: one token, inside a flow the
user just consented to. The runbook says what to check if a user reports the website
quietly disconnecting.

**A failed verify is now retryable for EVERY backend, not just Drive.** §7 step 3 is
`SyncManager.verifyAfterWrite`, which detected a lost update and then threw a fatal
error — detection with no step 4. It now throws `LostUpdateError extends ConflictError`,
so the existing retry loop re-reads, re-merges and writes again; the arrays are
append-only, so writing the same rows twice is the same as writing them once. Dropbox and
the local file adapter inherit this and are better for it. The one thing that changed for
them is the give-up message, which no longer says "nothing was written" for a loss where
something plainly was.

**Phase-1 blobs default to Dropbox.** `provider` is sealed into every blob phase 2 mints,
but the blobs phase 1 already handed out carry no such field, and a blob in a vendor's
token store can never be updated by us (§7). Reading `undefined` as a provider would have
500ed every tool call on Brad's own live connections the moment this deployed. So
`unpackSealed` — the one place a sealed payload is ever opened — defaults a missing or
invalid provider to `dropbox`, which is what every one of those connections is. Two tests
pin it: an old access blob works, and an old refresh blob mints an access blob that names
Dropbox. It is not migration code; it is the only honest reading of a credential we
cannot re-issue.

**And a bug is now an error with an id.** `tools/call` wraps the tool run and answers
JSON-RPC `-32603` on the failed request, the way the stdio server has since phase 0. A
`ToolContractError` used to escape the endpoint and become a 500 that a vendor could not
match to anything it had sent.

**The `-32603` gate got narrower, and a real bug used to hide as a refusal (commit
`b4fbf49`).** `callHostedTool`'s catch ran everything except `ToolContractError` through
`describeStorageFailure`, whose fallback message is "The record did not answer. Nothing
was written." A `TypeError` inside a tool, inside the corrections guards, or inside merge
therefore reached the assistant worded as a refusal against a cloud folder that was fine
— and nothing was logged. The nuance that hid it: both REST adapters called bare `fetch`,
which throws a raw `TypeError` on a dead network, so the catch-all was also the only thing
correctly turning a real provider outage into "did not answer." Deleting the catch-all
outright would have mislabelled every outage as a bug. The fix is `fetchOrFail()`
(`packages/health-core/src/adapter.ts`) — one function the adapters' own network calls go
through, so a dead connection becomes a typed storage failure at the source rather than
an ordinary exception at the top. `callHostedTool` now checks `isStorageFailure(error)`
before deciding: true still becomes a worded refusal, false is logged (tool name and error
name only, no health values) and rethrown as `-32603`.

**And a provider that never answers is now bounded.** `fetchOrFail` had no timeout, so a
cloud provider that accepted the socket and then went silent hung the tool call until the
platform killed it — no error, no id, nothing for the assistant to say. It now runs every
provider call under `AbortSignal.timeout(FETCH_TIMEOUT_MS)` (30 s), merged with any
caller signal via `AbortSignal.any`, with the body read inside the same bound. The abort
throws the same `StorageError('<Provider> did not answer', UNREACHABLE_HINT)`, so silence
lands where an outage lands: a worded refusal past the `-32603` gate, and still inside the
widget's Sentry `/did not answer/` ignore.

**`fetchOrFail`'s bound is feature-detected, and document uploads get a longer one.**
`fetchOrFail` also runs in the browser (the widget's Drive and Dropbox adapters import it
through the health-core barrel), where the Vite target is `modules` — Safari 14/15 has no
`AbortSignal.timeout` and 16–17.3 no `AbortSignal.any`, so calling either unguarded made
the bound itself the outage and killed every read and save there. Both are now
feature-detected; missing either, the call runs unbounded as it did before. And the flat
30 s is a record-file bound: `driveCreateFile` scales it with the body size (30 s + 1 s
per 10 KB, capped at 5 min) so a 10 MB upload is not aborted mid-send on a slow uplink.

## Build note — the widget's end of the loop, 2026-09-02

**A connector's write is now pushed to the open page, not polled for** (US-34). The
60-second timer was the visible half of the round trip: an assistant wrote, and the user
waited up to a minute or reloaded. `StorageAdapter` gained an OPTIONAL
`watch(fileName, onChange, signal)`, and `RoadmapStore.startLiveRefresh` uses it in place
of the poll wherever an adapter has one — Dropbox through `files/list_folder/longpoll` on
the `notify` host (no access token: the cursor is the credential), Google Drive through
`changes.list` on a 3-second beat, because a browser cannot receive Drive's push channel.
The poll survives only for adapters with no watch. The tab's visibility still governs
everything: hidden aborts the watch, visible takes it up again. Nothing about the hosted
server changed — this is the widget hearing what the server already writes.

## Build note — structured tool results, 2026-09-03

**Every tool now declares an `outputSchema` and answers with `structuredContent`**
(spec 2025-06-18 §Tools). The words each tool returns are unchanged — guides and tests
pin them, and they stay in `content` as the serialized JSON the spec asks for on
compatibility grounds. What is new is the same answer typed: `mcp-tools.ts` holds a zod
output schema beside each input one, and the published JSON Schema mirrors it, checked by
the same parity test that already guards the inputs. A record and a plan keep their shape
loosely — both are published in full elsewhere, and restating them here would be a second
definition to drift. Both servers pass the structure through untouched; the stdio
server's saved-backup note stays in the text, where it belongs. A refusal is an error
result and carries no structure.

## Build note — `import_documents`, 2026-09-04 (US-35)

**Shipped.** The eighth tool, hosted-only: extract (read files, no write) and commit
(write, guarded) as two calls sharing one signed receipt. Two sources — a Dropbox
folder listing, and a ChatGPT-dragged file fetched from `files.oaiusercontent.com` —
both landing in the same extraction pipeline the website's upload route already uses.
A Google Drive connection refuses the folder route outright: `drive.file` cannot see a
file the user did not create through this app, so there is nothing to list.

**The Haiku PDF document-block check passed.** One real call, a 1-page PDF sent whole
as a base64 `document` block rather than as extracted text or a page image: 3,369 input
tokens. Confirms the `pdf` page type in `lab-extraction.ts` is viable cost-wise before
it carries production traffic.

**The 40 s budget (`MCP_IMPORT_BUDGET_MS`) is ChatGPT's constraint, not ours.** ChatGPT
cuts a tool call at 60 s; 40 s leaves room for the round trip and the response to land
inside that window rather than racing it. Files are extracted three at a time, and a
file the budget does not reach comes back as `skipped: time` or in `remaining` for a
follow-up call, so a slow connection loses time, not data.

**What remains: live verification.** Runbook step 8a is written but not yet run against
a real Dropbox account and a real ChatGPT drag — that needs a deployed server and a
human at the keyboard, same as every other hosted-MCP verify step.
