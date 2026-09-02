# Assistant landscape — who can add our hosted MCP server, and what listing costs

Researched 2026-09-02 from primary vendor docs. The question behind it: does every
assistant need the publisher-verification-plus-review dance the ChatGPT app submission
needs? **No.** Only OpenAI gates connection itself behind review. Everywhere else a user
can paste `https://mcp.drstanfield.com/mcp` today, and a listing buys discovery only. Our
server is OAuth 2.1 with discovery, CIMD and DCR registration over streamable HTTP, which
is the shape all of them want.

## Claude — connecting works on every plan; listing needs an org we do not have

Adding is unrestricted. `support.claude.com/en/articles/11175166-about-custom-connectors-remote-mcp`:

> "Custom connectors using remote MCP are available on Claude, Cowork, and Claude
> Desktop for users on Free, Pro, Max, Team, and Enterprise plans. Free users are
> limited to one custom connector."

An individual adds it themselves; on the org plans it is an admin act ("only Owners can
add them to Team and Enterprise plans").

**Directory listing is the part Brad cannot do on a personal plan.**
`claude.com/docs/connectors/building/submission`:

> "The portal is part of your organization's settings, so you need: A Team or Enterprise
> organization. Organization settings aren't available on individual plans."

> "By default, only organization Owners and Primary owners can submit and manage
> directory listings."

There is **no solo-developer listing route for a remote server**; the only submission path
outside the org portal is local desktop extensions (MCPB). Requirements if an org exists:
OAuth 2.0, a `title` plus `readOnlyHint`/`destructiveHint` on every tool, a privacy policy
URL, documentation, reviewer credentials that drive every tool, a permanent slug, and seven
policy acknowledgements (one on prompt injection). The Data-handling step asks outright
"whether the connector handles personal health data" — for us that is yes, answered with
`mcp-architecture.md` §1, not softened.

**Our CIMD pin still matches the docs.** `claude.com/docs/connectors/building/authentication`
lists `oauth_cimd` as "Supported out of the box", and states the selection rule we already
satisfy:

> "Claude selects CIMD only when your authorization server metadata advertises both
> `"client_id_metadata_document_supported": true` and `"none"` in
> `token_endpoint_auth_methods_supported`"

It confirms the hosted redirect URI `https://claude.ai/api/mcp/auth_callback`, and that
Claude Code is separate: a loopback redirect on an ephemeral port, declaring
`http://localhost/callback` and `http://127.0.0.1/callback` in its own CIMD at
`https://claude.ai/oauth/claude-code-client-metadata` — which is why `redirectMatches`
ignores the port. The docs never name the hosted-surface document we pin,
`https://claude.ai/oauth/mcp-oauth-client-metadata` **(unverified — not in the docs; it is
what the live client presented on 2026-09-02)**. Also: 10 s for discovery, registration and
token, 30 s for refresh; egress from `160.79.104.0/21`; CIMD preferred over DCR.

## Gemini — the consumer app does take our URL now, with real gating

`support.google.com/gemini/answer/17209137`. Settings & help > Connected Apps > **Custom
apps for Spark** > Add a custom app > "Enter the app's MCP server URL". Servers without
Dynamic Client Registration make the user paste credentials by hand; ours does DCR, the
happy path.

The gating disqualifies most of the audience today: "Be 18 or over and in the US", a
personal Google Account ("this feature isn't available if you sign in with a work or
school Google Account"), Keep Activity on, and access to Gemini Spark.

**No developer submission programme, no review, no directory** for these. The user pastes
a URL; nothing to publish, and so no discovery either.

Other Google surfaces taking a remote MCP server with OAuth: **Gemini CLI** (below),
**Gemini Enterprise** (`support.google.com/g/answer/17106276`), and **Vertex AI / ADK** in
code. Gemini in Chrome and Workspace expose no user-addable MCP path **(unverified — no
primary doc found either way)**.

### Gemini CLI config

`settings.json` lives at `~/.gemini/settings.json` (user) or `.gemini/settings.json`
(project). One command does the hosted server, matching the runbook:

```bash
gemini mcp add -s user --transport http drstanfield https://mcp.drstanfield.com/mcp
```

That writes `httpUrl`; `-s user` picks user scope over the default project scope. OAuth is
discovered, not configured: `authProviderType` defaults to `dynamic_discovery`, and the
equivalent hand-written entry is `"httpUrl"` plus `"oauth": { "enabled": true }`.
`/mcp auth drstanfield` re-runs the flow; tokens land in `~/.gemini/mcp-oauth-tokens.json`
and refresh themselves. The local stdio server, same file the CLI guide describes:

```json
{ "mcpServers": { "roadmap-local": {
  "command": "npx",
  "args": ["tsx", "tools/mcp-server.ts", "--file", "/Users/you/health-roadmap.json"],
  "cwd": "/path/to/roadmap"
} } }
```

`cwd` is not optional: `npx tsx` must resolve this repo's dependencies.

## Everyone else

- **Perplexity** — Pro, Max and Enterprise can add a custom remote MCP connector by URL
  with OAuth, API key or no auth; Enterprise admins can share one org-wide and can block
  members from adding their own. **(unverified — the help page returns 403 to fetchers, so
  the plan list is from the indexed summary, not a page we read.)**
  `perplexity.ai/help-center/en/articles/13915507-adding-custom-remote-connectors`
- **Mistral Le Chat** — connects "to any remote MCP server of choice, even if it's not
  listed in the Connectors directory"; admins control availability per org. A directory
  exists, but inclusion is not needed to connect.
  `mistral.ai/news/le-chat-mcp-connectors-memories/`
- **Microsoft Copilot** — no consumer path. M365 Copilot and Copilot Studio take remote MCP
  servers, but registration is admin-governed: a developer registers the server, then "the
  IT admin reviews the server details and declared tools in the Microsoft 365 admin center,
  then approves or rejects the request." `learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/build-mcp-plugins`
- **Dev tools** (Claude Code, Cursor, Windsurf, VS Code) take the URL in one command, with
  no listing process. Claude Code is already in the runbook.

## What this means for us

None of this is a second ChatGPT submission. ChatGPT is the only surface where review buys
*connection*; for Claude it buys discovery and needs a Team org; elsewhere, nothing to submit to.
