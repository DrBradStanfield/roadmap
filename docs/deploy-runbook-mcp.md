# Deploy runbook — hosted MCP (health-tool-edu)

Split from [deploy-runbook.md](deploy-runbook.md) on 2026-09-04 (file cap). The general deploy
sequence, build flags and the two-app split stay there; this file is the MCP server’s own
setup record, rotation procedure, verify sequence and the two directory listings.

## Hosted MCP (health-tool-edu) — US-32 Phases 1–2

**LIVE since 2026-09-02** at `https://mcp.drstanfield.com/mcp`, verified end to end from
both Claude (custom connector, CIMD) and ChatGPT (developer mode, OAuth). Steps 1 to 8
below are the setup record, kept because they are also the rebuild and the rotation
procedure. Every `/mcp` path and both `.well-known` documents return 404 while
`MCP_SEAL_KEYS` is unset, so unsetting it is the kill switch. Education app, not
commerce: the edu box omits the Discord and YouTube bot tokens, so the machine holding
the seal key carries the smaller secret set.

Nothing below can be done by an agent. All of it is Brad's.

**1. Generate the two keys.** Two independent 32-byte secrets:

```bash
openssl rand -base64 32   # → MCP_SEAL_KEYS
openssl rand -base64 32   # → MCP_CLIENT_HMAC_KEY
```

**2. Set them, plus the Dropbox confidential-client secret, on the EDU app only:**

```bash
fly secrets set -a health-tool-edu \
  MCP_SEAL_KEYS="<key 1>" \
  MCP_CLIENT_HMAC_KEY="<key 2>" \
  MCP_ISSUER="https://mcp.drstanfield.com" \
  DROPBOX_APP_KEY="<the app key the widget already uses>" \
  DROPBOX_APP_SECRET="<from the Dropbox app console>"
```

**`GITHUB_ISSUES_TOKEN` is optional and separate** — `report_feedback` files the
user's bug report as a public GitHub issue under it:

```bash
fly secrets set -a health-tool-edu GITHUB_ISSUES_TOKEN="<fine-grained PAT>"
```

Mint it at GitHub → Settings → Developer settings → Fine-grained tokens: resource
owner `DrBradStanfield`, **only** the `roadmap` repository, **Issues: read and
write** and no other permission, 1-year expiry. Nothing else on the machine reads
it. Rotate by minting a new one and setting it again; unset it and the connector
goes back to handing the user a prefilled link to submit themselves, which is what
the local stdio server always does. Note the expiry — an expired token does not
break the connector, it silently returns everyone to the link.

The app key MUST be the one the widget already uses. Dropbox scopes the app folder to
the app identity, so a second identity would see an empty folder (design §1).

**Google Drive is a separate pair of secrets** (step 4b). With no secrets the consent
screen offers Dropbox alone and every Drive path is unreachable — that is the whole
phase-2 gate, and it needs no deploy to open. **Set on `health-tool-edu` 2026-09-02**:

```bash
fly secrets set -a health-tool-edu \
  GOOGLE_DRIVE_CLIENT_ID="<the client id the widget already uses>" \
  GOOGLE_DRIVE_SECRET="<same OAuth client's secret>"
```

Same rule as Dropbox, for the same reason: `drive.file` shows an app only the files that
app created, so a second OAuth client would open an empty Drive.

**3. DNS and TLS.** `mcp.drstanfield.com` CNAME → the edu Fly app, then:

```bash
fly certs add -a health-tool-edu mcp.drstanfield.com
fly certs show -a health-tool-edu mcp.drstanfield.com   # wait for "Ready"
```

Must be IPv4 and publicly routable: Anthropic reaches it from `160.79.104.0/21`, and
discovery comes from the same range, so a WAF in front of the authorization server
breaks the flow.

**4. Dropbox app console.** Add the redirect URI `https://mcp.drstanfield.com/mcp/callback`.
Scopes: `files.content.read`, `files.content.write`, `files.metadata.read`. Leave the
app type as **App folder**. Watch the ceiling: the app is approved for **500 users** as of
2026-09-02. Past that, Dropbox freezes new links and the app needs a higher limit, which
is a request to Dropbox and Brad's to make.

**4b. Google Cloud console — Drive (Phase 2). DONE 2026-09-02**, brand verification
included. Same project and same OAuth client the widget uses
(`api.google-token.ts`). The live consent page now offers Dropbox and Google Drive.

Status: redirect URI added ✅ · publishing status **In production** ✅ · `GOOGLE_DRIVE_*`
Fly secrets on `health-tool-edu` ✅ · brand verification **DONE 2026-09-02** — the
consent screen shows the branded "Dr Brad" screen, no unverified-app interstitial ·
step 8 over Drive **PASSED 2026-09-02**.

1. **APIs & Services → Credentials →** the existing OAuth 2.0 Client ID → **Authorized
   redirect URIs → Add** `https://mcp.drstanfield.com/mcp/callback`. Exact string; Google
   matches it literally.
2. **OAuth consent screen → Publishing status must be "In production."** If it says
   "Testing", **every refresh token dies after 7 days** and every connection breaks at
   once, with no server-side remedy — we hold no row to update. This is the single most
   important line in this section.
3. **Scopes: `https://www.googleapis.com/auth/drive.file` only.** It is a non-sensitive
   scope, so the requirement is **brand verification** (app name, logo, homepage, privacy
   policy, authorized domain) — not a CASA security assessment, and the 100-user
   unverified cap does not apply. Verification is what stops users seeing the "unverified
   app" interstitial.
4. **Nothing else changes.** Do not add scopes, do not create a second client, do not
   touch the widget's own redirect URIs.

**The cost of connecting, stated once.** Google caps refresh tokens at **100 per account
per client id**, and that pool is SHARED with the widget. Each MCP connection mints one
(`prompt=consent` — a stateless server has nowhere to keep a token it did not just
receive, and Google issues one only on a first authorization or an explicit re-consent).
Reconnecting orphans the previous one. Past 100, Google silently drops the OLDEST, which
can be the widget's — the user's website login then quietly needs reconnecting. Nobody
should reach 100, and if support reports "my Drive keeps disconnecting", this is the first
thing to check.

**5. Check Fly's proxy access log before announcing anything.** OAuth secrets travel in
query strings, so a proxy that logs request URLs would write `code` and `state` to a log
we do not control. No route of ours logs a URL; confirm the platform does not either.

**6. Smoke it, in this order.**

```bash
curl -s https://mcp.drstanfield.com/.well-known/oauth-protected-resource/mcp | jq
#   resource must be exactly https://mcp.drstanfield.com/mcp
#   authorization_servers[0] must be https://mcp.drstanfield.com

curl -s https://mcp.drstanfield.com/.well-known/oauth-authorization-server | jq
#   client_id_metadata_document_supported: true
#   token_endpoint_auth_methods_supported: ["none"]

curl -si -X POST https://mcp.drstanfield.com/mcp -d '{}'
#   401, with WWW-Authenticate: Bearer resource_metadata="…"

curl -si https://mcp.drstanfield.com/mcp          # 405
curl -si -X DELETE https://mcp.drstanfield.com/mcp # 405
curl -si -X POST -H 'Origin: https://example.com' https://mcp.drstanfield.com/mcp -d '{}'
#   403, and NO Access-Control-Allow-Origin on any of these

# Ten seconds, and it checks an assumption the rate limiters rest on: Fly's
# proxy must OVERWRITE a client-supplied Fly-Client-IP, never pass it through.
# Send the same forged header twice from one machine and watch /token's per-IP
# limiter: if the forged value were trusted, an attacker would get a fresh
# bucket per request forever.
curl -si -X POST -H 'Fly-Client-IP: 1.2.3.4' \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  --data 'grant_type=nonsense' https://mcp.drstanfield.com/mcp/token
#   400 unsupported_grant_type. If a burst of these NEVER reaches 429 while the
#   same burst without the header does, the header is being trusted — stop and
#   tell the code (`getClientIp`), because every per-IP limit is then bypassable.
```

**Can Fly still fetch the vendors' client documents?** Run this whenever a vendor
connection starts failing at "We do not recognise the app":

```bash
fly ssh console -a health-tool-edu -C "node -e \"fetch('https://chatgpt.com/oauth/client.json').then(r=>console.log(r.status,r.headers.get('cf-mitigated')))\""
#   200 and null   → the fetch path still works for this vendor
#   403 challenge  → the document is behind a bot check from datacenter IPs
```

On 2026-09-02 `https://claude.ai/oauth/mcp-oauth-client-metadata` answered `403
challenge` from the Fly machine (User-Agent made no difference) and
`https://chatgpt.com/oauth/client.json` answered `200 null`. **The rule: a vendor
document that answers with a challenge gets PINNED in `KNOWN_CLIENTS`
(`app/lib/mcp-clients.server.ts`) — never worked around.** No proxy, no scraped
User-Agent, no third-party fetcher: those all mean trusting a document we could not
authenticate anyway. Pinning is the spec's own sanctioned mechanism
(draft-ietf-oauth-client-id-metadata-document-00 §4), it is two lines and a test, and
the pinned redirect URI must also pass `isAllowedRedirect`.

**Known follow-up, NOT this branch.** `app/lib/route-helpers.server.ts` carries a second,
`X-Forwarded-For`-only `getClientIp`, used by `api.chat` and `api.feedback`. Those limits
are still spoofable by one header. Same one-line fix, different blast radius: it wants its
own change and its own tests.

**7. Add the connector, as a user would.** Claude: Settings → Connectors → Add custom
connector → `https://mcp.drstanfield.com/mcp`. ChatGPT: Settings → Security → Developer
mode on → Plugins → Create app → same URL, Authentication OAuth, tick the risk box.
(Both paths walked on 2026-09-02; the user-facing versions are
`docs/guides/getting-started.md` and `docs/guides/connect-chatgpt.md`.) Both then run the OAuth flow: our consent
screen, then the provider the user picks, then back. Time the token exchange — Claude allows 10 seconds and
ours does a live provider code exchange inside that budget (design §7).

**Watch two things on that first connection.** (a) **Dropbox's `state` limit is believed,
not verified** — documented as 500 bytes, never confirmed by us. We now send a 43-char
nonce, so it should not bind; if Dropbox rejects the authorize URL or drops `state`, that
is what happened, and the answer is in the nonce, not in the sealed blob (design §4). (b)
The consent step is load-bearing: the callback needs the `__Host-mcp-state` cookie the
consent POST sets, so a browser blocking first-party cookies for the domain will land on
"that sign-in did not start here" rather than connecting.

**8. Verify against a real record**, in this order, and check the provider's file after
each write: `read_record` → `get_plan` → `add_measurement` → a correction with
`expectedValue` → a correction WITHOUT it (must refuse) → a correction on a row older
than 90 days (must refuse).

**Scratch accounts (Brad, 2026-09-05).** The Dropbox and Google Drive accounts under
`brad@microvitamin.com` are SCRATCH for testing: write, delete, corrupt anything there
freely. Brad's own accounts (`brad@drstanfield.com`, `b.d.stanfield@gmail.com`) are REAL
records — extract-only, never write test data, never commit their contents.

**8a. `import_documents` (US-35).** `tools/list` shows `import_documents` with
`_meta["openai/fileParams"]`. With a test PDF sitting in a connected Dropbox account's
folder root, `import_documents {}` returns candidates plus a receipt. Then
`{commit:{receipt, accept:[], replace:[]}}` writes zeros and leaves the record's rev
unchanged. On a Google Drive connection, the same call is refused, naming the website
upload or a ChatGPT drag as the way in.

**Step 8 over Drive — PASSED 2026-09-02, ~14:25 NZ.** The hosted MCP, via Claude.ai,
wrote a measurement to `My Drive / Health Plan by Dr Brad / health-roadmap.json`; a
Drive search found exactly one file of that name, so discovery did not diverge. The
website, connected to the same Drive account, loaded that row, and a correction made
on the website was read back by Claude. The one-file result closes the extra check
below: a second file of that name anywhere in the user's Drive would mean discovery
diverged, and would be a stop-everything bug — the user would have two records and see
neither whole.

**Rotation, when it is needed.** `MCP_SEAL_KEYS` is a comma-separated list; PREPEND the
new key to keep existing connections alive, or REPLACE it outright to kill every
connection at once — the standing incident response, because a leaked seal key is
retroactive over every blob ever issued. `MCP_CLIENT_HMAC_KEY` is different and
user-visible: rotating it forces every affected user to REMOVE AND RE-ADD the connector,
because Anthropic freezes a connector's auth settings once it is added. Rotate that one
only with a comms plan.

### Other assistants: Claude Code and Gemini CLI

Both connect to the hosted server as of 2026-09-02, when loopback redirects were turned
on (RFC 8252 §7.3, US-32 AC21). A command-line client listens on an ephemeral port on the
user's own machine, so the port cannot be registered in advance; `redirectMatches` ignores
the port and nothing else. Claude Code's metadata document is pinned in `KNOWN_CLIENTS`
alongside the web one, for the same Cloudflare reason. Gemini CLI registers dynamically.

```bash
claude mcp add --transport http drstanfield https://mcp.drstanfield.com/mcp
gemini mcp add -s user --transport http drstanfield https://mcp.drstanfield.com/mcp
```

Each opens a browser once for our consent screen and the cloud provider, then keeps the
sealed token. Nothing per user is stored on our side either way.

### Publishing the ChatGPT app

Only OpenAI gates *connection* behind review; what every other assistant requires (Claude's
directory, Gemini, Perplexity, Le Chat, Copilot) is in **[assistant-landscape.md](assistant-landscape.md)**.

Today a user needs **developer mode** to add our connector to ChatGPT, because OpenAI
keeps unreviewed connectors behind it. Claude needs no equivalent: a custom connector is
available on any plan. Publishing through OpenAI's review is what removes that step.
**Nothing here has been submitted.** Every field the form asks for is written out in
**[chatgpt-app-listing.md](chatgpt-app-listing.md)**: descriptions, category, tool
annotations, starter prompts, the eight test cases, the demo-credentials answer, the PHI
compliance statement, and a numbered dashboard checklist. That file is the working
document; this section holds only what it depends on.

**Brad's, not an agent's — all of it.** Submission is tied to a verified identity on his
OpenAI account and to policy acknowledgements he is signing. Identity verification gates
creating the app in the dashboard, not just submitting it.

**Two blockers before the form.** First, **we have no privacy policy that describes this
connector** — the site policy predates it. It must state the data categories, purpose,
recipients, retention and the user's controls, and say what §1 of `mcp-architecture.md`
says: the record is read in memory to answer one call, no copy is kept, no per-user row
exists, and the user cancels at `dropbox.com/account/connected_apps`. Second, OpenAI's
developer guidelines list **protected health information under Restricted Data**. Read
strictly that is a refusal; read as written it is about what the plugin *collects*, and
we collect and store nothing. **A question for OpenAI, asked before submission, not a
judgement made silently in a form.** If the answer is no, developer mode stays the
honest path.

**One new secret, `OPENAI_APPS_CHALLENGE`** on `health-tool-edu`: the token the
submission portal generates for domain verification. `app/routes/[.]well-known.$.tsx`
serves it at `/.well-known/openai-apps-challenge` as bare `text/plain`, `no-store`, and
404s while unset. It answers independently of `isMcpEnabled()`, so ownership can be
proved before the connector is switched on. Rotate by setting the secret again.

### Listing in Anthropic's Connectors Directory

Claude's custom-connector path already works on every plan, so a listing buys discovery, a
named card, Suggested Connectors and Anthropic-held credentials, not access.
**The blocker is the account:** the portal at
`claude.ai/admin-settings/directory/submissions/new` is part of organization settings, so it
needs a **Team or Enterprise** org and an Owner; an individual plan has no such page. Field
list, plan quotes and our CIMD status are in
[assistant-landscape.md](assistant-landscape.md). The prompt-injection acknowledgement gets
`mcp-architecture.md` §3's stated residual, not a reassurance. Publishing to the open MCP
Registry or the `modelcontextprotocol/servers` repo does **nothing** for visibility inside
Claude; only the directory does.
