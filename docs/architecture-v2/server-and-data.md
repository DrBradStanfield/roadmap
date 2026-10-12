---
title: Roadmap Server and Data
artifact: https://claude.ai/artifact/UHX89T2TiEVpPRGn2WbKBY
---

# Server & data

Part of [Health by Dr Brad — Architecture (v2, local-first)](../architecture-v2.md).

<a id="api"></a>
## API endpoints (surviving)

| Route | Purpose | Auth |
|---|---|---|
| [api.chat.ts](../../app/routes/api.chat.ts) | Chat CRUD + LLM pipeline; guest-with-context for local-first | App proxy (+ guest) |
| [api.lab-import-v2.ts](../../app/routes/api.lab-import-v2.ts) | Stateless Claude lab extraction; nothing stored | App-proxy HMAC signature |
| [api.reminders-v2.ts](../../app/routes/api.reminders-v2.ts) | Reminder opt-in / update / cancel; provider-verified email + capability token | Provider proof |
| [api.google-token.ts](../../app/routes/api.google-token.ts) | Stateless Google OAuth code/refresh exchange (Drive) | CORS allow-list + rate limit |
| [api.measurements.ts](../../app/routes/api.measurements.ts) | **Klaviyo capture only** (all v1 CRUD torn down) | App proxy + 5/day/email |
| [api.ab.ts](../../app/routes/api.ab.ts) | A/B impression/conversion events | App proxy, rate-limited |
| [api.feedback.ts](../../app/routes/api.feedback.ts) | Feedback form → email (Resend) | 3/hr per-IP |
| [api.events.ts](../../app/routes/api.events.ts) | Product funnel events (`product_events`, value-free) | App proxy, 20/min per visitor |
| [api.resend-webhook.ts](../../app/routes/api.resend-webhook.ts) | Resend delivery events | Svix signature |
| [mcp.\$.tsx](<../../app/routes/mcp.$.tsx>) | Hosted MCP (edu app): `/mcp` JSON-RPC, `/mcp/authorize` consent, `/mcp/callback`, `/mcp/token`, `/mcp/register` (DCR) | OAuth 2.1 + PKCE; sealed bearer token |
| [\[.\]well-known.\$.tsx](<../../app/routes/[.]well-known.$.tsx>) | RFC 9728 / 8414 OAuth metadata + OpenAI apps challenge | none (public metadata) |
| [healthz.ts](../../app/routes/healthz.ts) | Fly health check | none |

**Deleted in the teardown:** `api.user-data`, `api.lab-import` (v1), `api.lab-values`, `api.health-documents`, `api.reminders` (v1), plus the earlier `api.customer-measurements` / `api.customer-health-profile` / `api.health-profile`. The admin app (`app.*.tsx`), webhooks, and auth routes remain.

<a id="crons"></a>
## Crons

Each worker **auto-starts on module import** at the bottom of its own file; [entry.server.tsx](../../app/entry.server.tsx) imports the `stop*` functions (which triggers the start) and wires them to SIGTERM. There is no central registry.

- [reminder-v2-cron.server.ts](../../app/lib/reminder-v2-cron.server.ts) — daily; emails due reminders from `reminder_optin_v2`
- [trending-cron.server.ts](../../app/lib/trending-cron.server.ts) — daily; trending articles → shop metafield
- [youtube-bot.server.ts](../../app/lib/youtube-bot.server.ts) (+ summary cron) — 30-min comment auto-replier
- [discord-bot.server.ts](../../app/lib/discord-bot.server.ts) — gateway WebSocket (gated on token + `FLY_APP_NAME`)

> **The v1 reminder cron is gone.** `reminder-cron.server.ts` and its `cleanupGuestProfiles()` were retired (commit `e97fa24`) — that cleanup used to cascade-delete guest profiles *and their chat*, which would have destroyed the chat history the business decided to keep. It was deployed before the data purge for exactly that reason.

<a id="supabase"></a>
## Supabase today + the 2026-06 purge

Supabase survives, but only as a chat-history + A/B store. All per-user health data is gone.

#### Kept (anonymized)

- `chat_conversations`, `chat_messages`, `chat_match_events`, `guest_chat_sessions` — every row kept, identity/IP/error fields scrubbed, pseudonymous session token preserved so a user's turns stay linked. For training.
- `profiles` — kept as pseudonymous FK anchors (demographics nulled, synthetic `anon-…@deleted.invalid` email).
- `ab_tests`, `ab_events` — untouched.
- `audit_logs` — kept, `user_id` nulled.

#### Deleted

- All 11 per-user health tables: `health_measurements`, `lab_values`, `health_documents`, `medications`(+history), `supplements`(+history), `screenings`, `reminder_preferences`, `reminder_log`, `message_credit_transactions` — emptied.
- `auth.users` / `auth.identities` — rows kept (chat FKs reference the id), but emails scrubbed to `anon-…@deleted.invalid`. Only the Discord bot row keeps a real address.

Executed 2026-06-12/13 via [supabase/data-purge-2026-06.sql](../../supabase/data-purge-2026-06.sql) in one verified transaction (back up → assert KEEP tables unchanged + health tables zero → commit). Verified afterward: 155 conversations / 540 messages preserved, all 11 health tables at 0, production chat answers end-to-end. The HIPAA audit-log table exists as a stub but its custodial purpose is gone — the user's own append-only file is now their record.
