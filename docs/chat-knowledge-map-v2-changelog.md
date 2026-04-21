# Chat Knowledge Map v2 — Changelog

Tracks significant changes to the chatbot system after v2 shipped: system prompt rules, router behaviour, platform extensions, and integrity fixes. Most recent entry first.

---

## 2026-04-22 — Anti-hallucination hardening

**Files:** `app/lib/chat-system-prompt.md`

**What changed:**
The "Clinical integrity" section now leads with an explicit "I don't know" principle, and the citation fallback rule was replaced.

*Before:* If no citation was available for a numeric claim, the LLM was told to "soften the claim" (e.g. change "reduces by 17 minutes" to "may reduce"). This left the claim in the response with weaker language, but still permitted the LLM to fabricate a supporting URL to back it up.

*After:*
- New leading rule: **"When in doubt, say 'I don't know.'"** A confident wrong answer is more harmful than admitting uncertainty. Never guess, invent, or extrapolate.
- Citation fallback: If no verbatim URL exists in the provided context, **remove the number entirely** or say "I don't have a citation for that." Explicitly: never fabricate DOIs, PubMed URLs, paper titles, or author names.

**Why:** A live Discord conversation exposed the bot including a real-but-irrelevant PubMed link ("Zinc interaction with struvite") in a response about the cholesterol paradox. The kidney stones pathway (which mentions struvite) had been loaded into context by the router; the LLM connected "struvite + zinc" from training memory and hallucinated a plausible-looking URL. The old "soften the claim" instruction was the proximate cause — it gave the LLM permission to keep the claim and find a citation, even if that meant inventing one.

---

## 2026-04-22 — Discord platform: suppress unprompted supplement mentions

**Files:** `app/lib/platform-chat.server.ts`

**What changed:**
Added to `DISCORD_PLATFORM_CONTEXT`: do not proactively mention or promote Dr Stanfield's supplements or products in greetings or unprompted. Only discuss them if the user asks directly.

**Why:** The bot's greeting responses were volunteering "I can help with Dr Stanfield's supplements" — appropriate for the Shopify storefront (where users are customers) but out of place on Discord (where users are there for health/science discussion, not shopping).

---

## 2026-04-22 — Discord bot: @mention in replies

**Files:** `app/lib/discord-bot.server.ts`

**What changed:**
Bot now prepends `<@userId>` to the first chunk of every reply so the recipient gets a Discord notification.

**Why:** `message.reply()` with `allowedMentions: { repliedUser: false }` was suppressing pings. Users in busy servers weren't being notified when the bot responded to their question.

---

## 2026-04-20 — Discord bot shipped

**Files:** `app/lib/discord-bot.server.ts` (new), `app/lib/platform-chat.server.ts` (new), `app/lib/chat.server.ts`, `app/routes/api.chat.ts`, `app/lib/supabase.server.ts`, `app/entry.server.tsx`, `supabase/rls-policies.sql`

**What shipped:**
- Full discord.js v14 WebSocket bot running inside the Remix/Fly.io process
- Responds to all messages in `#dr-brad-ai`, @mentions anywhere in the server, and replies to prior bot messages
- Skips `@everyone` messages, Brad's own messages, and replies directed at Brad (unless bot is also @mentioned)
- Reuses the Shopify chat pipeline (`chat.server.ts` + `chat-router.server.ts`) — Anthropic prompt cache is shared across Shopify and Discord
- Platform-specific overrides live in an uncached user context block (`DISCORD_PLATFORM_CONTEXT`): no personalized health data, no Shopify account links, both SI + conventional units, 2000-char response limit
- Conversations persisted to Supabase under a shared Discord bot profile; `chat_conversations.platform = 'discord'`, real Discord user ID stored in `external_id`
- DB schema additions: `platform` + `external_id` on `chat_conversations`, `discord_message_id` on `chat_messages`, two new indexes
- `deleteAllUserData()` guards against wiping the shared Discord bot profile

**Simplify pass fixes (same session):**
- Replaced unbounded `lastResponseAt` Map with `createRateLimiter` (auto-evicting, fixes memory leak)
- Extracted `generateTitle()` to `chat.server.ts` — removed duplicate copies from `api.chat.ts` and `discord-bot.server.ts`
- `isReplyToUser` → `getRepliedToUsers()`: fetch referenced Discord message once, check both Brad's ID and bot ID against the result (was two separate fetches)
- `loadConversationForReply`: parallelised conversation metadata + history queries with `Promise.all()` after the initial message lookup

---

## 2026-04-19 — Router Phase D: routing correctness fixes

**Files:** `app/lib/chat-router.server.ts`, router prompt

**What changed:**
- Multi-handle rule: router can now return up to 3 handles per query (previously 1)
- Spelling preprocessing: common misspellings normalised before router sees the query
- Rule 5 strengthened: "Do I have X?" condition queries now reliably route to the relevant pathway
- Stale test expectations updated to match improved router behaviour

---

## 2026-04-18 — DOI citation requirement added

**Files:** `app/lib/chat-system-prompt.md`

**What changed:**
Any specific numeric claim (effect size, duration, percentage, count, sample size) must be followed by an inline markdown-link citation. Format: `([Author Year](https://doi.org/...))`. Guideline-based claims use tag format (e.g. "AHA 2018") without a URL.

**Why:** Responses were stating precise figures without sources, which is inconsistent with the evidence-first positioning. This change requires every number to be traceable.

**Note:** This rule, combined with the then-permissive fallback ("soften the claim"), was later identified as a contributing factor to the hallucinated-citation incident above. Fixed 2026-04-22.

---

## 2026-04-17 — Usage limits removed; LLM router (v2) shipped

**What changed:**
- Removed per-user chat message limits (were blocking iteration volume during testing)
- Removed 3-sessions-per-IP-per-24h guest gate
- Removed warmup endpoint (unnecessary on Anthropic Tier 2)
- LLM router (Haiku 4.5) replaced the keyword matcher — retrieval is now semantic rather than keyword-based
- 278 blog summaries rewritten for LLM retrieval
- Full TypeScript test harness added for router correctness

**Why:** The keyword matcher had hit diminishing returns on edge cases. The LLM router handles paraphrasing, synonyms, and multi-topic queries naturally without per-query tuning.
