/**
 * Discord bot: persistence of each turn to the shared chat tables. Split out
 * of discord-bot.server.ts (issue #429), which re-exports persistConversation.
 */
import * as Sentry from '@sentry/react-router';
import { generateTitle } from './chat.server';
import type { RouterResult } from './chat-router.server';
import { routerColumns, matchEventText, answerColumns } from './chat-persist.server';
import { supabaseAdmin } from './supabase.server';
import { DISCORD_BOT_PROFILE_ID, PLATFORM_DISCORD } from './discord-bot-config.server';

// ---------------------------------------------------------------------------
// Persistence — writes the user message, assistant response, and router event
// to the same tables the Shopify chat uses, tagged with platform='discord' and
// external_id=<Discord user ID>. Uses the shared Discord bot profile for user_id.
// ---------------------------------------------------------------------------

interface PersistParams {
  conversationId: string | null;
  authorId: string;
  userMessage: string;
  userDiscordMessageId: string;
  assistantContent: string;
  /** US-15 AC48: a SPAM turn. Only its match event is stored, so it never enters history or continuity. */
  silent: boolean;
  assistantDiscordMessageIds: string[];
  usage: { inputTokens: number; outputTokens: number; cacheCreationTokens: number; cacheReadTokens: number };
  isFallback: boolean;
  /** Fallback cause + raw error, mirrored to chat_messages for the audit email. */
  failureMode?: string;
  errorDetail?: string;
  /** Router-call result. null when classifier said SKIP — router never ran. */
  routerResult: RouterResult | null;
  /** US-50 AC14: router picks replaced by their masters, and masters loaded reduced. */
  replaced?: string[];
  reduced?: string[];
  classifier: {
    classification: string;
    routerSkipped: boolean;
  };
  contextFirst?: string;
  contextRecent: string[];
}

// Model tag comes from chat.server.ts (through answerColumns) — the single source of truth for which
// model actually answers. This was a hard-coded 'claude-haiku-4-5-20251001'
// until 2026-08-07 and did not follow the Sonnet 5 cutover, so every Discord
// row persisted since then is labelled with the wrong model. Rows created
// before this fix cannot be trusted on the `model` column. Exported for tests.
export async function persistConversation(p: PersistParams): Promise<void> {
  if (!supabaseAdmin || !DISCORD_BOT_PROFILE_ID) return;

  let conversationId = p.conversationId;

  if (!conversationId && !p.silent) {
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
        extra: { dbError: convErr?.message },
      });
      return;
    }
    conversationId = conv.id;
  }

  // User message first (keeps chronological order when reading the thread back)
  const { error: userErr } = p.silent ? { error: null } : await supabaseAdmin
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
  // A silent turn (SPAM, US-15 AC48) stores no message rows: its match event
  // carries a null message_id, as YouTube's skips do.
  const firstSentId = p.assistantDiscordMessageIds[0] ?? null;
  const assistantMessageId = p.silent ? null : crypto.randomUUID();
  const { error: asstErr } = !assistantMessageId ? { error: null } : await supabaseAdmin
    .from('chat_messages')
    .insert({
      id: assistantMessageId,
      conversation_id: conversationId,
      user_id: DISCORD_BOT_PROFILE_ID,
      role: 'assistant',
      content: p.assistantContent,
      ...answerColumns(p),
      discord_message_id: firstSentId,
    });
  if (asstErr) {
    Sentry.captureException(new Error('Discord: failed to save assistant message'), {
      tags: { platform: PLATFORM_DISCORD },
      extra: { dbError: asstErr.message, conversationId },
    });
    return;
  }

  // Router event (analytics / QA). Written only after the assistant row it points to.
  // All router_* metric columns are null on SKIP turns (router never ran).
  const r = p.routerResult;
  const { error: evtErr } = await supabaseAdmin
    .from('chat_match_events')
    .insert({
      message_id: assistantMessageId,
      conversation_id: conversationId,
      user_id: DISCORD_BOT_PROFILE_ID,
      message: matchEventText(p.userMessage),
      router_context: {
        platform: PLATFORM_DISCORD,
        first: p.contextFirst != null ? matchEventText(p.contextFirst) : null,
        recent: p.contextRecent.map(matchEventText),
        ...(p.replaced?.length ? { replaced: p.replaced } : {}),
        ...(p.reduced?.length ? { reduced: p.reduced } : {}),
      },
      matched_handles: r?.handles ?? [],
      ...routerColumns(r),
      classification: p.classifier.classification,
      router_skipped: p.classifier.routerSkipped,
      is_fallback: p.isFallback,
      failure_mode: p.failureMode ?? null,
    });
  if (evtErr) {
    Sentry.captureException(new Error('Discord: match-event insert failed'), {
      tags: { platform: PLATFORM_DISCORD },
      extra: { dbError: evtErr.message, messageId: assistantMessageId },
    });
  }

  // Touch the conversation timestamp so the list is ordered by recency. Not for
  // a silent turn, which must not extend the 30-min continuity window.
  if (!p.silent) await supabaseAdmin
    .from('chat_conversations')
    .update({ updated_at: new Date().toISOString() })
    .eq('id', conversationId);
}
