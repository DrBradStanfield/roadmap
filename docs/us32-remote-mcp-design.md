# US-32 · Hosted remote MCP server — design (rev 4, **DECIDED — FINAL**)

2026-09-01. Brad has ruled on every open question; this document is now the build reference, not a proposal. It is committed as `docs/us32-remote-mcp-design.md` alongside the US-32 story when implementation starts.

**Intent:** a web ChatGPT/Claude user clicks connect, authorizes, and their AI reads and saves their health record in THEIR cloud. **Architecture:** fully stateless — no token table, nothing per-user in Supabase. The provider refresh token is sealed into the bearer token we issue.

Closes the gap `docs/guides/getting-started.md` admits: "A web AI cannot write to your Dropbox or Drive… That is the clunky step."

**Decisions taken 2026-09-01 (Brad):** promise paragraph approved as drafted · **hosted write surface is append-only including a distinct corrections pathway** (Brad, overruling the interim removal) · kill gate removed, build the full thing · `get_plan` paraphrase approved with the instruction field · Drive deferred behind a specified algorithm · Dropbox-only v1.

---

## 1. Trust model, stated brutally

**Split custody.** The AI vendor holds a sealed blob — AES-256-GCM ciphertext, useless to them. We hold the key and hold no blob. Compromise needs our Fly secrets *and* a vendor's token store: ciphertext and key never sit in one organisation.

**What we keep per user: no record of them.** Not "nothing." In memory and outside our control there exist the auth-code `jti` set, per-IP rate maps, the CIMD metadata cache, Fly's proxy/router metadata, and Sentry event metadata. None is health data and none is a per-user row we can query, but the honest claim is *no durable per-user state*, not amnesia.

**What transits.** The record's bytes, in memory, for one tool call. Chat and lab extraction already transit health values (constitution, US-12/15/16).

**What we never store.** Health values at rest, in logs, in Sentry, in `product_events`. `reminderOptIn.token` is stripped from every read (`docs/agent-access.md` rule 12).

**What is genuinely new and worse.** Today Brad's server *cannot* read a record. After this, a live bearer token is a standing capability over one folder in a user's cloud, and **our server reads health values in memory on every call.** Statelessness removes our breach surface; it does not remove the capability.

**Revocation.**
- *Can:* expire — access blob 1 h, refresh blob 90 d (§4 explains why that number is ours).
- *Can:* kill everything at once by rotating `MCP_SEAL_KEYS` with no overlap. All-or-nothing; our only server-side revocation.
- *Cannot:* revoke one user. A denylist needs state.
- *Real kill switch is provider-side,* which is right for local-first: `dropbox.com/account/connected_apps` or `myaccount.google.com/connections`.
- *Shared app identity is unavoidable.* Separate identities per surface were evaluated and are impossible — Dropbox app-folder scoping and Google `drive.file` visibility are both tied to the app, so a second identity sees an empty folder. Unlinking therefore **also disconnects this website from the folder**. Disclosed, not hidden.
- *Also lost with the table:* we cannot list which AIs are connected.

**Promise — APPROVED. Additive and conditional; constitution line 11 is untouched** and stays true for every user who never connects an AI. A second paragraph is added beneath it, applying only to those who do:

> *"If you connect an AI assistant, your record still lives only in your storage — but our server reads it, in memory, to answer your assistant, and your assistant holds a sealed credential only we can open. We keep no copy. You cancel it in your Dropbox or Google settings; that also disconnects this website from your folder, and you can reconnect here in one click."*

It ships in `docs/user-stories.md` **in the same commit as Phase-1 code — never before.** A promise that describes a capability we have not deployed is a false promise in the other direction.

---

## 2. Thinness inventory

| New | Why not smaller |
| --- | --- |
| `app/routes/mcp.$.tsx` | MCP endpoint plus `/authorize`, `/token`, `/register`, `/callback`, `/disconnect`. One splat, one file. |
| `app/routes/[.]well-known.$.tsx` | RFC 9728 and RFC 8414 documents must sit at host root, so they cannot live under `/mcp`. One splat serves both. |
| `app/lib/mcp.server.ts` | JSON-RPC dispatch, four tool definitions, Zod schemas. |
| `app/lib/mcp-auth.server.ts` | Seal/unseal, stateless AS, two provider OAuth clients. |
| **In-memory state (counted, not free):** bounded LRU for CIMD metadata (256 entries, TTL per HTTP cache headers, 1 h max), auth-code `jti` set (60 s TTL), per-IP rate maps. Per-machine, lost on deploy — by design. | |
| **Zero tables.** | |
| Moves into `packages/health-core/src/`: `adapter.ts`, `sync-manager.ts`, and `computePlan`/`renderJson` from `tools/get-plan.ts` | **Not pure moves.** `sync-manager.ts` gains the Drive-specific pre-write version re-check (§7), so this is a move *plus* a behaviour change with new tests. `record-edits.ts` separately gains the `expectedValue` parameter (§3). Net prod LOC is positive, modestly. |

**Keys — one Fly secret.**

| Secret | Use | Rotation |
| --- | --- | --- |
| `MCP_SEAL_KEYS` | Ordered list of 32-byte keys; `kid` = index. Seal with the **first**, accept **any**. Rotation is one atomic `fly secrets set` — prepend the new key. No window where a machine holds a partial view. | Overlap keeps a leaked key live up to the refresh lifetime (90 d); no-overlap forces every user to reconnect. **Default incident response is no-overlap**, because a leaked seal key is retroactive (§4). |
| `MCP_CLIENT_HMAC_KEY` | HMAC over self-contained DCR `client_id`s. | **User-visible, not silent.** Anthropic freezes a connector's auth settings after it is added and OpenAI performs DCR once per connection, so rotation forces every affected user to **remove and re-add the connector**. Rotate only with a comms plan. |

Reuse otherwise: `mergeFiles`, `migrateFile`, `SyncManager`, `createRateLimiter`, the plan derivation. No new npm dependency — `node:crypto` covers AES-256-GCM, HKDF, HMAC.

---

## 3. Tool surface v1 — five tools, append-only including corrections

| Tool | Kind | Note |
| --- | --- | --- |
| `read_record` | `readOnlyHint` | Migrated record minus `reminderOptIn.token`; `metric`/`since` filters. |
| `get_plan` | `readOnlyHint` | `renderJson(computePlan(file))`. The one thing only this repo can do; costs no Anthropic spend. |
| `add_measurement` | append | One core metric, SI canonical, validated by health-core. |
| `add_lab_values` | append | Batch — the lab-report case, which is the point. |
| `correct_value` | append (**separate pathway**) | Mirrors `record-edits.correctValue` / `RoadmapStore.correctMeasurement` exactly: append a new row carrying `correctsId` and the **original `recordedAt`**, then flip the old row to `entered-in-error`. **Never folded into an add** — a slot-occupied add is *rejected*, and the rejection names the held row and points the agent at `correct_value`, mirroring the CLI's `refuse()` hint in `tools/edit-record.ts:274`. |

**Corrections ship hosted, as their own pathway** (Brad's ruling, 2026-09-01, overruling the interim removal). A correction *is* an append under this data model — the protocol is append-with-`correctsId` plus a status flip on the superseded row — so withholding it would ship an incomplete protocol and push agents toward improvising something worse. The pathway stays distinct from `add_*` at every level: separate tool, separate arguments, separate rejection path.

Read and write tools are separate by construction — no catch-all with a `method` argument.

**VERIFIED HOLDS (review):** the write surface is restricted to **append-only arrays only**. `packages/health-core/src/merge.ts` (lines 24–43) enforces row immutability there via `unionRows`, while current-state lists and singletons are last-write-wins where a second writer can overwrite the user. So v1 never writes medications, supplements, screenings, profile, documents or reminders, and never deletes. Corrections stay inside the append-only arrays the merge protects.

**Blast radius, stated honestly.** A prompt-injected agent **reads first**, so it knows every row id and value. With `correct_value` it can therefore *silently falsify every current clinical value* in roughly 30–100 calls. Each original flips to `entered-in-error`, which is **irreversible**. `get_plan` then generates a plan from the falsified record, and the user sees a coherent, wrong protocol. Append-only prevents data *loss*; it does not prevent data *corruption*. **Brad accepted this residual knowingly on 2026-09-01, choosing protocol completeness over the smaller surface.**

**Mitigations — MANDATORY for the hosted corrections pathway, not optional hardening.** Shipping `correct_value` hosted without all four is not the decision Brad approved.
1. **`expectedValue` on `CorrectValueRequest`.** Today it is `{id, newValue, now}` (`packages/health-core/src/record-edits.ts:57`) with no check. Hosted calls must state the value they expect to find, and a mismatch rejects — an agent working from a stale or hallucinated read writes nothing. Work item returns: `record-edits.ts`, an **optional** flag in `tools/edit-record.ts`, and tests. **Must not break the shipped CLI path (US-31)** — optional there, required on the hosted surface.
2. **Age limit — refuse `correct_value` on rows older than N days; N = 90, tunable.** Corrections fix recent mistakes; a lab result from three years ago is history, not a typo. 90 days covers a quarterly test cadence with room to spare, and puts the bulk of the record permanently out of reach of an injected agent.
3. **Per-call caps** on rows written, `add_lab_values` included.
4. **Weighted `max_writes` budget**, sealed inside the access blob and spent by refresh rather than mutation — the only durable per-connection quota statelessness allows, because the budget travels with the credential. **A correction costs 5× an add.** Justification: the falsification attack needs one correction per metric, so weighting corrections is what actually bounds it, while a legitimate session corrects rarely and adds in batches — a lab-report import is many adds and zero corrections. 5× lets a normal session correct a handful of values without noticing the budget, and forces an attacker through five times as many refresh round-trips.

**Vendor confirmation prompts are NOT a security boundary:** the MCP spec states annotations are untrusted hints, and "always allow" is one click. Do not count them.

**`get_plan` clinical surface — APPROVED.** `--json` already carries hedged reasons and citations inline per suggestion (US-30 AC3). Add a top-level `instruction` field asking the model to preserve the hedging and the citations when presenting. No threshold or citation changes, so the three-file rule is not triggered.

Every write: read → `migrateFile` → apply → `mergeFiles` → conditional write, enforcing `docs/agent-access.md` in code: fresh UUIDs, `meta.updatedAt` now, `lamport`/`eraseEpoch`/`lastDeviceId` untouched, one active row per (metric, day), identical values dropped.

---

## 4. Auth chain, with no storage anywhere

> **Prerequisite — LANDED (commit `4ee99d3`, 2026-09-01).** OAuth secrets travel in query strings. `SENSITIVE_PARAMS` in the parity-tested pair (`instrument-scrub.mjs`, `packages/health-core/src/sentry-scrub.ts`) now also redacts `code`, `state`, `code_verifier`, `code_challenge`, `client_secret`, `refresh_token`, `access_token`, `id_token`, `assertion`, with exact-match semantics pinned by test. Standing rules for this build: **no `/mcp` route may log a request URL**, and Fly's proxy access-log setting must be checked before Phase 1 ships.

**We are the authorization server.** An IdP would mean user accounts — the one thing this product does not have. The identity we need is "the person who can authorize this folder," and the provider proves it.

**VERIFIED HOLDS (review): registration needs no registry.** Anthropic supports `oauth_cimd`; CIMD requires no RFC 7592 round-trip; OpenAI performs DCR once per connection and reuses the result; RFC 7591 §3.2.1 permits a shared/self-contained `client_id`. We advertise `"client_id_metadata_document_supported": true` **and** `"none"` in `token_endpoint_auth_methods_supported` — Claude needs both or silently falls back to DCR. DCR fallback: `client_id = "c." + base64url(metadata) + "." + HMAC(MCP_CLIENT_HMAC_KEY, metadata)`, verified on every use against a redirect-URI allowlist (`https://claude.ai/api/mcp/auth_callback`, OpenAI's callback, RFC 8252 loopback with port ignored).

**CIMD fetch is an SSRF surface. Policy is mandatory:** `https` only; DNS-resolve and reject non-public IPs, **re-checked at connect time** (rebinding); **zero redirects**; 5 s timeout; 64 KB body cap; `application/json` required; no credentials sent; results into the bounded LRU of §2. `/mcp/authorize` is per-IP rate-limited **before** any fetch.

**Seal specification.** Payload → 12-byte CSPRNG nonce (prepended) → AES-256-GCM under a **per-type key** `HKDF(MCP_SEAL_KEYS[kid], info = "mcp/" + typ + "/v1")`, with **AAD = kid ‖ typ ‖ client_id ‖ resource**. AAD gives domain separation (a state blob can never be presented as an access blob) and binds each blob to its client and audience. **Padding: fixed-bucket to 256/512/1024/2048 bytes** — without it, blob length leaks the provider and roughly which credential is inside.

**Stateless flow.** `/mcp/authorize` validates client, PKCE `S256` only, and `resource`, then shows **our** consent screen — required anyway by the confused-deputy rule, since we forward to a static upstream client id. Sealed `state` carries {client_id, redirect_uri, code_challenge, resource, nonce, exp +10 min}. Provider callback exchanges for the provider refresh token and mints an auth-code blob (exp **+60 s**). `/mcp/token` unseals, verifies PKCE/client/redirect/expiry, issues access (1 h) and refresh (90 d) blobs. `/token` is `application/x-www-form-urlencoded`; `/register` is `application/json` — two parsers in one route file, a real trap. A dead grant returns `invalid_grant`, never a custom code, or Claude never recovers.

**Provider leg.** Reuse the existing OAuth clients — mandatory, per §1's shared-identity finding. Same `GOOGLE_DRIVE_CLIENT_ID`/`GOOGLE_DRIVE_SECRET` from `app/routes/api.google-token.ts`; same Dropbox app key from `widget-src/src/storage/dropbox.ts`, now with its secret as a confidential client. Scopes: Dropbox `files.content.read`, `files.content.write`, `files.metadata.read`; Google `drive.file` only.

**Threats and residuals.**

| Threat | Position |
| --- | --- |
| **Retroactive key compromise** | An access blob wraps a **non-expiring** provider credential. Our `exp` is *advisory* — enforced only by our own unseal path. A leaked `MCP_SEAL_KEYS` opens **every blob ever issued**, including expired ones captured months earlier. The worst property of the design, and why no-overlap rotation is the default incident response. |
| **Provider adopts refresh-token rotation** | Verified 2026-09-01: **neither Dropbox nor Google rotates refresh tokens on refresh.** The design depends on it. If either adopts rotation, every connection breaks **simultaneously** with no server-side remedy — we hold no row to update. This closes the door on generic/self-declared providers. |
| **Google's 100-refresh-token cap** | Per account **per client id**, shared with the widget. A widget reconnect can therefore **evict the MCP grant** (Google silently drops the oldest). Never mint a spare token. |
| Vendor token store leaks | Ciphertext only; inert without our key. |
| Token passthrough | Forbidden by spec and construction: we mint our own token, validate audience, never forward a provider token. |
| Auth-code replay | **Known spec deviation.** OAuth 2.1 requires single-use codes; stateless cannot enforce it. Redemption needs the PKCE `code_verifier`, which never leaves the client, so a passive interceptor gains nothing. Window is 60 s. Per-machine `jti` set is best-effort, **not authoritative** across Fly machines. Documented, not papered over. |
| Prompt injection | §3 — the silent-falsification residual, knowingly accepted, bounded by the four mandatory mitigations (`expectedValue`, 90-day age limit, per-call caps, 5×-weighted `max_writes`). |
| Abuse | Per-IP, per-machine limiter — fine against floods, useless when distributed. No Anthropic spend here, so the app-proxy HMAC's cost rationale does not transfer. |
| Tenant isolation | One rule: the connection derives from the bearer token and nothing else. No tool argument ever names a user, file, or path. |

**The 90-day refresh lifetime is ours, not a provider requirement.** Dropbox refresh tokens have no idle expiry; we cap deliberately to bound how long a leaked blob stays useful. Cost: quarterly re-consent for every active user — real friction on an annual-cadence product.

---

## 5. "Or their own server"

**WebDAV and GitHub deferred past v1.** WebDAV means sealing a Basic-auth username and password — unscoped, not revocable without a password change — and our server fetching a user-supplied URL, an SSRF gun pointed at Fly's internal network. GitHub is the same class: a PAT is far broader than one file. §4's rotation finding independently closes the generic-provider door. Both stay first-class on the *local* path — Claude Code handles them and `tools/get-plan.ts` works against any backend.

---

## 6. Host, domain, door, and protocol shape

**`health-tool-edu`,** at `https://mcp.drstanfield.com/mcp`. Education product, not commerce; the edu app omits the Discord and YouTube bot tokens, so the box holding `MCP_SEAL_KEYS` carries the smaller secret set.

Vendor requirements: reachable from Anthropic's egress `160.79.104.0/21`, **IPv4-only, publicly routable**; discovery comes from the same range, so a WAF in front of the AS breaks the flow. PRM `resource` must match the typed URL exactly. `authorization_servers` must list our issuer **first** — Claude uses the first entry and does not fall back. Unauthenticated calls return **401** with `WWW-Authenticate: Bearer resource_metadata="…"`; Claude ignores that header on a 200.

**Protocol shape — build 2025-11-25, be ready for 2026-07-28.** Emit RFC 9207 `iss` from day one. Branch on `MCP-Protocol-Version` and accept no-`initialize` 2026-07-28 clients. Return **405 on GET and DELETE**. Never mint `Mcp-Session-Id`; ignore it and `Last-Event-ID`. Statelessness makes forward-compatibility nearly free — the new revision removed exactly the stateful mechanisms we never built.

**No CORS.** MCP clients are servers. Nothing added to `ALLOWED_ORIGINS`; no `Access-Control-Allow-Origin`; a present-and-foreign `Origin` gets 403. localhost never on any list (CLAUDE.md, unchanged).

**Which door.** The app-proxy HMAC guards Brad-funded AI calls from the storefront; an MCP client cannot produce a Shopify signature and these tools cost nothing. OAuth 2.1 bearer with audience validation *is* authentication, and stronger than a shared HMAC secret: per-user, per-client, expiring. **MCP OAuth is the front door for `/mcp`; the HMAC door is untouched elsewhere.** Unauthenticated: only the two `.well-known` documents.

---

## 7. Failure and consistency

Reuse `SyncManager` (moving to health-core): read, migrate, merge, write with `expectedVersion`, retry on `ConflictError`, verify-after-write.

**Dropbox — resurrection was the real hazard, and the fix has LANDED** (commit `4ee99d3`). Default `strict_conflict: false` accepts a stale rev against a **deleted** path and silently re-creates the file, so a stale write could resurrect a record the user erased (`eraseEpoch`, US-11). The widget adapter now sends `strict_conflict` on rev-conditional writes; the conflict raises, `SyncManager` re-reads, and recovery is an explicit re-create-from-merge. **The MCP server inherits this by reusing `SyncManager` — do not bypass it.**

> **Accepted residual (surfaced by that work).** An **out-of-band RAW deletion** — the user deleting `health-roadmap.json` in the Dropbox UI rather than using the app's erase flow — carries **no `eraseEpoch` signal**, so a stale writer legitimately re-creates the content. This applies equally to the MCP server. The app's own erase flow (which rewrites rather than deletes) remains fully protected. **Future work:** a tombstone the erase flow leaves behind, so a raw deletion is distinguishable from a first-ever create. Not in v1.

**Drive — DEFERRED.** Drive v3 removed `etag` from every resource, so there is no conditional write. Phase 2 requires this algorithm, implemented and tested:
1. Read with `fields=version`.
2. **Re-fetch `version` immediately before upload**; if it moved, abort and re-merge.
3. After writing, re-read and assert **every pre-read row id is still present** and the new rows landed.
4. Bounded retry.

Residual, disclosed: our write becomes **durable-by-retry**, but the **browser cannot detect being clobbered** — `sync-manager.ts:128` only fails when lamport *regresses*, and a competing merge passes that check. On Drive, concurrent writers are **best-effort**, and the guide must say so. **Phase-2 gate: the algorithm implemented and tested first; Google brand verification second.**

| Other cases | Behaviour |
| --- | --- |
| Provider outage | One MCP error naming the provider. No retry storm. |
| Access blob expired | Client refreshes; Claude reactively on 401, proactively ≤5 min before expiry, so `expires_in` must be honest. **A blob already in vendor hands can never be updated by us** — contents are frozen at issue, which is why `max_writes` is spent by refresh. |
| Refresh blob or grant dead | `invalid_grant` → 401 → client re-runs OAuth. Causes: user revoked, six months idle (Google), Google testing-status 7-day expiry, widget reconnect evicting the grant (§4). |
| Key rotated, no overlap | Every user reconnects. Only by intent. |
| `schemaVersion` > 1 | `SchemaTooNewError` → read-only answer, explicit refusal to write. |

**Latency.** Claude allows **10 s** for the token endpoint, and ours does a provider code exchange inside it. Measure it.

**Shipping gates.** Google project published, not "Testing," or Drive refresh tokens die after 7 days. Dropbox freezes new links two weeks after the 50th user without production approval (500 ceiling).

---

## 8. Build order — no gate between phases

Brad's ruling: build the full thing. The recruitment gate is removed. The phase structure remains as **build order**, because Phase 0 is the tool layer Phase 1 wraps, and it delivers working Claude Desktop support on day one.

**Phase 0 — local stdio MCP server (~1 day).** All five tools over a local file path (`expectedValue` optional here; the hosted surface is where it is required). No server, no OAuth, no keys, no promise change. Ships value immediately to Claude Desktop and Claude Code users.
- [ ] `packages/health-core/src/plan.ts` — move `derivePlanInputs`/`computePlan`/`renderJson` out of `tools/get-plan.ts`; CLI keeps argv, `fs`, HTML renderer; US-30 AC1 import guard still passes.
- [ ] `get_plan` JSON gains the top-level `instruction` field (preserve hedging + citations).
- [ ] Tool layer: `read_record` (strips `reminderOptIn.token`, `metric`/`since` filters), `get_plan`, `add_measurement`, `add_lab_values` — over `migrateFile` + `record-edits.ts`.
- [ ] stdio MCP server entry in `tools/`, wired to a file path argument.
- [ ] Tests: tool-layer unit tests + the `reminderOptIn.token` strip, citing US-32.

**Phase 1 — hosted, Dropbox only (~5–8 days).** Everything in §2 and §4.
- [ ] Move `adapter.ts` + `sync-manager.ts` to health-core; update `widget-src` imports; existing sync-manager tests stay green.
- [ ] `app/lib/mcp-auth.server.ts`: seal/unseal (§4 spec), stateless AS, CIMD fetch policy, DCR fallback, Dropbox confidential client.
- [ ] `record-edits.ts`: add `expectedValue` to `CorrectValueRequest` (required hosted, optional flag in `tools/edit-record.ts`); tests; shipped CLI path unbroken.
- [ ] `app/lib/mcp.server.ts`: JSON-RPC dispatch, five tools, Zod schemas, per-call caps, 90-day correction age limit, sealed `max_writes` with corrections weighted 5×.
- [ ] Slot-occupied add returns a rejection naming the held row and pointing at `correct_value` (mirror `tools/edit-record.ts:274`).
- [ ] `app/routes/mcp.$.tsx` + `app/routes/[.]well-known.$.tsx`.
- [ ] Confirm no route logs a request URL; check Fly proxy access-log setting.
- [ ] **Deferred from Phase 0 — stdio framing.** `serve()` re-splits its whole buffer per chunk, so a single long line costs O(n²) (measured: 4 MB 79 ms, 48 MB 10.9 s / 763 MB heap). Phase 0 caps a line at 8 MB and refuses it; the hosted transport is HTTP and does not reuse `serve()`, so the streaming `indexOf` rework lands only if a local client ever needs it.
- [ ] **Deferred from Phase 0 — output backpressure.** The stdio server ignores `write()`'s return value, so a slow reader buffers a large `read_record` reply in memory. Harmless against a local peer that dies with us; the hosted surface must honour backpressure, since there the reader is a network.
- [ ] `MCP_SEAL_KEYS` + `MCP_CLIENT_HMAC_KEY` as Fly secrets on `health-tool-edu`; DNS for `mcp.drstanfield.com`; Dropbox console redirect URI.
- [ ] `docs/user-stories.md`: US-32 + the additive promise paragraph — **this commit, not earlier**. Regenerate `user-stories.html`.
- [ ] `docs/agent-access.md`: hosted-path section. Guide buttons `[connect:chatgpt]`/`[connect:claude]` become the connector URL + add flow.
- [ ] Live verify against both vendors; `npm run test:all`.

**Phase 2 — Drive.** §7's algorithm implemented and tested first, Google brand verification second.

`[connect:gemini]` stays a prompt link at every phase.

---

## 9. What this does not do

No health data in Supabase — and no *anything* in Supabase. No accounts, no passwords, no stored email. No analytics on health content. No delete tool, no `eraseEpoch`, no reminder-token access. No WebDAV, GitHub or self-host in v1, and §4's rotation finding closes generic providers entirely. No per-user revocation, no connection list, no audit trail. **No Gemini promise:** consumer custom MCP exists only inside Spark tasks, personal accounts, US-only, English-only, 18+.

---

## 10. Verification status of load-bearing claims

| Claim | Status |
| --- | --- |
| MCP revision **2026-07-28** removed sessions, GET stream, DELETE, `Last-Event-ID` | Verified — but neither vendor claims support; build the 2025-11-25 shape (§6). |
| CIMD/DCR need no registry (Anthropic `oauth_cimd`; no 7592 round-trip; OpenAI DCR once per connection; RFC 7591 §3.2.1) | **Verified — review confirmed.** |
| Claude: PKCE S256, RFC 8707 `resource`, 401+`WWW-Authenticate`, `invalid_grant`, 10 s/30 s timeouts, egress `160.79.104.0/21` | Verified, first-party. |
| ChatGPT: Pro/Plus/Business/Enterprise/Edu developer mode, SSE + streamable HTTP, CIMD/DCR, writes confirmed by default, `readOnlyHint` respected | Verified, first-party. Tier list is the one live discrepancy with third-party sources. |
| Neither Dropbox nor Google rotates refresh tokens on refresh | **Verified 2026-09-01.** Load-bearing; see §4. |
| Google `drive.file` non-sensitive → brand verification only, no CASA, **100-user unverified cap does not apply** | **Verified in our favour.** |
| **Bearer-token length limits at either vendor** | **UNVERIFIED — none documented.** Absence of docs is not absence of a cap. |
| **Vendor durable token persistence across sessions/devices** | **UNVERIFIED.** Open issues report tokens failing to persist and refresh failing. Expect support traffic. |
| Refresh-token size: Google ≤512 B; Dropbox variable, ">1 KB" | Sealed blob ≈500 chars typical, ~1.8 KB worst case **plus padding** — inside Node's 16 KB header limit. |
| Dropbox refresh tokens have no idle expiry | Blog and staff forum, not a formal reference clause. High-confidence, not contractual. |

**Documented fallback.** Only on a *named, verified* blocker: an `mcp_connections` table holding the sealed blob, bearer reduced to `<row-id>.<secret>`, wrapping key derived from `<secret>` so the row alone decrypts to nothing. Qualifying: (1) a vendor caps bearer tokens below ~1.8 KB + padding; (2) a vendor truncates or fails to persist long tokens; (3) a provider's refresh token outgrows the header budget. Convenience does not qualify.

---

## Sync-rule note

Nothing here touches `health_roadmap_algorithm.md`, `evidence.ts`, or `roadmap_text.html`; `get_plan` re-exposes existing derivations unchanged, so the three-file rule is not triggered. **US-31 is taken (CLI writes, shipped 2026-09-01) — the hosted server is US-32.** `docs/user-stories.md` needs US-32 plus the additive promise paragraph, and `docs/agent-access.md` a hosted-path section, both in the Phase-1 commit.
