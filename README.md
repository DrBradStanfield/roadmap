# Health by Dr Brad

Health-metric tracking with personalized suggestions, delivered as a Shopify
storefront theme extension and as a self-hosted page.

**Local-first.** A user's health data lives in their own cloud (Google Drive,
Dropbox, GitHub, WebDAV) or in localStorage, as a single `health-roadmap.json`
file. The website and the local tools never send that file to our server; the hosted
connector at `mcp.drstanfield.com` holds it in server memory for the length of one
request and stores none of it. "Logged in" means a cloud provider is
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
`widget-src/src/lib/sentry.ts` before anything leaves the browser: on
`drbradstanfield.github.io` it is enabled, under the environment name
`standalone`, so the page does talk to sentry.io.

The rest of what the page loads is its own. `widget-src/standalone/index.html`
carries one module script and loads no third-party script at load time; Sentry is
bundled into it, and the hero image is fetched from `cdn.shopify.com`. Connecting
Google Drive loads Google's sign-in script from `accounts.google.com`. Cloud credentials and the
optional Anthropic key live in `localStorage` for that origin
(`hr_anthropic_key`, `health_roadmap_dropbox_tokens`, `health_roadmap_gdrive`
and `health_roadmap_gdrive_tokens`, `health_roadmap_github`, and
`health_roadmap_selfhost`, which holds a WebDAV username and password), where any script
running on the origin can read them. `/roadmap/` and `/roadmap/dev/` are the
same origin, so the staging preview shares that storage with the live page.

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
  endpoint on our server accepts the record for storage. The hosted connector is
  the one place a record reaches our server at all, and only if you connect one:
  it reads the file in server memory for the length of one request and stores
  none of it.
- Two requests carry health content, and you trigger both. A lab-document
  upload POSTs the document's page content to `/api/lab-import-v2`, which sends
  it to Anthropic's API for extraction, returns the values, and stores none of
  them. Sending a chat message from the storefront widget POSTs the message,
  that conversation's earlier turns, and the health context needed to answer it
  to `/api/chat`. On that surface the server stores one row per question: the
  text you typed, which may hold health details you wrote into it; the articles
  it matched; its classification; the router's raw output and any router error;
  the name of the surface; and a pseudonymous session and conversation id. The
  earlier turns and the reply are not stored. A daily job blanks the question
  text, the router's raw output and the error text once a row is 30 days old;
  the match record stays: the articles, the classification, the ids. A guest
  session row holds a hashed address, not an IP.
- The chat bubble on blog pages and the chatbot embed send more, and keep more.
  Both read the widget's cached inputs out of `localStorage` and send them as
  chat context on every message (`loadGuestInputs()` in
  `widget-src/src/site-chat.tsx` and `widget-src/src/chatbot-embed.tsx`).
  Neither bundle sets `VITE_LOCAL_FIRST`, so the server takes them for a stored
  surface: it writes your question and the reply into `chat_messages`, and the
  reply can quote the values you were sent with. Those cached values are still
  sent as context; Brad chose on 2026-09-10 to keep that, because the answer is
  worse without them. The transcripts now join the same 30-day purge
  (`app/lib/chat-purge-cron.server.ts`): once a row is 30 days old the job
  blanks the message text and the conversation title, which is the first words
  of your question. What stays is the shape of the thread, not the words: row
  ids, the role, the timestamps, the model, the token counts, and the fallback
  flags. A blanked turn reads back as `[removed after 30 days]`. Only Shopify
  rows are touched; the Discord and YouTube transcripts are unchanged.
- Telemetry is a closed allow-list of event names in
  `packages/health-core/src/product-events.ts`. An event is a name plus an
  anonymous visitor UUID, and the server rejects any name off the list.
- Nothing else we call carries a value. `/api/google-token` forwards an OAuth
  code or refresh token to Google and stores nothing. `/api/reminders-v2` sends
  your reminder schedule, which is a label such as "Colonoscopy" and a due
  date. On the storefront you do not have to enrol: connecting a cloud provider
  enrols you, because that connection IS the consent (`autoEnrolReminders` in
  `widget-src/standalone/reminders.ts`, the default-on decision of 2026-08-11).
  Your cloud account's email address, the labels and the dates reach us on that
  connect. The plan-ready email that follows says reminders are coming and
  carries the one-click off switch, as does every reminder after it. On the
  GitHub Pages build nothing enrols you: `autoEnrolReminders` returns
  immediately off the Shopify surface, and only the toggle, which asks you for
  an address, can enrol you. Either way what we hold is that address, the
  schedule and the token that turns reminders off: no health values, no
  account, nothing else. The optional plan email sends the address you type and
  that same schedule.
- Feedback you type into the widget's feedback box is stored and emailed. The
  route takes your email address and up to 2000 characters of free text, adds
  your Shopify customer id when you are logged in, writes the row to
  `feedback_submissions` and sends the same thing to Brad through Resend
  (`app/routes/api.feedback.ts`, `recordFeedbackSubmission` in
  `app/lib/product-events.server.ts`). Nothing scrubs that text and nothing
  deletes the row, so health details you write there stay written.
- Errors go to Sentry, scrubbed in the browser before they leave it
  (`widget-src/src/lib/sentry.ts`): console breadcrumb text is replaced, fetch
  breadcrumb URLs are cut back to their origin, and record-operation errors are
  reduced to a fixed message and a closed set of tags. `sendDefaultPii` is
  never set. Read the text scrub for what it is
  (`packages/health-core/src/sentry-scrub.ts`): it removes email addresses,
  numbers carrying a unit, and numbers written within 20 characters of about
  thirty metric and lab words, and server-side it drops any extra field longer
  than 200 characters. It does not recognise a diagnosis or a name written in
  prose, and it has no phone-number rule (that guard sits in the connector's
  `report_feedback` tool). The control that carries the weight is upstream: the
  code throws errors with fixed messages instead of echoing the text it was
  reading. The lab-extraction parse path was changed on 2026-09-10 to do the
  same, because a JSON or schema error quotes the document back.
- Health files cannot ride into the server image. Every health-data pattern in
  `.gitignore` is also excluded in `.dockerignore`, and a test asserts the two
  stay in step (`tests/dockerignore.test.ts`), so adding an ignore rule without
  the matching exclusion fails the suite.
- The plan footer links to
  [the privacy notice](https://drstanfield.com/pages/connector-privacy) on both
  builds (`widget-src/src/components/ResultsPanel.tsx`), so what we do with
  your data is one click from your plan, not buried in a consent screen.

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
