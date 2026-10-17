# Threat model: Health Roadmap

## What this project does
Health Roadmap tracks a person's health measurements (blood tests, blood pressure, weight, medications) and turns them into evidence-based suggestions. It is local-first. Each person's record is one JSON file kept in their own Google Drive, Dropbox or GitHub, or in browser storage. It is never stored on our server.

The server (Remix/react-router on Fly.io, under `app/`) is a thin backend. It runs the chatbot, lab-report import (files sent to an LLM for extraction), A/B and product events, email reminders, Shopify app-proxy routes and webhooks, and a hosted MCP connector with OAuth (`app/routes/mcp.$.tsx`, `mcp.drstanfield.com`) that lets AI assistants read and write a person's record. Supabase holds operational data only (chat logs, events, reminders, sessions), never health values.

## Where untrusted input enters
- Every `app/routes/api.*` route. Storefront requests arrive through the Shopify app proxy, verified by HMAC; only the HMAC-verified `logged_in_customer_id` is trusted, never an id in the body.
- Chat messages and the client-supplied health snapshot (`guestInputs`) sent with them.
- Uploaded lab reports (PDFs and images) and the LLM's extraction of them.
- MCP tool calls and OAuth flows from AI assistants (`app/lib/mcp*`, `packages/health-core/src/mcp-tools.ts`).
- The record file itself, read back from the person's cloud storage, which anyone with access to that storage can edit (`packages/health-core/src/roadmap-file.ts`, `merge.ts`, `sync-manager.ts`).
- Webhooks (Shopify, Resend) and text from Discord and YouTube comments that reaches the chatbot.
- Any text that reaches a model prompt is data, never instructions.

## Components that matter most
1. Anything that lets one person read or write another person's record, or act as another Shopify customer.
2. The MCP connector: OAuth, consent, client registration, redirect handling, token storage and the per-connection limits.
3. Anything that puts a health value where it must never be: a log, Sentry, a product event, a Supabase row, a public issue.
4. Prompt injection that makes the chatbot or an MCP tool write to a record, propose a subscription change, or send a message without the person's confirmation.
5. Record integrity: the merge must never lose or silently change a value (rows are append-only; corrections append a new row).
6. XSS in the storefront widget (`widget-src/`), which runs on a shop page beside the customer's session.

Lower priority: the Pages self-host build, docs, `src/demo-video/`, and the loop tooling under `docs/loops/`.

## How to exercise it
- `npm run test:all` runs every Vitest suite (server routes, health-core, widget, tools).
- `npx tsx tools/mcp-server.ts` runs the stdio MCP server against a local record file; `tools/` also has a CLI.
- No live credentials are in the repository. Routes that need Shopify, Supabase, Anthropic or Google fail closed without their environment variables, so test them through the existing suites and mocks.

## How we rate severity
- Critical: cross-person read or write of health data; MCP auth or consent bypass; remote code execution on the server.
- High: a health value reaching logs, telemetry or any server store; prompt injection that causes a write or an action without confirmation; stored XSS in the widget; HMAC or app-proxy bypass.
- Medium: reflected XSS needing unlikely interaction; a merge bug that loses a value only under a race; rate-limit bypass on a paid endpoint (chat, lab import).
- Low: denial of service, missing hardening headers, information leaks with no health or credential content.

## Please leave alone
- Missing environment variables or secrets: they are supplied at deploy time by design.
- The Shopify storefront theme and third-party services we do not run.
- Medical correctness of the suggestions: that is clinical review, not security, unless input crafted by an attacker changes what another person is shown.
