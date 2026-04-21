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
  type GuildMember,
  type Message,
  type OmitPartialGroupDMChannel,
} from 'discord.js';
import * as Sentry from '@sentry/remix';
import { platformChatCompletion } from './platform-chat.server';
import { generateTitle } from './chat.server';
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
// Channel where the bot posts a welcome message when a new member joins.
// Typically #general. If unset, the welcome feature is disabled.
const DISCORD_GENERAL_CHANNEL_ID = process.env.DISCORD_GENERAL_CHANNEL_ID;
// Comma-separated channel IDs where the bot never responds, even if @mentioned.
const DISCORD_EXCLUDED_CHANNEL_IDS = new Set(
  (process.env.DISCORD_EXCLUDED_CHANNEL_IDS ?? '').split(',').map(s => s.trim()).filter(Boolean)
);

// ---------------------------------------------------------------------------
// Message length + rate limits
// ---------------------------------------------------------------------------

const DISCORD_MAX_MESSAGE_CHARS = 2000;     // Discord's own per-message cap
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

  // Base intents — always safe. GuildMembers is a privileged intent required
  // for GuildMemberAdd events; only request it if the welcome feature is
  // configured AND the portal toggle is enabled. Requesting it without the
  // portal toggle will prevent the bot from connecting at all.
  const intents = [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ];
  if (DISCORD_GENERAL_CHANNEL_ID && process.env.DISCORD_GUILD_MEMBERS_INTENT_ENABLED === 'true') {
    intents.push(GatewayIntentBits.GuildMembers);
  }

  client = new Client({
    intents,
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

  client.on(Events.GuildMemberAdd, (member) => {
    handleMemberJoin(member).catch((err) => {
      console.error('Discord member-join handler error:', err);
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

    let { conversationId, history } = await loadConversationForReply(message, authorId);
    if (!conversationId && message.channel.isThread()) {
      history = await loadThreadHistory(message, clientUserId);
    }

    const truncatedInput = strippedContent.slice(0, DISCORD_MAX_MESSAGE_CHARS);

    const result = await platformChatCompletion({
      message: truncatedInput,
      history,
    });

    if (typingInterval) {
      clearInterval(typingInterval);
      typingInterval = null;
    }

    // Send the response (may need to split across multiple Discord messages)
    const chunks = splitForDiscord(result.content, DISCORD_MAX_MESSAGE_CHARS);
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
      router: result.router,
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
// Member-join welcome message
// ---------------------------------------------------------------------------

async function handleMemberJoin(member: GuildMember): Promise<void> {
  if (member.user.bot) return;
  if (member.guild.id !== DISCORD_GUILD_ID) return;
  if (!DISCORD_GENERAL_CHANNEL_ID) return;   // welcome feature disabled

  const channel = await member.guild.channels.fetch(DISCORD_GENERAL_CHANNEL_ID).catch(() => null);
  if (!channel || !channel.isTextBased() || !('send' in channel)) return;

  const botMention = client?.user ? `<@${client.user.id}>` : 'Dr Brad AI';
  const aiChannelMention = DISCORD_DEDICATED_AI_CHANNEL_ID
    ? `<#${DISCORD_DEDICATED_AI_CHANNEL_ID}>`
    : 'the Dr Brad AI channel';

  const welcome = [
    `Welcome, <@${member.id}>! 👋`,
    '',
    `Great to have you in **Dr Brad Stanfield's** Discord. A few quick things:`,
    '',
    `• **Dr Brad** is active here — he reads and replies to messages across the server.`,
    `• **Dr Brad's AI assistant** (${botMention}) is available in ${aiChannelMention} for evidence-based answers on diet, exercise, sleep, blood tests, cholesterol, supplements, and health conditions. You can also @mention it in any channel.`,
    `• Browse the channel list on the left — each channel covers a specific topic (cholesterol, blood-tests, sleep, etc).`,
    '',
    `For personalized suggestions based on your own numbers, try the Health Roadmap tool at **drstanfield.com**.`,
    '',
    `*This server provides educational information only, not personalized medical advice. Always discuss changes with your healthcare provider.*`,
  ].join('\n');

  try {
    await channel.send({
      content: welcome,
      allowedMentions: { users: [member.id] },
    });
  } catch (err) {
    console.error('Discord welcome send failed:', err);
    Sentry.captureException(err, {
      tags: { platform: PLATFORM_DISCORD, subsystem: 'welcome' },
      extra: { userId: member.id, guildId: member.guild.id },
    });
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

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
  history: Array<{ role: 'user' | 'assistant'; content: string }>;
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
  const conversationId = refMsg.conversation_id;
  const [convResult, histResult] = await Promise.all([
    supabaseAdmin
      .from('chat_conversations')
      .select('platform, external_id')
      .eq('id', conversationId)
      .maybeSingle(),
    supabaseAdmin
      .from('chat_messages')
      .select('role, content, created_at')
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
    .map(r => ({ role: r.role as 'user' | 'assistant', content: r.content as string }));

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
  if (!message.channel.isThread()) return [];

  const fetched = await message.channel.messages.fetch({
    limit: HISTORY_MSG_LIMIT,
    before: message.id,
  });

  return [...fetched.values()]
    .sort((a, b) => a.createdTimestamp - b.createdTimestamp)  // oldest first
    .filter(m => !m.author.bot || m.author.id === botUserId)  // skip other bots
    .filter(m => (m.content ?? '').length > 0)                // skip attachment-only
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
  router: {
    handles: string[];
    latencyMs: number;
    cacheHit: boolean;
    inputTokens: number;
    cacheReadTokens: number;
    error: string | null;
    rawJson: string | null;
    version: number;
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
    });
  if (asstErr) {
    Sentry.captureException(new Error('Discord: failed to save assistant message'), {
      tags: { platform: PLATFORM_DISCORD },
      extra: { dbError: asstErr.message, conversationId },
    });
    return;
  }

  // Router event (analytics / QA). FK on message_id requires the assistant row to exist.
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
      matched_handles: p.router.handles,
      router_version: p.router.version,
      router_latency_ms: p.router.latencyMs,
      router_cache_hit: p.router.cacheHit,
      router_input_tokens: p.router.inputTokens,
      router_cache_read_tokens: p.router.cacheReadTokens,
      router_raw: p.router.error ? (p.router.rawJson?.slice(0, 500) ?? null) : null,
      router_error: p.router.error,
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
