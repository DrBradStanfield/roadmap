# tools

Most of this directory is internal: test harnesses and verification scripts
for other parts of the app. Four files are the actual product, shipped for
users and agents: three run against their own `health-roadmap.json`, and one
searches the knowledge base:

- **`mcp-server.ts`**: a stdio MCP server. Point Claude Desktop or Claude
  Code at it and it exposes the record as named tools (read, compute plan,
  add a value, add a lab panel, correct a value, change one of the four
  profile fields, report a problem: eight in all). The eighth,
  `import_documents`, is hosted-only: this local server lists it but refuses
  it, having no model and no network. Setup:
  [docs/guides/connect-claude-desktop.md](../docs/guides/connect-claude-desktop.md).
- **`edit-record.ts`**: the CLI that writes to the record, `add` and
  `correct`, one value per call.
- **`get-plan.ts`**: the CLI that reads the record and prints the plan,
  offline, in prose, JSON or HTML.
- **`search-knowledge.ts`**: the CLI that searches Dr Brad's articles,
  references, guidelines and pathways (`search-knowledge "<query>"`) and
  prints one entry (`--article <handle>`, the get-article command). Lexical,
  offline, no model; the tool writes the query nowhere. No MCP tool yet (US-41).
  `search-knowledge-eval.ts` measures its recall over the router fixtures.

All three CLIs are documented in
[docs/guides/command-line.md](../docs/guides/command-line.md).

Everything else here is internal, not part of the shipped surface. A few
examples: `webkit-verify.mjs` and its siblings drive real WebKit for layout
regressions; `test-queries.json` and `test-chatbot-matching.ts` are chatbot
router fixtures; `chat-audit-pull.ts` and `youtube-comment-dryrun.ts` are
one-off ops scripts. Each `*.test.ts` file is Vitest coverage for the file
next to it. The demo videos moved out of here to
[demo-video/](../demo-video/) at the repo root: a standalone Remotion
project, not a tool.
