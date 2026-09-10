# Health by Dr Brad

Health-metric tracking with personalized suggestions, delivered as a Shopify
storefront theme extension and as a self-hosted page.

**Local-first.** A user's health data lives in their own cloud (Google Drive,
Dropbox, GitHub, WebDAV) or in localStorage, as a single `health-roadmap.json`
file. It never lands on our server. "Logged in" means a cloud provider is
connected. The Fly backend is thin: chatbot, lab-import extraction, A/B and
product events, email reminders, Klaviyo capture, and the hosted MCP server.
Supabase holds operational rows only, never health values. Email reminders are
the one place a screening name reaches us: that row holds the enrolled email
address, the screening labels and the dates they are due, and nothing else
(`app/lib/reminder-v2.server.ts`).

## The three agent surfaces

The same file, the same write path, three ways in.

1. **Widget**: the React app in the storefront or on the self-hosted page.
   Reads and writes through `RoadmapStore`.
2. **CLI and stdio MCP**: `tools/get-plan.ts`, `tools/edit-record.ts` and
   `tools/mcp-server.ts`, running on the user's own machine against their own
   file. See [docs/guides/command-line.md](docs/guides/command-line.md) and
   [docs/guides/connect-claude-desktop.md](docs/guides/connect-claude-desktop.md).
3. **Hosted MCP**: `https://mcp.drstanfield.com/mcp`, live since 2026-09-02 on
   the Fly app `health-tool-edu`, over Dropbox and Google Drive. Nine tools as
   of 2026-09-07: the hosted-only `import_documents` (US-35) reads lab files
   from the Dropbox app folder (Drive's `drive.file` scope cannot see dropped
   files), and `file_results` (US-36) takes the rows the assistant read from a
   file dropped into the chat, so the file never reaches our server. On
   Dropbox a read also names folder files not yet in the record (US-37).

To answer one hosted call, the server unseals the cloud credential the
assistant holds, opens the user's folder with it, and holds the record in
server memory for the length of that request. It stores none of it. Anyone who
does not want that runs surface 2 instead: `tools/mcp-server.ts` is the same
tool layer over the same file with no server of ours in it at all
([docs/guides/connect-claude-desktop.md](docs/guides/connect-claude-desktop.md)).

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
| Self-host | `npm run build:pages` | GitHub Pages, almost no backend, bring your own keys |

Flags: `VITE_LOCAL_FIRST` for all v2 behavior, `VITE_SHOPIFY_SURFACE` to gate
the features that need our server.

"Almost no backend" is the honest version of the Pages build. The record and
the chat never touch our server there: the record is written straight to the
user's own cloud, and chat runs on the user's own key. Two optional calls do
reach us, and only if the user makes them. Signing in with Google posts the
OAuth code to `/api/google-token`, which forwards it to Google and stores
nothing (`widget-src/standalone/google-config.ts`). Enrolling in email
reminders posts the address and the due dates to `/api/reminders-v2`
(`widget-src/standalone/reminders.ts`). Sentry error reporting also runs on
this build (`widget-src/standalone/app.tsx` calls `initSentry`), scrubbed by
`widget-src/src/lib/sentry.ts` before anything leaves the browser.

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

## Verifying this yourself

You do not have to take the code's word for it. Open the site with the DevTools
network tab recording and use the widget.

- Saving a metric produces no request to our server. The record file is written
  only by the adapters in `widget-src/src/storage/` (`dropbox.ts`, `drive.ts`,
  `github.ts`, `webdav.ts`, `local-storage-adapter.ts`), so the write goes to
  your own Dropbox, Google Drive, GitHub, WebDAV server, or localStorage. No
  endpoint on our server accepts the record.
- Two requests carry health content, and you trigger both. A lab-document
  upload POSTs the document's page content to `/api/lab-import-v2`, which sends
  it to Anthropic's API for extraction, returns the values, and stores none of
  them. Sending a chat message from the storefront widget POSTs the message,
  that conversation's earlier turns, and the health context needed to answer it
  to `/api/chat`. On that surface no message content and no reply is stored. We
  keep the question text for 30 days, to check that article matching works, and
  then remove it; the articles it matched stay on as counts. A guest session
  row holds a hashed address, not an IP. The chat bubble on blog pages, and the
  Discord and YouTube bots, keep their transcripts on our server.
- Telemetry is a closed allow-list of event names in
  `packages/health-core/src/product-events.ts`. An event is a name plus an
  anonymous visitor UUID, and the server rejects any name off the list.
- Nothing else we call carries a value. `/api/google-token` forwards an OAuth
  code or refresh token to Google and stores nothing. `/api/reminders-v2` sends
  your reminder schedule, which is a label such as "Colonoscopy" and a due
  date. If you enrol, that is what we hold, beside your email address and the
  token that turns reminders off: no health values, no account, nothing else.
  The optional plan email sends the address you type and that same schedule.
- Errors go to Sentry, scrubbed in the browser before they leave it
  (`widget-src/src/lib/sentry.ts`): console breadcrumb text is replaced, fetch
  breadcrumb URLs are cut back to their origin, and record-operation errors are
  reduced to a fixed message and a closed set of tags. `sendDefaultPii` is
  never set.

## Where to read next

- [CLAUDE.md](CLAUDE.md): the working contract for this repo.
- [docs/architecture-v2.html](docs/architecture-v2.html): the visual system
  map, and the best entry point.
- [docs/reference.md](docs/reference.md): file inventory, data model,
  endpoints, gotcha archive.
- [docs/user-stories.md](docs/user-stories.md): every behavior change starts
  as a story here.
- [docs/agent-access.md](docs/agent-access.md) and
  [docs/mcp-architecture.md](docs/mcp-architecture.md): the agent contract and
  the MCP map.
- [docs/guides/](docs/guides/): the user-facing guides.
- [docs/privacy-connector-addendum.md](docs/privacy-connector-addendum.md):
  draft privacy language for the AI connector.
