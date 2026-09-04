# tools

Most of this directory is internal: test harnesses and verification scripts
for other parts of the app. Three files are the actual product, shipped for
users and agents to run against their own `health-roadmap.json`:

- **`mcp-server.ts`**: a stdio MCP server. Point Claude Desktop or Claude
  Code at it and it exposes the record as named tools (read, compute plan,
  add a value, add a lab panel, correct a value, change one of the four
  profile fields, report a problem — eight in all). The eighth,
  `import_documents`, is hosted-only: this local server lists it but refuses
  it, having no model and no network. Setup:
  [docs/guides/connect-claude-desktop.md](../docs/guides/connect-claude-desktop.md).
- **`edit-record.ts`**: the CLI that writes to the record, `add` and
  `correct`, one value per call.
- **`get-plan.ts`**: the CLI that reads the record and prints the plan,
  offline, in prose, JSON or HTML.

Both CLIs are documented in
[docs/guides/command-line.md](../docs/guides/command-line.md).

Everything else here is internal, not part of the shipped surface. A few
examples: `webkit-verify.mjs` and its siblings drive real WebKit for layout
regressions; `test-queries.json` and `test-chatbot-matching.ts` are chatbot
router fixtures; `chat-audit-pull.ts` and `youtube-comment-dryrun.ts` are
one-off ops scripts. Each `*.test.ts` file is Vitest coverage for the file
next to it. `demo-video/` is a standalone Remotion project (own
`package.json`, gitignored `node_modules`/`out/`) for the ChatGPT-style
connector demo video — see its own README.
