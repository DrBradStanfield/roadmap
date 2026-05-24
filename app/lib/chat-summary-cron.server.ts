/**
 * Daily chat activity summary email (web + Discord combined).
 *
 * Fires once per day at TARGET_HOUR_UTC (16:00 UTC = 4am NZST), queries
 * chat_conversations + chat_messages + chat_match_events for activity in
 * the trailing 24h, renders an HTML email grouped by platform showing
 * every user turn + bot reply with classifier output and router handles.
 *
 * Lets Brad audit on-site chat + Discord activity daily without opening
 * Supabase or running chat-audit-pull.ts.
 *
 * Required env: RESEND_API_KEY (already required for reminder emails)
 * Optional env: CHAT_SUMMARY_EMAIL — recipient (defaults to brad@drstanfield.com)
 */
import * as Sentry from '@sentry/remix';
import { supabaseAdmin, tryAcquireCronLock } from './supabase.server';
import { sendEmail, escapeHtml } from './email.server';
import { Classification } from './chat-classifier.server';
import { withTimeout } from './cron-helpers.server';

const CRON_INTERVAL_MS = 60 * 60_000;
const TARGET_HOUR_UTC = 16;           // 16:00 UTC = 4am NZST (UTC+12) / 5am NZDT (UTC+13)
const MACHINE_ID = process.env.FLY_MACHINE_ID || `local-${process.pid}`;
const RECIPIENT = process.env.CHAT_SUMMARY_EMAIL || 'brad@drstanfield.com';

const PLATFORMS = ['shopify', 'discord'] as const;
type Platform = typeof PLATFORMS[number];

let lastRunDate: string | null = null;
let cronIntervalId: ReturnType<typeof setInterval> | null = null;

// ---------------------------------------------------------------------------
// Startup / shutdown
// ---------------------------------------------------------------------------

export function startChatSummaryCron(): void {
  if (process.env.NODE_ENV === 'development') {
    console.log('Chat summary cron disabled in development');
    return;
  }

  console.log(`Chat summary cron started (fires daily ≥ ${TARGET_HOUR_UTC}:00 UTC to ${RECIPIENT}, machine: ${MACHINE_ID})`);

  cronIntervalId = setInterval(async () => {
    // TEMP diagnostic: mirror trending-cron's setInterval instrumentation. Several
    // recent firings advanced the cron_lock but produced zero downstream events —
    // no email, no Sentry alert. Outer try/catch + step breadcrumbs surface
    // exactly where the callback stalls.
    try {
      const now = new Date();
      if (now.getUTCHours() < TARGET_HOUR_UTC) return;

      const todayStr = now.toISOString().slice(0, 10);
      if (lastRunDate === todayStr) return;

      Sentry.captureMessage('chat_summary: callback entered, about to acquire lock', {
        level: 'info',
        tags: { feature: 'chat-summary', diagnostic: 'cb_pre_lock' },
        extra: { todayStr, machineId: MACHINE_ID },
      });

      const acquired = await tryAcquireCronLock(MACHINE_ID, todayStr, 'chat_summary');

      Sentry.captureMessage('chat_summary: tryAcquireCronLock returned', {
        level: 'info',
        tags: { feature: 'chat-summary', diagnostic: 'cb_post_lock' },
        extra: { acquired, todayStr },
      });

      if (!acquired) {
        lastRunDate = todayStr;
        return;
      }
      lastRunDate = todayStr;

      Sentry.captureMessage('chat_summary: about to call runSummary', {
        level: 'info',
        tags: { feature: 'chat-summary', diagnostic: 'cb_pre_runSummary' },
      });

      try {
        await runSummary(now);
        Sentry.captureMessage('chat_summary: runSummary completed', {
          level: 'info',
          tags: { feature: 'chat-summary', diagnostic: 'cb_post_runSummary' },
        });
      } catch (err) {
        console.error('Chat summary cron error:', err);
        Sentry.captureException(err, { tags: { feature: 'chat-summary' } });
      }
    } catch (outerErr) {
      console.error('Chat summary cron OUTER error:', outerErr);
      Sentry.captureException(outerErr, { tags: { feature: 'chat-summary', diagnostic: 'outer_catch' } });
    }
  }, CRON_INTERVAL_MS);
}

export function stopChatSummaryCron(): void {
  if (cronIntervalId) {
    clearInterval(cronIntervalId);
    cronIntervalId = null;
  }
  console.log('Chat summary cron stopped');
}

// ---------------------------------------------------------------------------
// Summary builder
// ---------------------------------------------------------------------------

interface Conversation {
  id: string;
  platform: Platform;
  external_id: string | null;
  title: string | null;
  updated_at: string;
}

interface Message {
  id: string;
  conversation_id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  is_fallback: boolean | null;
  created_at: string;
}

interface MatchEvent {
  message_id: string;
  classification: string | null;
  router_skipped: boolean | null;
  matched_handles: string[] | null;
}

interface Turn {
  conversationId: string;
  platform: Platform;
  conversationTitle: string | null;
  userContent: string;
  userCreatedAt: string;
  assistantContent: string | null;
  assistantCreatedAt: string | null;
  assistantIsFallback: boolean;
  classification: string | null;
  routerSkipped: boolean | null;
  matchedHandles: string[];
}

/**
 * Run the chat summary once for the current moment.
 * Exposed so the admin debug route can manually trigger the same path the
 * cron runs nightly.
 */
export async function runChatSummaryOnce(): Promise<void> {
  return runSummary(new Date());
}

async function runSummary(now: Date): Promise<void> {
  if (!supabaseAdmin) {
    console.warn('Chat summary: supabaseAdmin not configured');
    return;
  }

  const since = new Date(now.getTime() - 24 * 60 * 60_000).toISOString();

  Sentry.captureMessage('chat_summary: runSummary entered, about to query conversations', {
    level: 'info',
    tags: { feature: 'chat-summary', diagnostic: 'runSummary_pre_query' },
  });

  // Conversations active in the last 24h on tracked platforms
  const { data: convRows, error: convErr } = await withTimeout(
    supabaseAdmin
      .from('chat_conversations')
      .select('id, platform, external_id, title, updated_at')
      .gte('updated_at', since)
      .in('platform', [...PLATFORMS]),
    30_000,
    'chat_summary: conv_query',
  );

  if (convErr) throw new Error(`Chat summary: conversation query failed: ${convErr.message}`);

  const conversations = (convRows ?? []) as Conversation[];

  Sentry.captureMessage('chat_summary: conv query returned', {
    level: 'info',
    tags: { feature: 'chat-summary', diagnostic: 'runSummary_post_conv_query' },
    extra: { conversationCount: conversations.length },
  });

  if (conversations.length === 0) {
    Sentry.captureMessage('chat_summary: empty path, about to send empty-state email', {
      level: 'info',
      tags: { feature: 'chat-summary', diagnostic: 'runSummary_pre_sendEmail' },
      extra: { htmlBytes: 0, path: 'empty' },
    });
    const { id } = await withTimeout(
      sendEmail(RECIPIENT, 'Daily chat summary — no activity in last 24h', renderEmptyHtml(now)),
      30_000,
      'chat_summary: sendEmail (empty)',
    );
    Sentry.captureMessage('chat_summary: empty-state email sent', {
      level: 'info',
      tags: { feature: 'chat-summary', diagnostic: 'runSummary_post_sendEmail' },
      extra: { resendId: id, path: 'empty' },
    });
    console.log(`Chat summary sent to ${RECIPIENT}: 0 conversations, 0 turns (resend id ${id})`);
    return;
  }

  const conversationIds = conversations.map(c => c.id);
  const convById = new Map(conversations.map(c => [c.id, c] as const));

  // Messages in those conversations created in the last 24h
  const { data: msgRows, error: msgErr } = await withTimeout(
    supabaseAdmin
      .from('chat_messages')
      .select('id, conversation_id, role, content, is_fallback, created_at')
      .in('conversation_id', conversationIds)
      .gte('created_at', since)
      .in('role', ['user', 'assistant'])
      .order('created_at', { ascending: true }),
    30_000,
    'chat_summary: msg_query',
  );

  if (msgErr) throw new Error(`Chat summary: message query failed: ${msgErr.message}`);

  const messages = (msgRows ?? []) as Message[];

  Sentry.captureMessage('chat_summary: msg query returned', {
    level: 'info',
    tags: { feature: 'chat-summary', diagnostic: 'runSummary_post_msg_query' },
    extra: { messageCount: messages.length },
  });

  // Match events for the assistant messages (classifier output + router handles)
  const assistantIds = messages.filter(m => m.role === 'assistant').map(m => m.id);
  let eventByMessageId = new Map<string, MatchEvent>();
  if (assistantIds.length > 0) {
    const { data: eventRows, error: eventErr } = await withTimeout(
      supabaseAdmin
        .from('chat_match_events')
        .select('message_id, classification, router_skipped, matched_handles')
        .in('message_id', assistantIds),
      30_000,
      'chat_summary: event_query',
    );
    if (eventErr) {
      // Non-fatal: still send the email without classifier metadata
      console.warn('Chat summary: match-event query failed:', eventErr.message);
    } else {
      for (const ev of (eventRows ?? []) as MatchEvent[]) {
        eventByMessageId.set(ev.message_id, ev);
      }
    }
  }

  // Pair user→assistant turns within each conversation
  const turns: Turn[] = [];
  const byConv = new Map<string, Message[]>();
  for (const m of messages) {
    if (!byConv.has(m.conversation_id)) byConv.set(m.conversation_id, []);
    byConv.get(m.conversation_id)!.push(m);
  }
  for (const [convId, conv] of byConv) {
    const meta = convById.get(convId);
    if (!meta) continue;
    for (let i = 0; i < conv.length; i++) {
      const userMsg = conv[i];
      if (userMsg.role !== 'user') continue;
      // Find the next assistant reply (likely conv[i+1], but be defensive)
      let assistant: Message | null = null;
      for (let j = i + 1; j < conv.length; j++) {
        if (conv[j].role === 'assistant') { assistant = conv[j]; break; }
      }
      const event = assistant ? eventByMessageId.get(assistant.id) ?? null : null;
      turns.push({
        conversationId: convId,
        platform: meta.platform,
        conversationTitle: meta.title,
        userContent: userMsg.content,
        userCreatedAt: userMsg.created_at,
        assistantContent: assistant?.content ?? null,
        assistantCreatedAt: assistant?.created_at ?? null,
        assistantIsFallback: assistant?.is_fallback === true,
        classification: event?.classification ?? null,
        routerSkipped: event?.router_skipped ?? null,
        matchedHandles: event?.matched_handles ?? [],
      });
    }
  }

  // Newest first
  turns.sort((a, b) => b.userCreatedAt.localeCompare(a.userCreatedAt));

  const webTurns = turns.filter(t => t.platform === 'shopify');
  const discordTurns = turns.filter(t => t.platform === 'discord');
  const fallbackCount = turns.filter(t => t.assistantIsFallback).length;

  const subject = `Daily chat summary — ${webTurns.length} web + ${discordTurns.length} Discord turns`;
  const html = renderSummaryHtml({
    webTurns,
    discordTurns,
    fallbackCount,
    conversationCount: conversations.length,
    dayLabel: now.toISOString().slice(0, 10),
  });

  Sentry.captureMessage('chat_summary: about to call sendEmail', {
    level: 'info',
    tags: { feature: 'chat-summary', diagnostic: 'runSummary_pre_sendEmail' },
    extra: { htmlBytes: html.length, webTurns: webTurns.length, discordTurns: discordTurns.length, path: 'normal' },
  });

  const { id } = await withTimeout(
    sendEmail(RECIPIENT, subject, html),
    30_000,
    'chat_summary: sendEmail',
  );

  Sentry.captureMessage('chat_summary: sendEmail returned', {
    level: 'info',
    tags: { feature: 'chat-summary', diagnostic: 'runSummary_post_sendEmail' },
    extra: { resendId: id, path: 'normal' },
  });

  console.log(`Chat summary sent to ${RECIPIENT}: ${webTurns.length} web + ${discordTurns.length} Discord turns, ${fallbackCount} fallbacks (resend id ${id})`);
}

// ---------------------------------------------------------------------------
// HTML rendering
// ---------------------------------------------------------------------------

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + '…';
}

function classifyBadgeColor(c: string | null): string {
  if (c === Classification.ROUTE) return '#2b5fb0';
  if (c === Classification.GREETING) return '#888';
  if (c === Classification.PRODUCT || c === Classification.ACCOUNT) return '#a06030';
  if (c === Classification.ERROR) return '#c0392b';
  return '#aaa';
}

function renderTurnRow(turn: Turn, idx: number): string {
  const ts = turn.assistantCreatedAt
    ? new Date(turn.assistantCreatedAt).toISOString().replace('T', ' ').slice(0, 16) + ' UTC'
    : new Date(turn.userCreatedAt).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
  const classBadge = turn.classification
    ? `<span style="display:inline-block;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:600;background:${classifyBadgeColor(turn.classification)};color:#fff;">${escapeHtml(turn.classification)}</span>`
    : '';
  const skippedBadge = turn.routerSkipped
    ? `<span style="display:inline-block;padding:2px 8px;border-radius:10px;font-size:11px;background:#eee;color:#666;margin-left:4px;">router skipped</span>`
    : '';
  const fallbackBadge = turn.assistantIsFallback
    ? `<span style="display:inline-block;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:600;background:#c0392b;color:#fff;margin-left:4px;">FALLBACK</span>`
    : '';
  const handles = turn.matchedHandles.length > 0
    ? `<div style="font-size:11px;color:#666;margin-top:6px;">router handles: ${turn.matchedHandles.map(h => `<code style="background:#eef4fc;padding:1px 5px;border-radius:3px;font-size:11px;">${escapeHtml(h)}</code>`).join(' ')}</div>`
    : '';
  const assistant = turn.assistantContent
    ? `<div style="margin-top:4px;padding:8px 12px;background:#e9f4ec;border-left:3px solid #2f7a4d;border-radius:0 6px 6px 0;font-size:13px;color:#1a1a1a;white-space:pre-wrap;">${escapeHtml(truncate(turn.assistantContent, 1200))}</div>`
    : `<div style="margin-top:4px;padding:8px 12px;background:#f7f7f7;border-radius:6px;font-size:13px;color:#888;font-style:italic;">(no assistant reply yet)</div>`;

  return `
    <tr>
      <td style="padding:14px 16px;border-bottom:1px solid #e5e5e5;vertical-align:top;">
        <div style="color:#999;font-size:12px;font-family:ui-monospace,monospace;">#${idx + 1} · ${escapeHtml(ts)} ${classBadge}${skippedBadge}${fallbackBadge}</div>
        ${turn.conversationTitle ? `<div style="margin-top:4px;font-size:12px;color:#888;">conv: ${escapeHtml(turn.conversationTitle)}</div>` : ''}
        <div style="margin-top:8px;font-size:12px;color:#888;">User:</div>
        <div style="margin-top:2px;padding:8px 12px;background:#f7f7f7;border-radius:6px;font-size:13px;color:#1a1a1a;white-space:pre-wrap;">${escapeHtml(truncate(turn.userContent, 600))}</div>
        <div style="margin-top:8px;font-size:12px;color:#888;">Bot:</div>
        ${assistant}
        ${handles}
      </td>
    </tr>`;
}

function renderEmptyHtml(now: Date): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"/></head>
<body style="margin:0;padding:0;background:#fafafa;font-family:-apple-system,BlinkMacSystemFont,'Helvetica Neue',sans-serif;color:#1a1a1a;">
  <div style="max-width:760px;margin:0 auto;padding:24px;">
    <h1 style="margin:0 0 4px;font-size:22px;">Daily chat summary</h1>
    <div style="color:#666;margin-bottom:20px;font-size:14px;">${escapeHtml(now.toISOString().slice(0, 10))} · No activity in last 24h</div>
    <div style="padding:32px;background:#fff;border:1px solid #e5e5e5;border-radius:8px;text-align:center;color:#888;font-size:14px;">
      No web or Discord chat turns in the last 24h.
    </div>
  </div>
</body></html>`;
}

function renderSummaryHtml(params: {
  webTurns: Turn[];
  discordTurns: Turn[];
  fallbackCount: number;
  conversationCount: number;
  dayLabel: string;
}): string {
  const { webTurns, discordTurns, fallbackCount, conversationCount, dayLabel } = params;

  const sectionHtml = (title: string, color: string, turns: Turn[]) => {
    if (turns.length === 0) {
      return `
        <h2 style="font-size:16px;margin:24px 0 8px;color:${color};">${escapeHtml(title)} <span style="color:#888;font-weight:normal;font-size:13px;">— 0 turns</span></h2>
        <div style="padding:16px;background:#fff;border:1px solid #e5e5e5;border-radius:8px;color:#888;font-size:13px;font-style:italic;">No turns.</div>`;
    }
    return `
      <h2 style="font-size:16px;margin:24px 0 8px;color:${color};">${escapeHtml(title)} <span style="color:#888;font-weight:normal;font-size:13px;">— ${turns.length} turns</span></h2>
      <table style="width:100%;border-collapse:collapse;background:#fff;border:1px solid #e5e5e5;border-radius:8px;overflow:hidden;">
        <tbody>${turns.map((t, i) => renderTurnRow(t, i)).join('')}</tbody>
      </table>`;
  };

  const fallbackBanner = fallbackCount > 0
    ? `<div style="padding:12px 16px;background:#fce8e6;border-left:4px solid #c0392b;border-radius:0 6px 6px 0;margin-bottom:20px;font-size:13px;"><strong style="color:#c0392b;">${fallbackCount} fallback replies</strong> — the bot's main LLM failed or returned empty on these turns and the user got the canned fallback message. Worth investigating.</div>`
    : '';

  return `<!doctype html>
<html><head><meta charset="utf-8"/></head>
<body style="margin:0;padding:0;background:#fafafa;font-family:-apple-system,BlinkMacSystemFont,'Helvetica Neue',sans-serif;color:#1a1a1a;">
  <div style="max-width:760px;margin:0 auto;padding:24px;">
    <h1 style="margin:0 0 4px;font-size:22px;">Daily chat summary</h1>
    <div style="color:#666;margin-bottom:20px;font-size:14px;">
      ${escapeHtml(dayLabel)} · ${conversationCount} active conversations ·
      ${webTurns.length} web turns · ${discordTurns.length} Discord turns ·
      ${fallbackCount} fallbacks
    </div>
    ${fallbackBanner}
    ${sectionHtml('Web chat (drstanfield.com)', '#2b5fb0', webTurns)}
    ${sectionHtml('Discord', '#5865f2', discordTurns)}
    <div style="margin-top:24px;font-size:12px;color:#888;text-align:center;">
      Full audit: <code>tools/chat-audit-pull.ts</code> · Bot code: <code>app/lib/discord-bot.server.ts</code> + <code>app/routes/api.chat.ts</code>
    </div>
  </div>
</body></html>`;
}

// ---------------------------------------------------------------------------
// Auto-start on module import
// ---------------------------------------------------------------------------

startChatSummaryCron();
