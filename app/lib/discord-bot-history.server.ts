/**
 * Discord bot: conversation history. Stored turns from Supabase (reply chain,
 * recent-conversation continuity) and thread history from the Discord API.
 * Split out of discord-bot.server.ts (issue #429).
 */
import { supabaseAdmin } from './supabase-client.server';
import { HISTORY_MSG_LIMIT, RECENT_CONVERSATION_WINDOW_MS, PLATFORM_DISCORD } from './discord-bot-config.server';
import type { GuildMessage } from './discord-bot-messages.server';

/** A stored chat turn, as the Discord handler needs it. */
type ChatHistoryEntry = {
  role: 'user' | 'assistant';
  content: string;
  created_at: string;
  is_fallback: boolean | null;
  failure_mode: string | null;
};

/** Which stored conversation (if any) an incoming message continues. */
type ConversationLookup = { conversationId: string | null; history: ChatHistoryEntry[] };

/**
 * Load the last HISTORY_MSG_LIMIT turns of a stored conversation.
 *
 * `created_at`, `is_fallback` and `failure_mode` feed the shared content-based dedup check
 * (chat-dedup.server.ts findDuplicateReply); the LLM itself uses only role and
 * content. Turns whose text the 30-day purge has already removed are skipped.
 * A read failure degrades to empty history rather than dropping the reply —
 * answering without context beats not answering at all.
 */
async function loadConversationHistory(conversationId: string): Promise<ChatHistoryEntry[]> {
  if (!supabaseAdmin) return [];

  const { data, error } = await supabaseAdmin
    .from('chat_messages')
    .select('role, content, created_at, is_fallback, failure_mode')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: false })
    .limit(HISTORY_MSG_LIMIT);

  if (error || !data) {
    console.warn('Discord: failed to load conversation history:', error?.message);
    return [];
  }

  // Select the newest turns first, then restore chronological order for model + dedup.
  return data
    .reverse()
    .filter(r => r.role === 'user' || r.role === 'assistant')
    // Purged turns are gone, not empty: past 30 days the cron nulls `content`
    // (US-15 AC8). Drop those rows so the model never sees a blank turn and the
    // dedup check never matches one.
    .filter(r => r.content !== null)
    .map(r => ({
      role: r.role as 'user' | 'assistant',
      content: r.content as string,
      created_at: r.created_at as string,
      is_fallback: r.is_fallback as boolean | null,
      failure_mode: r.failure_mode as string | null,
    }));
}

/**
 * If the message is a reply to one of the bot's previous messages, look up the
 * referenced bot message in Supabase by `discord_message_id`, then load the
 * conversation history. Falls back to a new conversation in any edge case
 * (reply to non-bot, missing row, different Discord author than conversation).
 */
export async function loadConversationForReply(
  message: GuildMessage,
  authorDiscordId: string,
): Promise<ConversationLookup> {
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
  const [convResult, history] = await Promise.all([
    supabaseAdmin
      .from('chat_conversations')
      .select('platform, external_id')
      .eq('id', conversationId)
      .maybeSingle(),
    loadConversationHistory(conversationId),
  ]);

  // Verify conversation belongs to the same Discord user. If not, start fresh —
  // inheriting someone else's history would send the wrong context to the LLM.
  const conv = convResult.data;
  if (convResult.error || !conv) return { conversationId: null, history: [] };
  if (conv.platform !== PLATFORM_DISCORD) return { conversationId: null, history: [] };
  if (conv.external_id !== authorDiscordId) return { conversationId: null, history: [] };

  return { conversationId, history };
}

/**
 * Continuity fallback for users who don't use Discord's reply function.
 *
 * Without this, every message that isn't an explicit reply (and isn't inside a
 * thread) starts a BRAND-NEW conversation with no history — so a user asking
 * follow-ups in the channel gets each turn answered from scratch. The 2026-08-06
 * audit caught the failure mode: one user sent the same clarifying question 7
 * times in 31 minutes, got 7 context-free answers that drifted against each
 * other, and replied "I'm confused because you keep telling me different things".
 *
 * So: if the same Discord user has a conversation touched within the recency
 * window, continue it. Scoped by user, not channel — `chat_conversations` has no
 * channel column, so a user active in two channels inside the window can have
 * those turns merged. That's a far smaller problem than answering every
 * follow-up with no history, but it's why the window is deliberately short.
 */
export async function loadRecentConversation(authorDiscordId: string): Promise<ConversationLookup> {
  if (!supabaseAdmin) return { conversationId: null, history: [] };

  const since = new Date(Date.now() - RECENT_CONVERSATION_WINDOW_MS).toISOString();
  const { data: conv, error: convErr } = await supabaseAdmin
    .from('chat_conversations')
    .select('id')
    .eq('platform', PLATFORM_DISCORD)
    .eq('external_id', authorDiscordId)
    .gte('updated_at', since)
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (convErr) {
    console.warn('Discord: recent-conversation lookup failed:', convErr.message);
    return { conversationId: null, history: [] };
  }
  if (!conv) return { conversationId: null, history: [] };

  return { conversationId: conv.id, history: await loadConversationHistory(conv.id) };
}

/**
 * When a message arrives inside a thread (but is not an explicit reply to the
 * bot), load the last HISTORY_MSG_LIMIT messages from that thread via the
 * Discord API. The thread channel IS the conversation, so this gives full
 * back-and-forth context without needing a Supabase lookup.
 */
export async function loadThreadHistory(
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
