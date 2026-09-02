# MCP architecture — local stdio server and hosted stateless server (US-32)

Hosted-server design: **rev 4, DECIDED — FINAL**. 2026-09-01. Brad has ruled on every open question; this document is the build reference, not a proposal. Sections 1 onward are that design; section 0 maps every agent surface, hosted or not.

## 0. Map of the agent surfaces

| Surface | What it is | Documented in | Status |
| --- | --- | --- | --- |
| Published file contract | The rules any agent follows to read and write `health-roadmap.json` | [agent-access.md](agent-access.md) + [health-roadmap-file.schema.json](health-roadmap-file.schema.json) | shipped |
| `get-plan` CLI (US-30) | Computes the plan from a file, offline, no model | `tools/get-plan.ts` + [guides/command-line.md](guides/command-line.md) | shipped |
| `edit-record` CLI (US-31) | Contract-enforcing writes from the shell | `tools/edit-record.ts` + [guides/command-line.md](guides/command-line.md) | shipped |
| Local stdio MCP (US-32 phase 0) | The same tools over a local file path | `tools/mcp-server.ts` + [guides/connect-claude-desktop.md](guides/connect-claude-desktop.md) | shipped; verified with MCP Inspector and Claude Code 2026-09-02 |
| Hosted MCP (US-32 phase 1) | The same tools behind a connector, sealed-token stateless | this doc + `app/lib/mcp*.server.ts` + [deploy-runbook.md](deploy-runbook.md) "Hosted MCP" | LIVE 2026-09-02 at `https://mcp.drstanfield.com/mcp`; verified from Claude and ChatGPT on the web |
| Hosted MCP over Drive (US-32 phase 2) | The same server, against Google Drive | this doc §7 + `packages/health-core/src/drive-rest.ts` | VERIFIED LIVE 2026-09-02: the `GOOGLE_DRIVE_*` secrets are on `health-tool-edu`, the consent screen offers Drive with brand verification approved (no unverified-app interstitial), and runbook step 8 passed over Drive |
| `report_feedback` tool | Hosted: files the GitHub issue itself. Tokenless surfaces: prepares a link the user submits | `packages/health-core/src/mcp-tools.ts` + `app/lib/github-issues.server.ts` | shipped |

**One write path.** Every surface in this table that writes reads and saves the record through `SyncManager` over a `StorageAdapter` — read, migrate, merge, conditional write on `expectedVersion`, verify. The CLI and the stdio server hand it `FileAdapter` (one local file); the hosted server hands it `DropboxAdapter` or `DriveAdapter`, chosen by the provider sealed into the bearer token. The database of record is a constructor argument, not a second code path.

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
| `app/routes/mcp.$.tsx` | MCP endpoint plus `/authorize`, `/token`, `/register`, `/callback`. One splat, one file. No `/disconnect`: with no state to delete there is nothing for it to do, and the real revocation is the provider's own settings page (§1). |
| `app/routes/[.]well-known.$.tsx` | RFC 9728 and RFC 8414 documents must sit at host root, so they cannot live under `/mcp`. One splat serves both. |
| `app/lib/mcp.server.ts` | Dispatch, corrections guards, write budget, -32603 gate. Tool definitions and Zod schemas live in `packages/health-core/src/mcp-tools.ts`. |
| `app/lib/mcp-config.server.ts` | The two secrets, the on switch, the public URLs. |
| `app/lib/mcp-seal.server.ts` | Seal/unseal: per-type keys, AAD, padding, `kid`. |
| `app/lib/mcp-clients.server.ts` | Pinned vendors, CIMD fetch policy, DCR ids, capped reads. |
| `app/lib/mcp-grants.server.ts` | Blob payloads, `/token` minting, code + write allowances, rate limits. |
| `app/lib/mcp-authorize.server.ts` | The `/authorize` checks, the consent state, PKCE. |
| `app/lib/mcp-providers.server.ts` | Dropbox and Google as confidential clients. |
| **In-memory state (counted, not free):** bounded LRU for CIMD metadata (256 entries, TTL per HTTP cache headers, 1 h max), auth-code `jti` set (60 s TTL), per-IP rate maps. Per-machine, lost on deploy — by design. | |
| **Zero tables.** | |
| Moves into `packages/health-core/src/`: `adapter.ts`, `sync-manager.ts`, and `computePlan`/`renderJson` from `tools/get-plan.ts` | **Not pure moves.** `sync-manager.ts` gains the Drive-specific pre-write version re-check (§7), so this is a move *plus* a behaviour change with new tests. `record-edits.ts` separately gains the `expectedValue` parameter (§3). Net prod LOC is positive, modestly. |

**Keys — five Fly secrets, all on `health-tool-edu`.**

| Secret | Use | Rotation |
| --- | --- | --- |
| `MCP_SEAL_KEYS` | Ordered list of 32-byte keys; `kid` = index. Seal with the **first**, accept **any**. Rotation is one atomic `fly secrets set` — prepend the new key. No window where a machine holds a partial view. | Overlap keeps a leaked key live up to the refresh lifetime (90 d); no-overlap forces every user to reconnect. **Default incident response is no-overlap**, because a leaked seal key is retroactive (§4). |
| `MCP_CLIENT_HMAC_KEY` | HMAC over self-contained DCR `client_id`s. | **User-visible, not silent.** Anthropic freezes a connector's auth settings after it is added, so rotation forces every affected user to **remove and re-add the connector**. Rotate only with a comms plan. |
| `MCP_ISSUER` | The `iss` this server claims (RFC 9207) and the value discovery advertises. Defaults to `https://mcp.drstanfield.com` (`app/lib/mcp-config.server.ts`) if unset. | Changing it invalidates every blob sealed under the old value's AAD binding via `resource`; treat it as fixed. |
| `DROPBOX_APP_KEY` | The Dropbox app id used for the provider OAuth leg. Same app as the widget's (`widget-src/src/storage/dropbox.ts`), now used as a confidential client with its secret. | Rotating it needs a matching Dropbox console change; every connected user reconnects. |
| `DROPBOX_APP_SECRET` | The confidential-client secret paired with `DROPBOX_APP_KEY`. | Same as above. |
| `GITHUB_ISSUES_TOKEN` | Fine-grained PAT, **Issues: read/write on `DrBradStanfield/roadmap` and nothing else**, that `report_feedback` files under. | Not user-visible: unset it and every report falls back to a link the user submits. Expires in a year; rotate by issuing a new PAT and `fly secrets set` on the edu app. |

Reuse otherwise: `mergeFiles`, `migrateFile`, `SyncManager`, `createRateLimiter`, the plan derivation. No new npm dependency — `node:crypto` covers AES-256-GCM, HKDF, HMAC.

---

## 3. Tool surface v1 — append-only including corrections

| Tool | Kind | Note |
| --- | --- | --- |
| `read_record` | `readOnlyHint` | Migrated record minus `reminderOptIn.token`; `metric`/`since` filters. |
| `get_plan` | `readOnlyHint` | `renderJson(computePlan(file))`. The one thing only this repo can do; costs no Anthropic spend. |
| `add_measurement` | append | One core metric, SI canonical, validated by health-core. |
| `add_lab_values` | append | Batch — the lab-report case, which is the point. |
| `update_profile` | overwrite (**guarded**) | Sex, birth year, birth month, height — the four fields the plan is computed from. Read-modify-write of the one last-write-wins profile object; `expected` per changed field is required hosted, optional locally. See the 2026-09-02 revision below. |
| `correct_value` | append (**separate pathway**) | Mirrors `record-edits.correctValue` / `RoadmapStore.correctMeasurement` exactly: append a new row carrying `correctsId` and the **original `recordedAt`**, then flip the old row to `entered-in-error`. **Never folded into an add** — a slot-occupied add is *rejected*, and the rejection names the held row and points the agent at `correct_value`, mirroring the `refuse()` hint in `tools/edit-record.ts`. |

**Corrections ship hosted, as their own pathway** (Brad's ruling, 2026-09-01, overruling the interim removal). A correction *is* an append under this data model — the protocol is append-with-`correctsId` plus a status flip on the superseded row — so withholding it would ship an incomplete protocol and push agents toward improvising something worse. The pathway stays distinct from `add_*` at every level: separate tool, separate arguments, separate rejection path.

Read and write tools are separate by construction — no catch-all with a `method` argument.

The hosted surface exposes **every tool in `MCP_TOOLS`**, the shared list the local stdio server and the CLI use — including `report_feedback`, which touches no record: it files a public GitHub issue for the user, under a server-held fine-grained token (`GITHUB_ISSUES_TOKEN`, Issues read/write on `DrBradStanfield/roadmap` only). The tool layer builds the issue — `[connector]` title, `from-connector` plus `bug`/`enhancement` labels, the report fenced so its markdown is inert and its `@names` ping nobody, a footer naming the kind, the server version and the provider — and the server is the only half that holds a token and a network, so the stdio server and the CLI stay tokenless and fall back to a prefilled URL the user submits. It is charged a correction's five against the connection's write allowance because it writes to someone else's system; the machine files at most 20 issues an hour, and the same title inside 24 hours returns the first issue rather than a second. The hosted dispatcher runs `RECORD_FREE_TOOLS` before it opens the folder at all, exactly as the stdio server does, so a user whose record will not load can still report that. One list, one surface, no hosted-only subset to drift.

**VERIFIED HOLDS (review):** the write surface is restricted to **append-only arrays only**. `packages/health-core/src/merge.ts` (lines 24–43) enforces row immutability there via `unionRows`, while current-state lists and singletons are last-write-wins where a second writer can overwrite the user. So v1 never writes medications, supplements, screenings, profile, documents or reminders, and never deletes. Corrections stay inside the append-only arrays the merge protects.

**Revised 2026-09-02 (Brad's ruling, US-34): the profile is now writable — sex, birth year, birth month, height, and nothing else.** The boundary above was drawn around the MERGE, not around the risk, and it drew the line in the wrong place for these four fields: they are what the plan is computed from, a user who asks their assistant to fix their height means it, and a wrong one is visible on the screen the moment it lands. `update_profile` is a read-modify-write of the whole profile object (last-write-wins, one stamp), so every field it does not name survives — including fields a newer app added. Two things carry the risk the append-only rule used to: **`expected` is REQUIRED on the hosted surface for every field being changed** (the `correct_value` guard, applied to a record with no superseded copy to read back), and a profile change **costs a correction's weight** in the hourly allowance. Still out of reach and staying there: display preferences (`unitSystem`, `unitOverrides`), medications, supplements, screenings, documents, reminders, and any delete.

**Build note.** The tool is `updateProfile` in `packages/health-core/src/mcp-tools.ts`, the hosted `expected` guard is `checkProfileUpdate` in `app/lib/mcp.server.ts` beside `checkCorrection`, and the profile's `lamport` is bumped one past the copy the tool read — the same discipline `RoadmapStore.applyProfileChanges` uses, so a connector write and an app write of the same field settle on wall-clock time rather than on which surface wrote it. The CLI (`tools/edit-record.ts`) gained no `profile` subcommand: it is row-shaped end to end (`--metric`/`--value`, the echo, the `Change` type), so the subcommand would have been a second shell rather than a reuse.

**Blast radius, stated honestly.** A prompt-injected agent **reads first**, so it knows every row id and value. With `correct_value` it can therefore *silently falsify every current clinical value* in roughly 30–100 calls. Each original flips to `entered-in-error`, which is **irreversible**. `get_plan` then generates a plan from the falsified record, and the user sees a coherent, wrong protocol. Append-only prevents data *loss*; it does not prevent data *corruption*. **Brad accepted this residual knowingly on 2026-09-01, choosing protocol completeness over the smaller surface.**

**Mitigations — MANDATORY for the hosted corrections pathway, not optional hardening.** Shipping `correct_value` hosted without all four is not the decision Brad approved.
1. **`expectedValue` on `CorrectValueRequest`.** Today it is `{id, newValue, now}` (`packages/health-core/src/record-edits.ts:57`) with no check. Hosted calls must state the value they expect to find, and a mismatch rejects — an agent working from a stale or hallucinated read writes nothing. Work item returns: `record-edits.ts`, an **optional** flag in `tools/edit-record.ts`, and tests. **Must not break the shipped CLI path (US-31)** — optional there, required on the hosted surface.
2. **Age limit — refuse `correct_value` on rows older than N days; N = 90, tunable.** Corrections fix recent mistakes; a lab result from three years ago is history, not a typo. 90 days covers a quarterly test cadence with room to spare, and puts the bulk of the record permanently out of reach of an injected agent.
3. **Per-call caps** on rows written, `add_lab_values` included.
4. **Weighted write allowance: N weighted writes per connection per hour, per machine** (N = 60), keyed on `sha256(provider refresh token)` — the connection, not the access token, so minting extra access tokens buys no extra writes. **A correction costs 5× an add.** Justification: the falsification attack needs one correction per metric, so weighting corrections is what actually bounds it, while a legitimate session corrects rarely and adds in batches — a lab-report import is many adds and zero corrections.

   **A refused write still spends its cost.** The allowance is charged before the tool runs, so an add into an occupied slot or a correction with the wrong `expectedValue` counts against the hour. Deliberate: an attacker probing for a value it does not know would otherwise get unlimited free guesses, and the guessing IS the attack. An honest client reads before it writes and rarely meets a refusal.

   **A write that fails in storage also spends its cost.** The allowance is charged before the tool runs, so a write the provider refuses, drops or never answers counts against the hour too — an attacker cannot buy free attempts by making the storage call fail.

   **Stated honestly: this bound is per machine, and it is per hour, not per connection lifetime.** N Fly machines multiply it by N, and an attacker willing to wait gets a fresh allowance every hour. It bounds the *rate* of silent falsification, not the total.

   **A lifetime pool was specified here (`max_writes` sealed into the blob and spent by refreshing) and has been REMOVED (2026-09-02, security review).** It failed in both directions. It charged an honest client 60 writes for every refresh whether or not it wrote anything, so roughly fifty refreshes — a fortnight of ordinary hourly renewal — left a user permanently unable to write, told "try again shortly", which was false. And it bounded no attacker: replaying one refresh blob yields a fresh access blob every time, because the ciphertext a vendor holds can never be updated by us. A quota that cannot be decremented is not a quota.

**Vendor confirmation prompts are NOT a security boundary:** the MCP spec states annotations are untrusted hints, and "always allow" is one click. Do not count them.

**`get_plan` clinical surface — APPROVED.** `--json` already carries hedged reasons and citations inline per suggestion (US-30 AC3). Add a top-level `instruction` field asking the model to preserve the hedging and the citations when presenting. No threshold or citation changes, so the three-file rule is not triggered.

Every write: read → `migrateFile` → apply → `mergeFiles` → conditional write, enforcing `docs/agent-access.md` in code: fresh UUIDs, `meta.updatedAt` now, `lamport`/`eraseEpoch`/`lastDeviceId` untouched, one active row per (metric, day), identical values dropped.

---

## 4. Auth chain, with no storage anywhere

> **Prerequisite — LANDED (commit `4ee99d3`, 2026-09-01).** OAuth secrets travel in query strings. `SENSITIVE_PARAMS` in the parity-tested pair (`instrument-scrub.mjs`, `packages/health-core/src/sentry-scrub.ts`) now also redacts `code`, `state`, `code_verifier`, `code_challenge`, `client_secret`, `refresh_token`, `access_token`, `id_token`, `assertion`, with exact-match semantics pinned by test. Standing rules for this build: **no `/mcp` route may log a request URL**, and Fly's proxy access-log setting must be checked before Phase 1 ships.

**We are the authorization server.** An IdP would mean user accounts — the one thing this product does not have. The identity we need is "the person who can authorize this folder," and the provider proves it.

**Registration needs no registry — but the canonical vendor clients are PINNED, not fetched.** On 2026-09-02, from inside the Fly machine, `https://claude.ai/oauth/mcp-oauth-client-metadata` answered with a Cloudflare managed challenge: 403, `text/html`, `cf-mitigated: challenge`, with and without a browser User-Agent. Claude's own CIMD document is therefore unfetchable from where we run, and every Claude connection died at "We do not recognise the app". `https://chatgpt.com/oauth/client.json` fetched fine the same day — the same class of risk, one day later. So `KNOWN_CLIENTS` in `app/lib/mcp-clients.server.ts` pins both canonical ids (Claude → `https://claude.ai/api/mcp/auth_callback`, ChatGPT → `https://chatgpt.com/connector_platform_oauth_redirect`) and is consulted BEFORE any network fetch, on an exact string match. That is not a workaround: IETF draft-ietf-oauth-client-id-metadata-document-00 §4 says a server SHOULD fetch the document and MAY apply its own policy about which clients it accepts, and pre-registration keyed by the CIMD id is that policy. The fetch policy below stays in force for every unknown `https://` id, and a fetched document MUST claim the exact URL it was fetched from. DCR remains the fallback; ChatGPT in fact connected over CIMD (`https://chatgpt.com/oauth/client.json`), not DCR. RFC 7591 §3.2.1 permits a shared/self-contained `client_id`. We advertise `"client_id_metadata_document_supported": true` **and** `"none"` in `token_endpoint_auth_methods_supported` — Claude needs both or silently falls back to DCR. DCR fallback: `client_id = "c." + base64url(metadata) + "." + HMAC(MCP_CLIENT_HMAC_KEY, metadata)`, verified on every use against a redirect-URI allowlist (`https://claude.ai/api/mcp/auth_callback`, OpenAI's callback; RFC 8252 loopback redirects: implemented, OFF — CLAUDE.md, localhost never on an allow-list).

**CIMD fetch is an SSRF surface. Policy is mandatory:** `https` only; DNS-resolve and reject non-public IPs, **re-checked at connect time** (rebinding); **zero redirects**; 5 s timeout; 64 KB body cap; `application/json` required; no credentials sent; results into the bounded LRU of §2. `/mcp/authorize` is per-IP rate-limited **before** any fetch.

**Seal specification.** Payload → 12-byte CSPRNG nonce (prepended) → AES-256-GCM under a **per-type key** `HKDF(MCP_SEAL_KEYS[kid], info = "mcp/" + typ + "/v1")`, with **AAD = kid ‖ typ ‖ client_id ‖ resource**. AAD gives domain separation (a state blob can never be presented as an access blob) and binds each blob to its client and audience. **Padding: fixed-bucket to 256/512/1024/2048 bytes** — without it, blob length leaks the provider and roughly which credential is inside.

**Stateless flow.** `/mcp/authorize` validates client, PKCE `S256` only, and `resource`, then shows **our** consent screen — required anyway by the confused-deputy rule, since we forward to a static upstream client id. Sealed `state` carries {client_id, redirect_uri, code_challenge, clientState, nonce, exp +10 min}.

**The consent POST's CSRF defence is the `Origin` check, not the cookie.** The cookie is SET by that POST, so `SameSite=Lax` protects nothing there; what does is §6's rule that a present-and-foreign `Origin` gets 403. Browsers attach an `Origin` to every cross-site POST — as the literal string `null` when the referrer is suppressed — which is why the consent page is served `Referrer-Policy: same-origin` and not `no-referrer`: under `no-referrer` a real browser posted the form with `Origin: null`, our own check refused it, and the consent step could not complete at all.

**The consent screen is enforced by a cookie, not by convention** (added 2026-09-02, security review). Pressing Connect is what mints a 32-byte CSPRNG nonce; the sealed state naming it goes into a first-party `__Host-mcp-state` cookie (Secure, HttpOnly, SameSite=Lax, Path=/, 10 min) and **Dropbox is handed the nonce alone** as its `state`. `/mcp/callback` requires the cookie, unseals it, compares Dropbox's echoed `state` to the sealed nonce timing-safely, and clears the cookie. Without the cookie it is a 400 page and no redirect. This closes two things at once: a state blob obtained from an unauthenticated `GET /mcp/authorize` could otherwise be replayed straight into a forged callback, skipping consent entirely; and the sealed state was ~1 KB against Dropbox's documented 500-byte `state` limit. Still no server-side state — the cookie is the browser's copy, sealed. **Ceiling:** the sealed state carries the client id, and browsers cap a cookie near 4 KB, so a CIMD client id of a few thousand characters would make the consent step fail. Real ids are far short of it (`resolveClient` caps at 4096 chars, and a vendor's is ~50), but the limit is the cookie's, not ours. **That ceiling is also what caps the client's `state` (2026-09-02).** `state` was being truncated at 512 characters, which broke every ChatGPT connection — OpenAI sends 521 — so it is now bounded and REFUSED at `MAX_STATE_LENGTH = 1024` rather than shortened. 1024 was measured, not chosen: it keeps the sealed state inside the 2048 padding bucket and the Set-Cookie line near 3.1 KB, where 2048 would reach the 4096 bucket and a ~5.8 KB cookie the browser silently drops. (The bucket list in the seal spec above omits the 4096 rung the code actually has.) Provider callback exchanges for the provider refresh token and mints an auth-code blob (exp **+60 s**). `/mcp/token` unseals, verifies PKCE/client/redirect/expiry, issues access (1 h) and refresh (90 d) blobs. `/token` is `application/x-www-form-urlencoded`; `/register` is `application/json` — two parsers in one route file, a real trap. A dead grant returns `invalid_grant`, never a custom code, or Claude never recovers.

**Provider leg.** Reuse the existing OAuth clients — mandatory, per §1's shared-identity finding. Same `GOOGLE_DRIVE_CLIENT_ID`/`GOOGLE_DRIVE_SECRET` from `app/routes/api.google-token.ts`. The server reads its own `DROPBOX_APP_KEY` Fly secret, but it is the same Dropbox app as the widget's (`widget-src/src/storage/dropbox.ts`), now with its secret as a confidential client. Scopes: Dropbox `files.content.read`, `files.content.write`, `files.metadata.read`; Google `drive.file` only.

**Threats and residuals.**

| Threat | Position |
| --- | --- |
| **Retroactive key compromise** | An access blob wraps a **non-expiring** provider credential. Our `exp` is *advisory* — enforced only by our own unseal path. A leaked `MCP_SEAL_KEYS` opens **every blob ever issued**, including expired ones captured months earlier. The worst property of the design, and why no-overlap rotation is the default incident response. |
| **Provider adopts refresh-token rotation** | Verified 2026-09-01: **neither Dropbox nor Google rotates refresh tokens on refresh.** The design depends on it. If either adopts rotation, every connection breaks **simultaneously** with no server-side remedy — we hold no row to update. This closes the door on generic/self-declared providers. |
| **Google's 100-refresh-token cap** | Per account **per client id**, shared with the widget. A widget reconnect can therefore **evict the MCP grant** (Google silently drops the oldest). Never mint a spare token. |
| Vendor token store leaks | **The provider credential is safe; our endpoint is not.** The Dropbox refresh token inside is ciphertext and inert without our key — but the blob itself is a live bearer against `/mcp` until its absolute expiry, and using it needs no key at all. What split custody protects is the PROVIDER credential, not access to this server. |
| Token passthrough | Forbidden by spec and construction: we mint our own token, validate audience, never forward a provider token. |
| Auth-code replay | **Known spec deviation.** OAuth 2.1 requires single-use codes; stateless cannot enforce it. Redemption needs the PKCE `code_verifier`, which never leaves the client, so a passive interceptor gains nothing. Window is 60 s. Per-machine `jti` set is best-effort, **not authoritative** across Fly machines. Documented, not papered over. |
| Prompt injection | §3 — the silent-falsification residual, knowingly accepted, bounded by the four mandatory mitigations (`expectedValue`, 90-day age limit, per-call caps, the 5×-weighted hourly write allowance). |
| Abuse | Per-IP, per-machine limiter — fine against floods, useless when distributed. No Anthropic spend here, so the app-proxy HMAC's cost rationale does not transfer. |
| Tenant isolation | One rule: the connection derives from the bearer token and nothing else. No tool argument ever names a user, file, or path. |

**An access token minted just before the refresh expiry outlives it, by up to an hour.** The refresh blob's `exp` is absolute from consent; an access blob issued at 89 days 23 h carries its own hour. The connection is therefore dead for renewal but alive for calls for up to 60 more minutes. Accepted: bounding it would mean clamping the access `exp`, and `expires_in` must stay honest for the client's proactive refresh (§7).

**The 90-day refresh lifetime is ours, not a provider requirement.** Dropbox refresh tokens have no idle expiry; we cap deliberately to bound how long a leaked blob stays useful. Cost: quarterly re-consent for every active user — real friction on an annual-cadence product.

---

## 5. "Or their own server"

**WebDAV and GitHub deferred past v1.** WebDAV means sealing a Basic-auth username and password — unscoped, not revocable without a password change — and our server fetching a user-supplied URL, an SSRF gun pointed at Fly's internal network. GitHub is the same class: a PAT is far broader than one file. §4's rotation finding independently closes the generic-provider door. Both stay first-class on the *local* path — Claude Code handles them and `tools/get-plan.ts` works against any backend.

---

## 6. Host, domain, door, and protocol shape

**`health-tool-edu`,** at `https://mcp.drstanfield.com/mcp`. Education product, not commerce; the edu app omits the Discord and YouTube bot tokens, so the box holding `MCP_SEAL_KEYS` carries the smaller secret set.

Vendor requirements: reachable from Anthropic's egress `160.79.104.0/21`, **IPv4-only, publicly routable**; discovery comes from the same range, so a WAF in front of the AS breaks the flow. PRM `resource` must match the typed URL exactly. `authorization_servers` must list our issuer **first** — Claude uses the first entry and does not fall back. Unauthenticated calls return **401** with `WWW-Authenticate: Bearer resource_metadata="…"`; Claude ignores that header on a 200.

**`app/routes/[.]well-known.$.tsx` serves both the bare and the `/mcp`-suffixed paths** — `/.well-known/oauth-protected-resource` and `/.well-known/oauth-protected-resource/mcp` answer the same document, likewise for `/.well-known/oauth-authorization-server`. One splat route matches both forms so a vendor that appends the resource path still finds discovery.

**Discovery advertises `scopes_supported: ['health.read', 'health.append']`, and nothing yet enforces them.** The token response echoes the same fixed `scope` string; no route checks it against the tool being called, so every tool a bearer token can reach, it can reach regardless of scope. What actually bounds a call is the write budget and corrections guards in `app/lib/mcp.server.ts` (§2, §3), not the advertised scopes.

**Protocol shape — build 2025-11-25, be ready for 2026-07-28.** Emit RFC 9207 `iss` from day one. Branch on `MCP-Protocol-Version` and accept no-`initialize` 2026-07-28 clients. Return **405 on GET and DELETE**. Never mint `Mcp-Session-Id`; ignore it and `Last-Event-ID`. Statelessness makes forward-compatibility nearly free — the new revision removed exactly the stateful mechanisms we never built.

**No CORS.** MCP clients are servers. Nothing added to `ALLOWED_ORIGINS`; no `Access-Control-Allow-Origin`; a present-and-foreign `Origin` gets 403. localhost never on any list (CLAUDE.md, unchanged).

**Which door.** The app-proxy HMAC guards Brad-funded AI calls from the storefront; an MCP client cannot produce a Shopify signature and these tools cost nothing. OAuth 2.1 bearer with audience validation *is* authentication, and stronger than a shared HMAC secret: per-user, per-client, expiring. **MCP OAuth is the front door for `/mcp`; the HMAC door is untouched elsewhere.** Unauthenticated: only the two `.well-known` documents.

---

## 7. Failure and consistency

Reuse `SyncManager` (now in health-core): read, migrate, merge, write with `expectedVersion`, retry on `ConflictError`, verify-after-write. The local CLI and stdio server run the same loop over `file-adapter.ts`, so this is the only write path in the repo.

Three pieces make that one path rather than three copies of it, and each lives above the adapters so no backend can drift from another:

- **What counts as the record** — `ROADMAP_DOC.migrate` (`roadmap-doc.ts`) refuses bytes that are not a health record before `migrateFile` can normalise them into a blank one. It runs on every `load()` and on the re-read inside every `save()`, so it guards the write as well as the read. An absent file is still a fresh record; a present one must look like ours.
- **The dispatch spine** — `runToolOverSync` (`mcp-tools.ts`): record-free tool or load, `callTool`, the surface's own guard, save. The hosted server passes its corrections checks and write budget as that guard — run BEFORE the tool, so a refused write still spends its cost (§3, mitigation 4); the stdio server passes the backup line it echoes. Nothing else differs.
- **Not losing a concurrent edit** — the version precondition is checked and acted on under a `.lock` file (`file-adapter.ts`, `O_EXCL`, 25 ms backoff, 5 s wait, a lock older than 10 s treated as abandoned): between the check and the rename sit a backup, a prune and a temp write, so without it two processes both pass the check on the same bytes and the second rename discards the first's edit — each reporting success. `SyncManager`'s verify-after-write then asserts every row id it just wrote is present on the re-read (Drive step 3, applied to every backend), so a writer that still loses says so instead of printing "Wrote".
- **The words a failure gets** — `describeStorageFailure` (`sync-manager.ts`) maps a schema-too-new record, a non-record, a conflict storm, a failed verify, an unreadable file and anything unforeseen into one message plus one hint, named for whichever provider holds the record. Every shell prints that and nothing of its own; a storage failure is a tool refusal on the request that failed, never a protocol error with a null id.

**Dropbox — resurrection was the real hazard, and the fix has LANDED** (commit `4ee99d3`). Default `strict_conflict: false` accepts a stale rev against a **deleted** path and silently re-creates the file, so a stale write could resurrect a record the user erased (`eraseEpoch`, US-11). The widget adapter now sends `strict_conflict` on rev-conditional writes; the conflict raises, `SyncManager` re-reads, and recovery is an explicit re-create-from-merge. **The MCP server inherits this by reusing `SyncManager` — do not bypass it.**

> **Accepted residual (surfaced by that work).** An **out-of-band RAW deletion** — the user deleting `health-roadmap.json` in the Dropbox UI rather than using the app's erase flow — carries **no `eraseEpoch` signal**, so a stale writer legitimately re-creates the content. This applies equally to the MCP server. The app's own erase flow (which rewrites rather than deletes) remains fully protected. **Future work:** a tombstone the erase flow leaves behind, so a raw deletion is distinguishable from a first-ever create. Not in v1.

**Drive — BUILT and ENABLED (2026-09-02).** Drive v3 removed `etag` from every resource, so there is no conditional write. The specified algorithm is implemented in `packages/health-core/src/drive-rest.ts` (`DriveAdapter`) and tested step by step in `drive-rest.test.ts`:
1. Read with `fields=version`. — `DriveAdapter.read`, one metadata call BEFORE the `alt=media` download. The order is load-bearing: read the version afterwards and a writer landing mid-download hands back THEIR version number attached to OUR bytes, so step 2 finds nothing moved, passes, and drops their row with `attempts: 0` and no error anywhere. Version first makes the pair pessimistic — worst case the version is stale, step 2 conflicts, and the save retries. A wasted round trip beats a silent lost update, and a test pins it.
2. **Re-fetch `version` immediately before upload**; if it moved, abort and re-merge. — `DriveAdapter.write` raises `ConflictError`, which `SyncManager.save` already catches, re-reads and re-merges.
3. After writing, re-read and assert **every pre-read row id is still present** and the new rows landed. — `SyncManager.verifyAfterWrite`, unchanged and shared with every other backend: the ids it checks are the MERGED file's, which is the pre-read rows plus the new ones.
4. Bounded retry. — the same `MAX_SAVE_ATTEMPTS = 5` loop.

Step 3 needed one change above the adapters, and it is the only behaviour phase 2 altered for other backends: a failed verify used to be a fatal `StorageError`, so step 3 detected a lost update and then gave up. It is now a `LostUpdateError extends ConflictError`, which the existing loop retries — re-read, re-merge, write again, which is safe because the arrays are append-only. When the retries run out, the error says *some of it may have landed* rather than the comfortable falsehood *nothing was written*.

**Two writers, honestly.** There are two windows, and they are caught by different steps. A writer landing DURING step 1's read is caught by step 2, because the version we carry is older than the file — that is why step 1 reads the version first. A writer landing between step 2's check and our upload is invisible to step 2 and invisible to lamport (their write advances it); step 3 is the only thing that sees it, and it sees it by noticing OUR rows are gone. What nothing here can see is a row written by someone else after our read and dropped by our own upload: that loss is undetectable from this side, and their next save re-merges it back.

Residual, disclosed and unchanged: our write is **durable-by-retry**, but the **browser cannot detect being clobbered** — it neither re-checks the version nor consumes one (`widget-src/src/storage/drive.ts` returns `version: null` deliberately, to save a round trip on every load and save). On Drive, concurrent writers are **best-effort**, and the guide must say so.

**Same file, or nothing.** Drive has no app folder, so "the record" is a name inside a folder we created. If the server discovered it differently from the browser, a user would end up with two records and see neither whole. So folder and file discovery moved into `drive-rest.ts` and the browser adapter's copies were deleted — one implementation, two callers.

**Phase-2 gate: the algorithm implemented and tested first (done); Google brand verification and the console steps second (Brad — deploy-runbook.md step 4b).**

**A provider outage costs a call, never a connection.** Google answers a dead grant with 400 `invalid_grant` and an outage with a 5xx, and `providerAccessToken` reads both the same way — null, and one worded tool refusal naming Google Drive. Telling them apart would only matter if we acted on it, and we do not: `/token` re-seals the refresh token we already hold without calling Google at all, so no outage and no misread error can burn a refresh token or force a reconnect. The user retries and it works.

| Other cases | Behaviour |
| --- | --- |
| Provider outage | One MCP error naming the provider. No retry storm. |
| Access blob expired | Client refreshes; Claude reactively on 401, proactively ≤5 min before expiry, so `expires_in` must be honest. **A blob already in vendor hands can never be updated by us** — contents are frozen at issue, which is why no quota can live inside one (§3 mitigation 4). |
| Refresh blob or grant dead | `invalid_grant` → 401 → client re-runs OAuth. Causes: user revoked, six months idle (Google), Google testing-status 7-day expiry, widget reconnect evicting the grant (§4). |
| Key rotated, no overlap | Every user reconnects. Only by intent. |
| `schemaVersion` > 1 | `SchemaTooNewError` → the call refuses, **reads included**: `SyncManager.load()` migrates before any tool runs, so a record this server only half understands is out of reach in both directions. The refusal says so. |

**Latency.** Claude allows **10 s** for the token endpoint, and ours does a provider code exchange inside it. Measure it.

**Shipping gates.** Google project published, not "Testing," or Drive refresh tokens die after 7 days. Dropbox freezes new links two weeks after the 50th user without production approval (500 ceiling).

---

## 8. Build order — no gate between phases

Brad's ruling: build the full thing. The recruitment gate is removed. The phase structure remains as **build order**, because Phase 0 is the tool layer Phase 1 wraps, and it delivers working Claude Desktop support on day one.

**Phase 0 — local stdio MCP server (~1 day).** All six tools over a local file path (`expectedValue` optional here; the hosted surface is where it is required). No server, no OAuth, no keys, no promise change. Ships value immediately to Claude Desktop and Claude Code users.
- [x] `packages/health-core/src/plan.ts` — move `derivePlanInputs`/`computePlan`/`renderJson` out of `tools/get-plan.ts`; CLI keeps argv, `fs`, HTML renderer; US-30 AC1 import guard still passes.
- [x] `get_plan` JSON gains the top-level `instruction` field (preserve hedging + citations).
- [x] Tool layer: `read_record` (strips `reminderOptIn.token`, `metric`/`since` filters), `get_plan`, `add_measurement`, `add_lab_values` — over `migrateFile` + `record-edits.ts`.
- [x] stdio MCP server entry in `tools/`, wired to a file path argument.
- [x] Tests: tool-layer unit tests + the `reminderOptIn.token` strip, citing US-32.

**Phase 1 — hosted, Dropbox only (~5–8 days).** Everything in §2 and §4.
- [x] Move `adapter.ts` + `sync-manager.ts` to health-core; update `widget-src` imports; existing sync-manager tests stay green.
- [x] `app/lib/mcp-{config,seal,clients,grants,authorize,providers}.server.ts`: seal/unseal (§4 spec), stateless AS, CIMD fetch policy, DCR fallback, Dropbox confidential client. (Split out of one 999-line auth-server module on 2026-09-02; a pure move.)
- [x] `record-edits.ts`: add `expectedValue` to `CorrectValueRequest` (required hosted, optional flag in `tools/edit-record.ts`); tests; shipped CLI path unbroken.
- [x] `app/lib/mcp.server.ts`: JSON-RPC dispatch, the shared `MCP_TOOLS` list, Zod schemas, per-call caps, 90-day correction age limit, and the per-connection hourly write allowance with corrections weighted 5×.
- [x] Slot-occupied add returns a rejection naming the held row and pointing at `correct_value` (mirror `refuse()` in `tools/edit-record.ts`).
- [x] `app/routes/mcp.$.tsx` + `app/routes/[.]well-known.$.tsx`.
- [x] Confirm no route logs a request URL. **Fly's proxy access-log setting is an operator check** — it is in the runbook, not done.
- [x] **Deferred from Phase 0 — stdio framing.** Still deferred, deliberately: the hosted transport is HTTP and never touches `serve()`. `serve()` re-splits its whole buffer per chunk, so a single long line costs O(n²) (measured: 4 MB 79 ms, 48 MB 10.9 s / 763 MB heap). Phase 0 caps a line at 8 MB and refuses it; the hosted transport is HTTP and does not reuse `serve()`, so the streaming `indexOf` rework lands only if a local client ever needs it.
- [x] **Deferred from Phase 0 — output backpressure.** Answered by construction: the hosted reply is one `Response` body, so the platform owns the flow control. The stdio server ignores `write()`'s return value, so a slow reader buffers a large `read_record` reply in memory. Harmless against a local peer that dies with us; the hosted surface must honour backpressure, since there the reader is a network.
- [ ] **OPERATOR (Brad).** `MCP_SEAL_KEYS` + `MCP_CLIENT_HMAC_KEY` as Fly secrets on `health-tool-edu`; DNS for `mcp.drstanfield.com`; Dropbox console redirect URI.
- [x] `docs/user-stories.md`: US-32 + the additive promise paragraph — **this commit, not earlier**. Regenerate `user-stories.html`.
- [x] `docs/agent-access.md`: hosted-path section. **Guide buttons stay `soon`** — see the build note below.
- [x] `npm run test:all` green (83 files, 1692 tests). [ ] **OPERATOR (Brad).** Live verify against both vendors — impossible before deployment.

**Phase 2 — Drive.** §7's algorithm implemented and tested first, Google brand verification second.
- [x] `packages/health-core/src/drive-rest.ts` — Drive v3 as plain fetch calls, plus `DriveAdapter` carrying §7 steps 1–2. Folder/file discovery moved out of the browser adapter; the widget copies deleted in the same commit.
- [x] `SyncManager`: a failed verify becomes a retryable `LostUpdateError`, so §7 step 3 feeds step 4 instead of giving up. The give-up message stops claiming nothing was written.
- [x] `provider` sealed into the state, code, access and refresh payloads (AAD unchanged); the consent screen offers one button per configured provider; `/mcp` builds the adapter from the token alone.
- [x] Google as a confidential client: `drive.file` only, `access_type=offline`, `prompt=consent`, no `include_granted_scopes`. Reuses `GOOGLE_DRIVE_CLIENT_ID`/`GOOGLE_DRIVE_SECRET` (§1's shared-identity finding).
- [x] Tests citing US-32 phase 2: the four algorithm steps separately, the Google OAuth chain, the feature gate, and provider isolation (an edited provider dies at the GCM tag).
- [x] Feature gate: no `GOOGLE_DRIVE_*` secrets → the consent screen shows Dropbox only. Held phase 2 inert until the secrets landed 2026-09-02.
- [x] **OPERATOR (Brad), 2026-09-02.** Google console: redirect URI added, publishing status **In production** (or refresh tokens die after 7 days), and the two Fly secrets on `health-tool-edu`. Drive now appears on the live consent screen. Runbook step 4b. Brand verification for `drive.file` approved 2026-09-02 — the consent screen shows the branded "Dr Brad" screen, no unverified-app interstitial.
- [x] **OPERATOR (Brad), 2026-09-02, ~14:25 NZ.** Live verify over Drive (runbook step 8): PASSED. The hosted MCP via Claude.ai wrote a measurement to `My Drive / Health Plan by Dr Brad / health-roadmap.json` — exactly one file of that name found by Drive search — the website (same account) loaded that row, and a correction made on the website was read back by Claude. The guides still say concurrent writers are best-effort there.

`[connect:gemini]` stays a prompt link at every phase.

---

## 9. What this does not do

No health data in Supabase — and no *anything* in Supabase. No accounts, no passwords, no stored email. No analytics on health content. No delete tool, no `eraseEpoch`, no reminder-token access. No WebDAV, GitHub or self-host in v1, and §4's rotation finding closes generic providers entirely. No per-user revocation, no connection list, no audit trail. **No Gemini promise:** consumer custom MCP exists only inside Spark tasks, personal accounts, US-only, English-only, 18+.

---

## 10. Verification status of load-bearing claims

| Claim | Status |
| --- | --- |
| MCP revision **2026-07-28** removed sessions, GET stream, DELETE, `Last-Event-ID` | Verified — but neither vendor claims support; build the 2025-11-25 shape (§6). |
| CIMD/DCR need no registry (Anthropic `oauth_cimd`; no 7592 round-trip; RFC 7591 §3.2.1) | **Verified — review confirmed.** ChatGPT connected over CIMD, not DCR (2026-09-02). |
| **CIMD fetch works from Fly** | **FAILED for claude.ai, 2026-09-02** — Cloudflare managed challenge (403, `text/html`, `cf-mitigated: challenge`) to any datacenter fetch, reproduced from the Fly machine. Works for `chatgpt.com` as of the same day. Replaced by pinning both canonical ids in `KNOWN_CLIENTS`; the fetch policy stands for unknown ids. |
| Claude: PKCE S256, RFC 8707 `resource`, 401+`WWW-Authenticate`, `invalid_grant`, 10 s/30 s timeouts, egress `160.79.104.0/21` | Verified, first-party. |
| ChatGPT: Pro/Plus/Business/Enterprise/Edu developer mode, SSE + streamable HTTP, CIMD/DCR, writes confirmed by default, `readOnlyHint` respected | Verified, first-party. Tier list is the one live discrepancy with third-party sources. |
| Neither Dropbox nor Google rotates refresh tokens on refresh | **Verified 2026-09-01.** Load-bearing; see §4. |
| Google `drive.file` non-sensitive → brand verification only, no CASA, **100-user unverified cap does not apply** | **Verified in our favour.** |
| **Bearer-token length limits at either vendor** | **UNVERIFIED — none documented.** Absence of docs is not absence of a cap. |
| **Vendor durable token persistence across sessions/devices** | **UNVERIFIED.** Open issues report tokens failing to persist and refresh failing. Expect support traffic. |
| **Drive v3 has no conditional write (no `etag`, no rev)** | **Verified.** `DriveAdapter` substitutes §7's four steps; step 2 is a check, not a precondition, and §7 says what that costs. |
| **Google `drive.file` is per-app, so the server and the widget share one identity and one folder** | **Verified in design (§1) and pinned by tests:** discovery lives once in `drive-rest.ts`, and the browser adapter calls it rather than copying it. |
| **Google testing-status refresh tokens expire after 7 days** | **Load-bearing operator step**, in the runbook (4b). Not something the code can detect or work around. |
| Refresh-token size: Google ≤512 B; Dropbox variable, ">1 KB" | Sealed blob ≈500 chars typical, ~1.8 KB worst case **plus padding** — inside Node's 16 KB header limit. |
| Dropbox refresh tokens have no idle expiry | Blog and staff forum, not a formal reference clause. High-confidence, not contractual. |

**Documented fallback.** Only on a *named, verified* blocker: an `mcp_connections` table holding the sealed blob, bearer reduced to `<row-id>.<secret>`, wrapping key derived from `<secret>` so the row alone decrypts to nothing. Qualifying: (1) a vendor caps bearer tokens below ~1.8 KB + padding; (2) a vendor truncates or fails to persist long tokens; (3) a provider's refresh token outgrows the header budget. Convenience does not qualify.

---

## Sync-rule note

Nothing here touches `health_roadmap_algorithm.md`, `evidence.ts`, or `roadmap_text.html`; `get_plan` re-exposes existing derivations unchanged, so the three-file rule is not triggered. **US-31 is taken (CLI writes, shipped 2026-09-01) — the hosted server is US-32.** `docs/user-stories.md` needs US-32 plus the additive promise paragraph, and `docs/agent-access.md` a hosted-path section, both in the Phase-1 commit.


---

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
