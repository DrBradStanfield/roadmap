/**
 * YouTube bot daily summary email.
 *
 * Once per day at TARGET_HOUR_UTC, queries youtube_bot_log for posted replies
 * in the trailing 24h, renders an HTML email of every comment + bot response,
 * and sends it via Resend so Brad can audit the bot's behaviour each morning.
 *
 * Mirrors reminder-cron.server.ts / trending-cron.server.ts: setInterval at
 * hourly cadence, distributed lock via cron_lock so only one Fly machine sends
 * per day, fast local skip to avoid double-processing inside a single machine.
 *
 * Required env:
 *   YOUTUBE_BOT_SUMMARY_EMAIL — recipient (defaults to brad@drstanfield.com)
 *   RESEND_API_KEY — already required for the reminder email path
 */
import * as Sentry from '@sentry/remix';
import { supabaseAdmin, tryAcquireCronLock } from './supabase.server';
import { sendEmail } from './email.server';

const CRON_INTERVAL_MS = 60 * 60_000; // hourly check
const TARGET_HOUR_UTC = 16;           // 16:00 UTC = 4am NZST (UTC+12) / 5am NZDT (UTC+13)
const MACHINE_ID = process.env.FLY_MACHINE_ID || `local-${process.pid}`;
const RECIPIENT = process.env.YOUTUBE_BOT_SUMMARY_EMAIL || 'brad@drstanfield.com';

let lastRunDate: string | null = null;
let cronIntervalId: ReturnType<typeof setInterval> | null = null;

// ---------------------------------------------------------------------------
// Startup / shutdown
// ---------------------------------------------------------------------------

export function startYouTubeBotSummaryCron(): void {
  if (process.env.NODE_ENV === 'development') {
    console.log('YouTube bot summary cron disabled in development');
    return;
  }

  console.log(`YouTube bot summary cron started (fires daily ≥ ${TARGET_HOUR_UTC}:00 UTC to ${RECIPIENT}, machine: ${MACHINE_ID})`);

  cronIntervalId = setInterval(async () => {
    const now = new Date();
    if (now.getUTCHours() < TARGET_HOUR_UTC) return;

    const todayStr = now.toISOString().slice(0, 10);
    if (lastRunDate === todayStr) return;

    const acquired = await tryAcquireCronLock(MACHINE_ID, todayStr, 'youtube_bot_summary');
    if (!acquired) {
      lastRunDate = todayStr;
      return;
    }
    lastRunDate = todayStr;

    try {
      await runSummary(now);
    } catch (err) {
      console.error('YouTube bot summary cron error:', err);
      Sentry.captureException(err, { tags: { feature: 'youtube-bot-summary' } });
    }
  }, CRON_INTERVAL_MS);
}

export function stopYouTubeBotSummaryCron(): void {
  if (cronIntervalId) {
    clearInterval(cronIntervalId);
    cronIntervalId = null;
  }
  console.log('YouTube bot summary cron stopped');
}

// ---------------------------------------------------------------------------
// Summary builder
// ---------------------------------------------------------------------------

interface YouTubeBotLogRow {
  youtube_comment_id: string;
  user_channel: string | null;
  user_comment: string | null;
  video_id: string | null;
  reply_text: string | null;
  posted_youtube_id: string | null;
  classification: string | null;
  router_handles: string[] | null;
  posted_at: string | null;
}

async function runSummary(now: Date): Promise<void> {
  if (!supabaseAdmin) {
    console.warn('YouTube bot summary: supabaseAdmin not configured');
    return;
  }

  const since = new Date(now.getTime() - 24 * 60 * 60_000).toISOString();

  // Posted replies in the last 24h
  const { data: postedRows, error: postedErr } = await supabaseAdmin
    .from('youtube_bot_log')
    .select('youtube_comment_id, user_channel, user_comment, video_id, reply_text, posted_youtube_id, classification, router_handles, posted_at')
    .eq('posted', true)
    .gte('posted_at', since)
    .order('posted_at', { ascending: false });

  if (postedErr) {
    throw new Error(`YouTube bot summary query failed: ${postedErr.message}`);
  }

  const posted = (postedRows ?? []) as YouTubeBotLogRow[];

  // Skipped (unposted) count — last 24h by processed_at, where the row was claimed but no post made.
  // Capped at 200 by the cleanup, so this is best-effort.
  const { count: skippedCount } = await supabaseAdmin
    .from('youtube_bot_log')
    .select('id', { count: 'exact', head: true })
    .eq('posted', false)
    .gte('processed_at', since);

  const subject = posted.length > 0
    ? `YouTube bot — ${posted.length} replies in last 24h`
    : `YouTube bot — 0 replies in last 24h`;

  const html = renderSummaryHtml({
    posted,
    skippedCount: skippedCount ?? 0,
    dayLabel: now.toISOString().slice(0, 10),
  });

  await sendEmail(RECIPIENT, subject, html);
  console.log(`YouTube bot summary sent to ${RECIPIENT}: ${posted.length} posted, ${skippedCount ?? 0} skipped`);
}

// ---------------------------------------------------------------------------
// HTML renderer
// ---------------------------------------------------------------------------

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function renderSummaryHtml(params: {
  posted: YouTubeBotLogRow[];
  skippedCount: number;
  dayLabel: string;
}): string {
  const { posted, skippedCount, dayLabel } = params;

  const rows = posted.map((row, idx) => {
    const videoUrl = row.video_id ? `https://youtu.be/${row.video_id}` : '';
    // Deep-link to the user's top-level comment (lc = leaf comment / "linked comment").
    // The bot's reply will be a child of this thread.
    const commentUrl = row.video_id && row.youtube_comment_id
      ? `https://www.youtube.com/watch?v=${row.video_id}&lc=${row.youtube_comment_id}`
      : videoUrl;
    const postedAtFmt = row.posted_at ? new Date(row.posted_at).toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : '';

    return `
      <tr>
        <td style="padding:14px 16px;border-bottom:1px solid #e5e5e5;vertical-align:top;">
          <div style="color:#999;font-size:12px;font-family:ui-monospace,monospace;">#${idx + 1} · ${escapeHtml(postedAtFmt)} · ${escapeHtml(row.classification ?? '?')}</div>
          <div style="margin-top:6px;font-size:13px;">
            <span style="color:#555;">on </span>
            <a href="${escapeHtml(commentUrl)}" style="color:#2b5fb0;text-decoration:none;font-weight:600;">${escapeHtml(videoUrl)}</a>
          </div>
          <div style="margin-top:10px;font-size:13px;color:#888;">
            From <strong style="color:#1a1a1a;">${escapeHtml(row.user_channel ?? '(unknown)')}</strong>:
          </div>
          <div style="margin-top:4px;padding:8px 12px;background:#f7f7f7;border-radius:6px;font-size:14px;color:#1a1a1a;white-space:pre-wrap;">
            ${escapeHtml((row.user_comment ?? '').slice(0, 800))}
          </div>
          <div style="margin-top:10px;font-size:13px;color:#888;">
            Bot reply:
          </div>
          <div style="margin-top:4px;padding:8px 12px;background:#e9f4ec;border-left:3px solid #2f7a4d;border-radius:0 6px 6px 0;font-size:14px;color:#1a1a1a;white-space:pre-wrap;">
            ${escapeHtml(row.reply_text ?? '')}
          </div>
          <div style="margin-top:10px;font-size:12px;">
            <a href="${escapeHtml(commentUrl)}" style="color:#2b5fb0;text-decoration:none;">View on YouTube &rarr;</a>
          </div>
        </td>
      </tr>`;
  }).join('');

  const emptyState = `
    <tr>
      <td style="padding:32px 16px;text-align:center;color:#888;font-size:14px;">
        No replies posted in the last 24h.<br><br>
        <span style="color:#aaa;font-size:12px;">${skippedCount} comments were processed and skipped (greeting / SKIP_NO_REPLY / filter).</span>
      </td>
    </tr>`;

  return `<!doctype html>
<html><head><meta charset="utf-8"/></head>
<body style="margin:0;padding:0;background:#fafafa;font-family:-apple-system,BlinkMacSystemFont,'Helvetica Neue',sans-serif;color:#1a1a1a;">
  <div style="max-width:760px;margin:0 auto;padding:24px;">
    <h1 style="margin:0 0 4px;font-size:22px;">YouTube bot — daily summary</h1>
    <div style="color:#666;margin-bottom:20px;font-size:14px;">${escapeHtml(dayLabel)} · ${posted.length} replies posted · ${skippedCount} comments skipped</div>
    <table style="width:100%;border-collapse:collapse;background:#fff;border:1px solid #e5e5e5;border-radius:8px;overflow:hidden;">
      <tbody>
        ${posted.length > 0 ? rows : emptyState}
      </tbody>
    </table>
    <div style="margin-top:24px;font-size:12px;color:#888;text-align:center;">
      Manage via YouTube Studio &middot; Bot config in <code>app/lib/youtube-bot.server.ts</code>
    </div>
  </div>
</body></html>`;
}

// ---------------------------------------------------------------------------
// Auto-start on module import
// ---------------------------------------------------------------------------

startYouTubeBotSummaryCron();
