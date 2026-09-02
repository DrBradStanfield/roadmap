# Health Roadmap Tool

Health-metric tracking with personalized suggestions, delivered as a Shopify
storefront theme extension and as a self-hosted page.

**Local-first.** A user's health data lives in their own cloud (Google Drive,
Dropbox, GitHub, WebDAV) or in localStorage, as a single `health-roadmap.json`
file. It never lands on our server. "Logged in" means a cloud provider is
connected. The Fly backend is thin: chatbot, lab-import extraction, A/B and
product events, email reminders, Klaviyo capture, and the hosted MCP server.
Supabase holds operational rows only, never health values.

## The three agent surfaces

The same file, the same write path, three ways in.

1. **Widget** — the React app in the storefront or on the self-hosted page.
   Reads and writes through `RoadmapStore`.
2. **CLI and stdio MCP** — `tools/get-plan.ts`, `tools/edit-record.ts` and
   `tools/mcp-server.ts`, running on the user's own machine against their own
   file. See [docs/guides/command-line.md](docs/guides/command-line.md) and
   [docs/guides/connect-claude-desktop.md](docs/guides/connect-claude-desktop.md).
3. **Hosted MCP** — `https://mcp.drstanfield.com/mcp`, live since 2026-09-02 on
   the Fly app `health-tool-edu`, over Dropbox and Google Drive.

Every non-browser writer goes through the same `SyncManager`
(`packages/health-core/src/sync-manager.ts`), which merges on conflict and
verifies after writing. The CLI and stdio MCP run it over `file-adapter.ts`,
which takes a lock file and keeps backups. The hosted MCP runs it over the REST
adapters (`dropbox-rest.ts`, `drive-rest.ts`), where the provider's own
conditional write does the same job.
See [packages/health-core/README.md](packages/health-core/README.md).

Rows are never mutated. A correction appends a new row and marks the old one
`entered-in-error`.

## Two builds, one source

| Build | Command | Where |
| --- | --- | --- |
| Shopify storefront | `npm run build:shopify-prod` | both stores, theme extension |
| Self-host | `npm run build:pages` | GitHub Pages, no backend, bring your own keys |

Flags: `VITE_LOCAL_FIRST` for all v2 behavior, `VITE_SHOPIFY_SURFACE` to gate
the features that need our server.

## Getting started

```bash
git clone <repo-url>
cd roadmap
npm install
cp .env.example .env   # fill in what you need
npm run test:all
```

Node 20.10 or newer. Never run `shopify app dev`: the dev preview overrides
production.

## Tests

```bash
npm test          # symlink guard + health-core + server
npm run test:all  # everything, and what CI runs
npx vitest run <path>
```

## Deploy

CI is the deploy path: `.github/workflows/deploy.yml`, triggered from Actions →
Deploy → Run workflow. All credentials live in the GitHub `production`
environment. Manual and emergency steps, plus the two-app Fly split, are in
[docs/deploy-runbook.md](docs/deploy-runbook.md).

## Where to read next

- [CLAUDE.md](CLAUDE.md) — the working contract for this repo.
- [docs/architecture-v2.html](docs/architecture-v2.html) — the visual system
  map, and the best entry point.
- [docs/reference.md](docs/reference.md) — file inventory, data model,
  endpoints, gotcha archive.
- [docs/user-stories.md](docs/user-stories.md) — every behavior change starts
  as a story here.
- [docs/agent-access.md](docs/agent-access.md) and
  [docs/mcp-architecture.md](docs/mcp-architecture.md) — the agent contract and
  the MCP map.
- [docs/guides/](docs/guides/) — the user-facing guides.
- [docs/privacy-connector-addendum.md](docs/privacy-connector-addendum.md) —
  draft privacy language for the AI connector.
