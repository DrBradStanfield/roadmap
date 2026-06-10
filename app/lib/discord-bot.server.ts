/**
 * Discord bot — reuses the Health Roadmap chat pipeline to answer questions in
 * Brad's Discord server.
 *
 * Auto-starts on module import (same pattern as reminder-cron.server.ts).
 * Gated by `DISCORD_BOT_TOKEN` AND (`FLY_APP_NAME` OR `DISCORD_FORCE_START=true`).
 * The `FLY_APP_NAME` gate prevents Remix dev hot-reloads from spawning duplicate
 * WebSocket connections during `npm run dev`.
 */
import {
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  type Message,
  type OmitPartialGroupDMChannel,
} from 'discord.js';
import * as Sentry from '@sentry/remix';
import { platformChatCompletion } from './platform-chat.server';
import { findDuplicateReply } from './chat-dedup.server';
import { sleep } from './cron-helpers.server';
import { reportChatFallback } from './chat.server';
import { generateTitle } from './chat.server';
import { ROUTER_VERSION, type RouterResult } from './chat-router.server';
import { supabaseAdmin } from './supabase.server';
import { createRateLimiter } from './rate-limiter';

// ---------------------------------------------------------------------------
// Config from env
// ---------------------------------------------------------------------------

const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
// "Server ID" in Discord UI = "Guild ID" in Discord API. Same thing.
const DISCORD_GUILD_ID = process.env.DISCORD_SERVER_ID;
const DISCORD_BRAD_USER_ID = process.env.DISCORD_DrBradStanfield_USER_ID;
const DISCORD_BOT_PROFILE_ID = process.env.DISCORD_BOT_PROFILE_ID;
// Bot auto-responds in this channel to any user message. Elsewhere it only
// responds to explicit @mentions. Threads under the dedicated channel inherit
// the opt-in behaviour.
const DISCORD_DEDICATED_AI_CHANNEL_ID = process.env.DISCORD_DEDICATED_AI_CHANNEL_ID;
// Comma-separated channel IDs where the bot never responds, even if @mentioned.
const DISCORD_EXCLUDED_CHANNEL_IDS = new Set(
  (process.env.DISCORD_EXCLUDED_CHANNEL_IDS ?? '').split(',').map(s => s.trim()).filter(Boolean)
);

// ---------------------------------------------------------------------------
// Message length + rate limits
// ---------------------------------------------------------------------------

const DISCORD_MAX_MESSAGE_CHARS = 2000;     // Discord's own per-message cap
// Used when splitting our outgoing reply. Discord's hard cap is 2000, but the
// first chunk is sent via message.reply() with `<@userId> ${chunk}` prepended,
// which adds ~22 chars for the mention. Using 1950 leaves a safe 50-char buffer
// so the mention prefix can never push the final payload over 2000 (DiscordAPIError[50035]).
const DISCORD_SPLIT_CHARS = 1950;
const USER_RATE_LIMIT_MAX = 10;              // 10 msgs per user per hour
const USER_RATE_LIMIT_WINDOW_MS = 60 * 60_000;
const USER_RATE_LIMIT_CLEANUP_MS = 15 * 60_000;
const USER_COOLDOWN_MS = 3_000;              // 3s minimum between responses to one user
const CONCURRENCY_LIMIT = 3;                 // max concurrent LLM calls
const QUEUE_MAX_DEPTH = 10;                  // beyond this, reject with friendly message
const HISTORY_MSG_LIMIT = 20;                // cap per-conversation history sent to LLM
const PLATFORM_SHOPIFY = 'shopify';
const PLATFORM_DISCORD = 'discord';

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let client: Client | null = null;
let isRunning = false;
let activeLlmCalls = 0;
const checkUserRateLimit = createRateLimiter(
  USER_RATE_LIMIT_MAX,
  USER_RATE_LIMIT_WINDOW_MS,
  USER_RATE_LIMIT_CLEANUP_MS,
);
// Per-user cooldown: at most 1 response per USER_COOLDOWN_MS. Reuses the
// rate limiter factory so stale entries auto-evict — avoids an unbounded Map.
const checkUserCooldown = createRateLimiter(1, USER_COOLDOWN_MS, 5 * 60_000);

// ---------------------------------------------------------------------------
// Startup / shutdown
// ---------------------------------------------------------------------------

export function startDiscordBot(): void {
  if (isRunning) {
    console.log('Discord bot already running — skip start');
    return;
  }

  if (!DISCORD_BOT_TOKEN) {
    console.log('Discord bot: DISCORD_BOT_TOKEN not set — bot disabled');
    return;
  }

  // Block auto-start during local `npm run dev` hot-reloads (would spawn dupe
  // WebSocket connections). Developers can force-start with DISCORD_FORCE_START=true.
  if (!process.env.FLY_APP_NAME && process.env.DISCORD_FORCE_START !== 'true') {
    console.log('Discord bot: not on Fly.io and DISCORD_FORCE_START != "true" — skipping');
    return;
  }

  if (!DISCORD_GUILD_ID) {
    console.warn('Discord bot: DISCORD_GUILD_ID not set — bot disabled');
    return;
  }

  if (!DISCORD_BOT_PROFILE_ID) {
    console.warn('Discord bot: DISCORD_BOT_PROFILE_ID not set — bot disabled (run the manual Supabase setup step)');
    return;
  }

  if (!supabaseAdmin) {
    console.warn('Discord bot: supabaseAdmin not configured — bot disabled');
    return;
  }

  client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
    partials: [Partials.Message, Partials.Channel],
  });

  client.once(Events.ClientReady, (c) => {
    console.log(`Discord bot ready as ${c.user.tag}`);
  });

  client.on(Events.MessageCreate, (message) => {
    handleMessage(message).catch((err) => {
      console.error('Discord message handler error:', err);
      Sentry.captureException(err, { tags: { platform: PLATFORM_DISCORD } });
    });
  });

  client.on(Events.Error, (err) => {
    console.error('Discord client error:', err);
    Sentry.captureException(err, { tags: { platform: PLATFORM_DISCORD } });
  });

  client.login(DISCORD_BOT_TOKEN).catch((err) => {
    console.error('Discord login failed:', err);
    Sentry.captureException(err, { tags: { platform: PLATFORM_DISCORD } });
    client = null;
    isRunning = false;
  });

  isRunning = true;
}

export function stopDiscordBot(): void {
  if (!client) return;
  try {
    client.destroy();
    console.log('Discord bot stopped');
  } catch (err) {
    console.error('Discord destroy error:', err);
  }
  client = null;
  isRunning = false;
}

// ---------------------------------------------------------------------------
// Message handler
// ---------------------------------------------------------------------------

type GuildMessage = OmitPartialGroupDMChannel<Message<boolean>>;

async function handleMessage(message: GuildMessage): Promise<void> {
  // ----- Early exits (cheap, fall through as quickly as possible) -----
  if (message.author.bot) return;
  if (message.guild?.id !== DISCORD_GUILD_ID) return;   // DMs (null guild) and other servers
  if (message.system) return;                            // system / join messages
  if (message.mentions.everyone) return;                 // @everyone / @here — server-wide broadcasts, never meant for the bot
  if (DISCORD_EXCLUDED_CHANNEL_IDS.has(message.channelId)) return; // explicitly blocked channels

  const content = message.content?.trim() ?? '';
  if (!content) return;                                  // attachment-only, stickers, etc.

  const clientUserId = client?.user?.id;
  if (!clientUserId) return;

  const isBotMentioned = message.mentions.users.has(clientUserId);
  const isBradMentioned = DISCORD_BRAD_USER_ID
    ? message.mentions.users.has(DISCORD_BRAD_USER_ID)
    : false;

  // ----- Determine whether the bot should respond -----
  //
  //   Dedicated channel + any user message             → respond
  //   Bot @mentioned anywhere                          → respond
  //   Reply to bot's own message (anywhere)            → respond (conversation continuation)
  //   Brad's message / reply-to-Brad / mentioning Brad → do NOT respond unless bot is @mentioned
  //
  // Order matters: Brad-exclusions win over other triggers (bot stays out of
  // conversations with Brad), but if the bot is explicitly @mentioned, respond.
  const isBradAuthor = DISCORD_BRAD_USER_ID
    ? message.author.id === DISCORD_BRAD_USER_ID
    : false;
  const repliedTo = await getRepliedToUsers(message, [DISCORD_BRAD_USER_ID, clientUserId]);
  const isReplyToBrad = DISCORD_BRAD_USER_ID ? repliedTo.has(DISCORD_BRAD_USER_ID) : false;
  const isReplyToBot = repliedTo.has(clientUserId);

  if (isBradMentioned && !isBotMentioned) return;
  if (isReplyToBrad && !isBotMentioned) return;
  if (isBradAuthor && !isBotMentioned) return;

  // Allowlist: auto-respond in the dedicated AI channel (and its threads),
  // on @mention, or on a reply to the bot's own message. Otherwise skip.
  const channel = message.channel;
  const parentIdIfThread = 'parentId' in channel ? channel.parentId : null;
  const isDedicatedChannel =
    DISCORD_DEDICATED_AI_CHANNEL_ID != null &&
    (message.channelId === DISCORD_DEDICATED_AI_CHANNEL_ID ||
      parentIdIfThread === DISCORD_DEDICATED_AI_CHANNEL_ID);
  if (!isDedicatedChannel && !isBotMentioned && !isReplyToBot) return;

  // ----- Rate limits -----
  const authorId = message.author.id;
  if (!checkUserCooldown(authorId)) return;              // silently ignore flooding (< 3s since last reply)

  if (!checkUserRateLimit(authorId)) {
    await safeReply(message, 'You are sending messages a bit quickly — try again in a few minutes.');
    return;
  }

  // ----- Concurrency gate -----
  if (activeLlmCalls >= CONCURRENCY_LIMIT + QUEUE_MAX_DEPTH) {
    await safeReply(message, 'Busy helping other people right now — try again in a moment.');
    return;
  }
  while (activeLlmCalls >= CONCURRENCY_LIMIT) {
    await sleep(200);
  }

  // ----- Load conversation history if this is a reply to the bot -----
  activeLlmCalls++;
  let typingInterval: NodeJS.Timeout | null = null;

  try {
    const strippedContent = stripBotMention(content, clientUserId);
    if (!strippedContent) return;

    // Discord typing indicator lasts 10s — refresh it during long LLM calls
    try {
      if (message.channel.isTextBased() && 'sendTyping' in message.channel) {
        await message.channel.sendTyping();
        typingInterval = setInterval(() => {
          if (message.channel.isTextBased() && 'sendTyping' in message.channel) {
            message.channel.sendTyping().catch(() => { /* ignore transient errors */ });
          }
        }, 8_000);
      }
    } catch { /* best-effort typing indicator */ }

    const truncatedInput = strippedContent.slice(0, DISCORD_MAX_MESSAGE_CHARS);

    const dbResult = await loadConversationForReply(message, authorId);
    const conversationId = dbResult.conversationId;

    // Dedup check (shared with web — app/lib/chat-dedup.server.ts). Only when we have
    // DB-backed conversation history with timestamps + is_fallback flag. Re-serves the
    // previous bot reply via Discord without re-running classifier/router/main LLM.
    if (conversationId) {
      const dup = findDuplicateReply(dbResult.history, truncatedInput);
      if (dup) {
        Sentry.captureMessage('chat: duplicate user message detected, re-serving previous reply', {
          level: 'info',
          tags: { feature: 'chat', platform: PLATFORM_DISCORD, diagnostic: 'dedup' },
          extra: {
            conversationId,
            authorDiscordId: authorId,
            ageMs: dup.ageMs,
            messageLength: truncatedInput.length,
          },
        });
        if (typingInterval) {
          clearInterval(typingInterval);
          typingInterval = null;
        }
        const dupChunks = splitForDiscord(dup.content, DISCORD_SPLIT_CHARS);
        let dupFirst = true;
        for (const chunk of dupChunks) {
          try {
            if (dupFirst) {
              await message.reply({ content: `<@${message.author.id}> ${chunk}`, allowedMentions: { repliedUser: false, users: [message.author.id] } });
            } else if (message.channel.isTextBased() && 'send' in message.channel) {
              await message.channel.send({ content: chunk, allowedMentions: { parse: [] } });
            }
          } catch (sendErr) {
            console.error('Discord: dedup re-send failed:', sendErr);
          }
          dupFirst = false;
        }
        return;
      }
    }

    // Narrow history to what the LLM call needs (role+content). When there's no
    // DB-backed reply chain but the message is in a thread, fall back to Discord-API
    // thread history (no dedup possible there — no is_fallback / created_at).
    const history: Array<{ role: 'user' | 'assistant'; content: string }> = conversationId
      ? dbResult.history.map(h => ({ role: h.role, content: h.content }))
      : (message.channel.isThread() ? await loadThreadHistory(message, clientUserId) : []);

    const tBeforeLlm = Date.now();
    const result = await platformChatCompletion({
      message: truncatedInput,
      history,
    });
    const tAfterLlm = Date.now();

    // Fire the shared fallback reporter (no-op when result.isFallback is false).
    // Without this, Discord fallbacks would silently miss Sentry alerts — the
    // shopify path covers itself in api.chat.ts via the same helper.
    reportChatFallback({
      completion: result,
      platform: 'discord',
      conversationId: conversationId ?? null,
      messagePreview: truncatedInput,
      latencyMs: tAfterLlm - tBeforeLlm,
      matchedHandles: result.routerResult?.handles ?? [],
      authorTag: message.author.tag,
    });

    if (typingInterval) {
      clearInterval(typingInterval);
      typingInterval = null;
    }

    // Send the response (may need to split across multiple Discord messages).
    // Split at DISCORD_SPLIT_CHARS (1950), not the 2000 hard cap — the first
    // chunk is sent via message.reply() with `<@userId> ` prepended, which adds
    // ~22 chars. Splitting at 2000 exactly caused Discord to reject the first
    // chunk with DiscordAPIError[50035] "content[BASE_TYPE_MAX_LENGTH]".
    const chunks = splitForDiscord(result.content, DISCORD_SPLIT_CHARS);
    const sentMessages: Message[] = [];
    let firstChunk = true;
    for (const chunk of chunks) {
      const sent = firstChunk
        ? await message.reply({ content: `<@${message.author.id}> ${chunk}`, allowedMentions: { repliedUser: false, users: [message.author.id] } })
        : (message.channel.isTextBased() && 'send' in message.channel
            ? await message.channel.send({ content: chunk, allowedMentions: { parse: [] } })
            : null);
      if (sent) sentMessages.push(sent);
      firstChunk = false;
    }

    // Fire-and-forget: persist the conversation and the router event.
    // All DB errors go to Sentry but never block the Discord response.
    persistConversation({
      conversationId,
      authorId,
      authorTag: message.author.tag,
      userMessage: truncatedInput,
      userDiscordMessageId: message.id,
      assistantContent: result.content,
      assistantDiscordMessageIds: sentMessages.map(m => m.id),
      usage: result.usage,
      isFallback: result.isFallback,
      failureMode: result.failureMode,
      errorDetail: result.errorDetail,
      routerResult: result.routerResult,
      classifier: {
        classification: result.classifier.classification,
        routerSkipped: result.classifier.routerSkipped,
      },
      contextFirst: history.find(m => m.role === 'user')?.content,
      contextRecent: history.filter(m => m.role === 'user').slice(-3).map(m => m.content),
    }).catch((err) => {
      console.error('Discord: persistConversation failed:', err);
      Sentry.captureException(err, {
        tags: { platform: PLATFORM_DISCORD, subsystem: 'persist' },
      });
    });
  } catch (err) {
    if (typingInterval) clearInterval(typingInterval);
    console.error('Discord handleMessage error:', err);
    Sentry.captureException(err, { tags: { platform: PLATFORM_DISCORD } });
    await safeReply(message, 'Something went wrong on my end — please try again in a moment.');
  } finally {
    activeLlmCalls--;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function safeReply(message: GuildMessage, text: string): Promise<void> {
  try {
    await message.reply({ content: text, allowedMentions: { repliedUser: false } });
  } catch { /* swallow — we don't want reply errors to re-enter Sentry loop */ }
}

/**
 * If `message` is a reply, fetch the referenced message once and return which of
 * `userIds` authored it. Single Discord API call regardless of how many IDs are
 * checked. Returns an empty Set if the message isn't a reply or the parent is
 * unreachable.
 */
async function getRepliedToUsers(
  message: GuildMessage,
  userIds: readonly (string | undefined)[],
): Promise<Set<string>> {
  const result = new Set<string>();
  const refId = message.reference?.messageId;
  if (!refId) return result;
  try {
    const referenced = await message.channel.messages.fetch(refId);
    const authorId = referenced.author.id;
    for (const id of userIds) {
      if (id && id === authorId) result.add(id);
    }
  } catch {
    // Reference deleted or unreachable — return empty set
  }
  return result;
}

/**
 * Remove all occurrences of `<@userId>` / `<@!userId>` from a message body so
 * the LLM doesn't have to deal with raw mention tokens.
 */
function stripBotMention(content: string, botUserId: string): string {
  return content
    .replace(new RegExp(`<@!?${botUserId}>`, 'g'), '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * If the message is a reply to one of the bot's previous messages, look up the
 * referenced bot message in Supabase by `discord_message_id`, then load the
 * conversation history. Falls back to a new conversation in any edge case
 * (reply to non-bot, missing row, different Discord author than conversation).
 */
async function loadConversationForReply(
  message: GuildMessage,
  authorDiscordId: string,
): Promise<{
  conversationId: string | null;
  history: Array<{ role: 'user' | 'assistant'; content: string; created_at: string; is_fallback: boolean | null }>;
}> {
  if (!supabaseAdmin) return { conversationId: null, history: [] };

  const refId = message.reference?.messageId;
  if (!refId) return { conversationId: null, history: [] };

  const { data: refMsg, error: refErr } = await supabaseAdmin
    .from('chat_messages')
    .select('id, conversation_id')
    .eq('discord_message_id', refId)
    .maybeSingle();

  if (refErr) {
    console.warn('Discord: failed to look up reply-parent message:', refErr.message);
    return { conversationId: null, history: [] };
  }
  if (!refMsg?.conversation_id) return { conversationId: null, history: [] };

  // Fetch conversation metadata and message history in parallel — neither
  // depends on the other, both only need refMsg.conversation_id from above.
  // created_at + is_fallback are needed for the shared content-based dedup check
  // (chat-dedup.server.ts findDuplicateReply); downstream LLM code only uses role+content.
  const conversationId = refMsg.conversation_id;
  const [convResult, histResult] = await Promise.all([
    supabaseAdmin
      .from('chat_conversations')
      .select('platform, external_id')
      .eq('id', conversationId)
      .maybeSingle(),
    supabaseAdmin
      .from('chat_messages')
      .select('role, content, created_at, is_fallback')
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: true })
      .limit(HISTORY_MSG_LIMIT),
  ]);

  // Verify conversation belongs to the same Discord user. If not, start fresh —
  // inheriting someone else's history would send the wrong context to the LLM.
  const conv = convResult.data;
  if (convResult.error || !conv) return { conversationId: null, history: [] };
  if (conv.platform !== PLATFORM_DISCORD) return { conversationId: null, history: [] };
  if (conv.external_id !== authorDiscordId) return { conversationId: null, history: [] };

  if (histResult.error || !histResult.data) {
    console.warn('Discord: failed to load conversation history:', histResult.error?.message);
    return { conversationId, history: [] };
  }

  const history = histResult.data
    .filter(r => r.role === 'user' || r.role === 'assistant')
    .map(r => ({
      role: r.role as 'user' | 'assistant',
      content: r.content as string,
      created_at: r.created_at as string,
      is_fallback: r.is_fallback as boolean | null,
    }));

  return { conversationId, history };
}

/**
 * When a message arrives inside a thread (but is not an explicit reply to the
 * bot), load the last HISTORY_MSG_LIMIT messages from that thread via the
 * Discord API. The thread channel IS the conversation, so this gives full
 * back-and-forth context without needing a Supabase lookup.
 */
async function loadThreadHistory(
  message: GuildMessage,
  botUserId: string,
): Promise<Array<{ role: 'user' | 'assistant'; content: string }>> {
  const fetched = await message.channel.messages.fetch({
    limit: HISTORY_MSG_LIMIT,
    before: message.id,
  });

  return [...fetched.values()]
    .sort((a, b) => a.createdTimestamp - b.createdTimestamp)
    .filter(m => !m.author.bot || m.author.id === botUserId)
    .filter(m => m.content.length > 0)
    .map(m => ({
      role: (m.author.id === botUserId ? 'assistant' : 'user') as 'user' | 'assistant',
      content: m.content,
    }));
}

/**
 * Split an LLM response across multiple Discord messages so each is ≤ `max` chars.
 * Prefers paragraph boundaries, then sentences, then words, and only falls back
 * to hard character cuts when all else fails.
 */
export function splitForDiscord(content: string, max: number): string[] {
  if (content.length <= max) return [content];

  const chunks: string[] = [];
  let remaining = content;

  while (remaining.length > max) {
    const slice = remaining.slice(0, max);

    // Prefer paragraph > sentence > word boundary, in that order
    let cut = slice.lastIndexOf('\n\n');
    if (cut < max * 0.4) {
      const sentenceCut = Math.max(slice.lastIndexOf('. '), slice.lastIndexOf('! '), slice.lastIndexOf('? '));
      if (sentenceCut > max * 0.4) cut = sentenceCut + 1;
    }
    if (cut < max * 0.4) {
      const spaceCut = slice.lastIndexOf(' ');
      if (spaceCut > max * 0.4) cut = spaceCut;
    }
    if (cut < max * 0.4) cut = max;   // hard cut; response was pathologically long

    chunks.push(remaining.slice(0, cut).trimEnd());
    remaining = remaining.slice(cut).trimStart();
  }
  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}

// ---------------------------------------------------------------------------
// Persistence — writes the user message, assistant response, and router event
// to the same tables the Shopify chat uses, tagged with platform='discord' and
// external_id=<Discord user ID>. Uses the shared Discord bot profile for user_id.
// ---------------------------------------------------------------------------

interface PersistParams {
  conversationId: string | null;
  authorId: string;
  authorTag: string;
  userMessage: string;
  userDiscordMessageId: string;
  assistantContent: string;
  assistantDiscordMessageIds: string[];
  usage: { inputTokens: number; outputTokens: number; cacheCreationTokens: number; cacheReadTokens: number };
  isFallback: boolean;
  /** Fallback cause + raw error, mirrored to chat_messages for the audit email. */
  failureMode?: string;
  errorDetail?: string;
  /** Router-call result. null when classifier said SKIP — router never ran. */
  routerResult: RouterResult | null;
  classifier: {
    classification: string;
    routerSkipped: boolean;
  };
  contextFirst?: string;
  contextRecent: string[];
}

const CHAT_MODEL_TAG = 'claude-haiku-4-5-20251001';

async function persistConversation(p: PersistParams): Promise<void> {
  if (!supabaseAdmin || !DISCORD_BOT_PROFILE_ID) return;

  let conversationId = p.conversationId;

  if (!conversationId) {
    const title = generateTitle(p.userMessage);
    const { data: conv, error: convErr } = await supabaseAdmin
      .from('chat_conversations')
      .insert({
        user_id: DISCORD_BOT_PROFILE_ID,
        title,
        platform: PLATFORM_DISCORD,
        external_id: p.authorId,
      })
      .select('id')
      .single();
    if (convErr || !conv) {
      Sentry.captureException(new Error('Discord: failed to create conversation'), {
        tags: { platform: PLATFORM_DISCORD },
        extra: { dbError: convErr?.message, discordUser: p.authorTag },
      });
      return;
    }
    conversationId = conv.id;
  }

  // User message first (keeps chronological order when reading the thread back)
  const { error: userErr } = await supabaseAdmin
    .from('chat_messages')
    .insert({
      conversation_id: conversationId,
      user_id: DISCORD_BOT_PROFILE_ID,
      role: 'user',
      content: p.userMessage,
      discord_message_id: p.userDiscordMessageId,
    });
  if (userErr) {
    Sentry.captureException(new Error('Discord: failed to save user message'), {
      tags: { platform: PLATFORM_DISCORD },
      extra: { dbError: userErr.message, conversationId },
    });
    // Continue — assistant message + match event are still useful for analytics
  }

  // Save the assistant message. We reuse the first Discord-sent message ID so
  // replies to that message can find this conversation via discord_message_id.
  const firstSentId = p.assistantDiscordMessageIds[0] ?? null;
  const assistantMessageId = crypto.randomUUID();
  const { error: asstErr } = await supabaseAdmin
    .from('chat_messages')
    .insert({
      id: assistantMessageId,
      conversation_id: conversationId,
      user_id: DISCORD_BOT_PROFILE_ID,
      role: 'assistant',
      content: p.assistantContent,
      input_tokens: p.usage.inputTokens,
      output_tokens: p.usage.outputTokens,
      model: CHAT_MODEL_TAG,
      discord_message_id: firstSentId,
      is_fallback: p.isFallback,
      failure_mode: p.failureMode ?? null,
      error_detail: p.errorDetail?.slice(0, 500) ?? null,
    });
  if (asstErr) {
    Sentry.captureException(new Error('Discord: failed to save assistant message'), {
      tags: { platform: PLATFORM_DISCORD },
      extra: { dbError: asstErr.message, conversationId },
    });
    return;
  }

  // Router event (analytics / QA). FK on message_id requires the assistant row to exist.
  // All router_* metric columns are null on SKIP turns (router never ran).
  const r = p.routerResult;
  const { error: evtErr } = await supabaseAdmin
    .from('chat_match_events')
    .insert({
      message_id: assistantMessageId,
      conversation_id: conversationId,
      user_id: DISCORD_BOT_PROFILE_ID,
      message: p.userMessage,
      router_context: {
        platform: PLATFORM_DISCORD,
        first: p.contextFirst ?? null,
        recent: p.contextRecent,
      },
      matched_handles: r?.handles ?? [],
      router_version: r ? ROUTER_VERSION : null,
      router_latency_ms: r?.latencyMs ?? null,
      router_cache_hit: r?.cacheHit ?? null,
      router_input_tokens: r?.usage.inputTokens ?? null,
      router_cache_read_tokens: r?.usage.cacheReadTokens ?? null,
      router_raw: r?.error ? (r.rawJson?.slice(0, 500) ?? null) : null,
      router_error: r?.error ?? null,
      classification: p.classifier.classification,
      router_skipped: p.classifier.routerSkipped,
    });
  if (evtErr) {
    Sentry.captureException(new Error('Discord: match-event insert failed'), {
      tags: { platform: PLATFORM_DISCORD },
      extra: { dbError: evtErr.message, messageId: assistantMessageId },
    });
  }

  // Touch the conversation timestamp so the list is ordered by recency.
  await supabaseAdmin
    .from('chat_conversations')
    .update({ updated_at: new Date().toISOString() })
    .eq('id', conversationId);
}

// Auto-start on module import (same pattern as reminder-cron.server.ts)
startDiscordBot();
