/**
 * Discord bot — reuses the Health Roadmap chat pipeline to answer questions in
 * Brad's Discord server.
 *
 * Auto-starts on module import (same pattern as reminder-v2-cron.server.ts).
 * Gated by `DISCORD_BOT_TOKEN` AND (`FLY_APP_NAME` OR `DISCORD_FORCE_START=true`).
 * The `FLY_APP_NAME` gate prevents Remix dev hot-reloads from spawning duplicate
 * WebSocket connections during `npm run dev`.
 *
 * Split by concern (issue #429): discord-bot-config.server.ts (env, limits),
 * discord-bot-messages.server.ts (channel exclusion, replies, splitting),
 * discord-bot-history.server.ts (stored and thread history) and
 * discord-bot-persist.server.ts (chat-table writes). This file keeps the
 * start/stop and the message handler, and re-exports every name it exported
 * before the split.
 */
import {
  Client,
  Events,
  GatewayIntentBits,
  Partials,
} from 'discord.js';
import * as Sentry from '@sentry/react-router';
import { platformChatCompletion } from './platform-chat.server';
import { findDuplicateReply } from './chat-dedup.server';
import { sleep } from './cron-helpers.server';
import { reportChatFallback } from './chat.server';
import { cutText } from '../../packages/health-core/src/chat-history';
import { supabaseAdmin } from './supabase.server';
import { createRateLimiter } from './rate-limiter';
import {
  DISCORD_BOT_TOKEN,
  DISCORD_GUILD_ID,
  DISCORD_BRAD_USER_ID,
  DISCORD_BOT_PROFILE_ID,
  DISCORD_DEDICATED_AI_CHANNEL_ID,
  DISCORD_MAX_MESSAGE_CHARS,
  DISCORD_SPLIT_CHARS,
  USER_RATE_LIMIT_MAX,
  USER_RATE_LIMIT_WINDOW_MS,
  USER_RATE_LIMIT_CLEANUP_MS,
  USER_COOLDOWN_MS,
  CONCURRENCY_LIMIT,
  QUEUE_MAX_DEPTH,
  PLATFORM_DISCORD,
} from './discord-bot-config.server';
import {
  type GuildMessage,
  isExcludedChannel,
  errorKind,
  safeReply,
  getRepliedToUsers,
  stripBotMention,
  splitForDiscord,
} from './discord-bot-messages.server';
import {
  loadConversationForReply,
  loadRecentConversation,
  loadThreadHistory,
} from './discord-bot-history.server';
import { persistConversation } from './discord-bot-persist.server';
import { sendAnswer } from './discord-bot-send.server';
import { safeErrorFields } from './safe-error-fields.server';

export { splitForDiscord } from './discord-bot-messages.server';
export { persistConversation } from './discord-bot-persist.server';

const ERROR_REPLY = 'Something went wrong on my end. Please try again in a moment.';

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let client: Client | null = null;
let isRunning = false;
let activeLlmCalls = 0;
let waitingLlmCalls = 0;
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
      console.error('Discord message handler error:', safeErrorFields(err));
      Sentry.captureException(err, { tags: { platform: PLATFORM_DISCORD } });
    });
  });

  client.on(Events.Error, (err) => {
    console.error('Discord client error:', safeErrorFields(err));
    Sentry.captureException(err, { tags: { platform: PLATFORM_DISCORD } });
  });

  client.login(DISCORD_BOT_TOKEN).catch((err) => {
    console.error('Discord login failed:', safeErrorFields(err));
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
    console.error('Discord destroy error:', safeErrorFields(err));
  }
  client = null;
  isRunning = false;
}

// ---------------------------------------------------------------------------
// Message handler
// ---------------------------------------------------------------------------

async function handleMessage(message: GuildMessage): Promise<void> {
  // ----- Early exits (cheap, fall through as quickly as possible) -----
  if (message.author.bot) return;
  if (message.guild?.id !== DISCORD_GUILD_ID) return;   // DMs (null guild) and other servers
  if (message.system) return;                            // system / join messages
  if (message.mentions.everyone) return;                 // @everyone / @here — server-wide broadcasts, never meant for the bot
  if (isExcludedChannel(message)) return;                // explicitly blocked channels and their threads

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
    await safeReply(message, 'You are sending messages a bit quickly. Try again in a few minutes.');
    return;
  }

  // ----- Concurrency gate -----
  if (activeLlmCalls >= CONCURRENCY_LIMIT) {
    if (waitingLlmCalls >= QUEUE_MAX_DEPTH) {
      await safeReply(message, 'Busy helping other people right now. Try again in a moment.');
      return;
    }
    waitingLlmCalls++;
    try {
      while (activeLlmCalls >= CONCURRENCY_LIMIT) {
        await sleep(200);
      }
    } finally {
      waitingLlmCalls--;
    }
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

    const truncatedInput = cutText(strippedContent, DISCORD_MAX_MESSAGE_CHARS);

    // Explicit reply chain wins. Otherwise, outside a thread (threads carry their
    // own history via loadThreadHistory), continue this user's recent conversation
    // so channel follow-ups aren't each answered from scratch.
    let dbResult = await loadConversationForReply(message, authorId);
    if (!dbResult.conversationId && !message.channel.isThread()) {
      dbResult = await loadRecentConversation(authorId);
    }
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
            ageMs: dup.ageMs,
            messageLength: truncatedInput.length,
          },
        });
        if (typingInterval) {
          clearInterval(typingInterval);
          typingInterval = null;
        }
        await sendAnswer(message, splitForDiscord(dup.content, DISCORD_SPLIT_CHARS));
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
      latencyMs: tAfterLlm - tBeforeLlm,
      conversationId: conversationId ?? null,
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
    // US-15 AC48: a silent (SPAM) turn sends nothing; below, only its match event is stored.
    const chunks = result.silent ? [] : splitForDiscord(result.content, DISCORD_SPLIT_CHARS);
    const sent = await sendAnswer(message, chunks);
    // US-15 AC62: nothing went out, so say so and store nothing. A partial is
    // stored as the text that went out, marked so the dedup never re-serves it.
    if (sent.kind === 'none-sent') {
      await safeReply(message, ERROR_REPLY);
      return;
    }

    // Fire-and-forget: persist the conversation and the router event.
    // All DB errors go to Sentry but never block the Discord response.
    persistConversation({
      conversationId,
      authorId,
      userMessage: truncatedInput,
      userDiscordMessageId: message.id,
      assistantContent: sent.kind === 'partial' ? sent.sent.map(c => c.text).join('\n\n') : result.content,
      silent: result.silent === true,
      assistantDiscordMessageIds: sent.sent.map(c => c.id),
      usage: result.usage,
      isFallback: result.isFallback,
      failureMode: sent.kind === 'partial' ? 'partial' : result.failureMode,
      errorDetail: result.errorDetail,
      routerResult: result.routerResult,
      replaced: result.replaced,
      reduced: result.reduced,
      classifier: {
        classification: result.classifier.classification,
        routerSkipped: result.classifier.routerSkipped,
      },
      contextFirst: history.find(m => m.role === 'user')?.content,
      contextRecent: history.filter(m => m.role === 'user').slice(-3).map(m => m.content),
    }).catch((err) => {
      console.error('Discord: persistConversation failed:', safeErrorFields(err));
      Sentry.captureException(err, {
        tags: { platform: PLATFORM_DISCORD, subsystem: 'persist' },
      });
    });
  } catch (err) {
    if (typingInterval) clearInterval(typingInterval);
    console.error('Discord handleMessage error:', errorKind(err));
    Sentry.captureException(err, { tags: { platform: PLATFORM_DISCORD } });
    await safeReply(message, ERROR_REPLY);
  } finally {
    activeLlmCalls--;
  }
}

// Auto-start on module import (same pattern as reminder-v2-cron.server.ts)
startDiscordBot();
