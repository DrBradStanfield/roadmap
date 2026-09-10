/**
 * Chat-text retention cron (US-15 AC7 and AC8, 2026-09-10).
 *
 * Three tables, one window: nothing a person typed into the chat, and nothing
 * the model said back, stays readable past 30 days.
 *
 * `chat_match_events` is the router audit: it keeps one row per answered turn
 * so article matching can be checked against the real question. The audit only
 * ever looks at recent traffic, so the text has no reason to live forever.
 * Once a day this clears every free-text field on rows past the window, on
 * every platform: `message`, the earlier turns the router saw
 * (`router_context.first` / `.recent`), and the router's own output
 * (`router_raw`, `router_error`) — which quotes the question back. What the
 * counts are made of — `matched_handles`, `classification`, the timings,
 * `is_fallback`, and the surface name — stays.
 *
 * `chat_messages` and `chat_conversations` are the transcripts behind the blog
 * bubble, the chatbot embed and the Discord bot: question and reply, plus a
 * title made of the first few words of the question. Both get blanked on the
 * same schedule, on `platform in ('shopify','discord')` — a question typed at the
 * bot is as private as a bubble question (Brad's decision, 2026-09-10 evening).
 * YouTube stays: those transcripts are public comments under their own
 * retention. The shape of the conversation survives: id, role, timestamps,
 * model, token counts, `is_fallback`, `failure_mode`. Only the words go.
 *
 * Same shape as the other crons (trending, reminder v2): hourly setInterval, a
 * `< target hour` catch-up check so a deploy can't skip the day, and the
 * shared `cron_lock` row so only one machine runs it (both Fly apps share this
 * Supabase project).
 */
import * as Sentry from '@sentry/react-router';
import { supabaseAdmin, tryAcquireCronLock } from './supabase.server';

const CRON_INTERVAL_MS = 60 * 60 * 1000;
const TARGET_HOUR_UTC = 4;
const MACHINE_ID = process.env.FLY_MACHINE_ID || `local-${process.pid}`;

/** How long the question and the router's answer stay readable for the audit. */
export const PURGE_AFTER_DAYS = 30;
/** Rows cleared per round trip. The loop re-selects until nothing is left. */
const BATCH_SIZE = 500;

/** Platforms whose transcripts are private text on a 30-day clock. YouTube is
 *  absent on purpose: those turns are public comments. */
const PURGED_PLATFORMS = ['shopify', 'discord'];

/** What a reader sees where a purged message used to be. The row is still
 *  there — the words are not. Anything rendering a transcript substitutes it. */
export const PURGED_TEXT = '[removed after 30 days]';

/** What one run cleared, per table. Counts, never text. */
export interface PurgeCounts {
  matchEvents: number;
  messages: number;
  conversations: number;
}

let lastRunDate: string | null = null;
let cronIntervalId: ReturnType<typeof setInterval> | null = null;

/** The question keys. Everything else in `router_context` (the surface name,
 *  YouTube's video and comment ids) is not a question and stays. */
const QUESTION_KEYS = ['first', 'recent'];

/**
 * Clear the free text from every row older than the window, in all three
 * tables. Returns how many rows each pass cleared — counts, never the text.
 * Throws on a database error so the caller's catch reports it instead of
 * logging a clean run.
 */
export async function purgeOldChatText(now: Date = new Date()): Promise<PurgeCounts> {
  if (!supabaseAdmin) return { matchEvents: 0, messages: 0, conversations: 0 };
  const cutoff = new Date(now.getTime() - PURGE_AFTER_DAYS * 86400_000).toISOString();
  return {
    matchEvents: await purgeMatchEvents(cutoff),
    // `!inner` makes the join a filter: a message qualifies only if its own
    // conversation is on a purged platform. Without it PostgREST would return
    // every message and merely null the embed.
    messages: await purgeInBatches(
      'chat message',
      () =>
        supabaseAdmin!
          .from('chat_messages')
          .select('id, chat_conversations!inner(platform)')
          .in('chat_conversations.platform', PURGED_PLATFORMS)
          .lt('created_at', cutoff)
          .not('content', 'is', null)
          .limit(BATCH_SIZE),
      (rows) => supabaseAdmin!.from('chat_messages').update({ content: null }).in('id', rows.map((r) => r.id)),
    ),
    // The title is the first words of the question, so it is question text.
    // `updated_at` is the conversation's own clock: a thread stays readable
    // for 30 days after its last turn, not after its first.
    conversations: await purgeInBatches(
      'chat title',
      () =>
        supabaseAdmin!
          .from('chat_conversations')
          .select('id')
          .in('platform', PURGED_PLATFORMS)
          .lt('updated_at', cutoff)
          .not('title', 'is', null)
          .limit(BATCH_SIZE),
      (rows) => supabaseAdmin!.from('chat_conversations').update({ title: null }).in('id', rows.map((r) => r.id)),
    ),
  };
}

interface Fallible {
  error: { message: string } | null;
}

/**
 * One table's pass: select a batch of stale rows, clear them, repeat until the
 * select comes back empty. All three passes share it, so all three share the
 * no-progress guard — a batch that comes back identical means the updates are
 * not landing (a policy or trigger swallowing them), so stop rather than spin.
 */
async function purgeInBatches<T extends { id: string }>(
  label: string,
  stale: () => PromiseLike<Fallible & { data: T[] | null }>,
  clear: (rows: T[]) => PromiseLike<Fallible>,
): Promise<number> {
  let cleared = 0;
  let previous = '';
  for (;;) {
    const { data, error } = await stale();
    if (error) throw new Error(`${label} purge select failed: ${error.message}`);
    if (!data?.length) return cleared;
    const batch = data.map((r) => r.id).join(',');
    if (batch === previous) throw new Error(`${label} purge made no progress`);
    previous = batch;

    const { error: updateError } = await clear(data);
    if (updateError) throw new Error(`${label} purge update failed: ${updateError.message}`);
    cleared += data.length;
  }
}

function purgeMatchEvents(cutoff: string): Promise<number> {
  return purgeInBatches(
    'chat text',
    () =>
      supabaseAdmin!
        .from('chat_match_events')
        .select('id, router_context')
        .lt('created_at', cutoff)
        // Any of the three still holding text qualifies: rows purged before
        // `router_raw` came into scope have a null `message` already.
        .or('message.not.is.null,router_raw.not.is.null,router_error.not.is.null')
        .limit(BATCH_SIZE),
    // Per row, because `router_context` differs per row and a single UPDATE
    // cannot subtract keys from each one's own JSON. Every field goes in the
    // same statement, so a row can never be left half-cleared — which is what
    // makes the filter above complete.
    async (rows) => {
      for (const row of rows) {
        const context = { ...(row.router_context as Record<string, unknown> | null) };
        for (const key of QUESTION_KEYS) delete context[key];
        const { error } = await supabaseAdmin!
          .from('chat_match_events')
          .update({
            message: null,
            router_raw: null,
            router_error: null,
            router_context: row.router_context === null ? null : context,
          })
          .eq('id', row.id);
        if (error) return { error };
      }
      return { error: null };
    },
  );
}

/** The day's work, behind the shared lock. Returns null if another machine
 *  won the day. Exported for the test suite. */
export async function purgeWithLock(todayStr: string, now: Date = new Date()): Promise<PurgeCounts | null> {
  const acquired = await tryAcquireCronLock(MACHINE_ID, todayStr, 'chat_text_purge');
  if (!acquired) return null;
  const cleared = await purgeOldChatText(now);
  console.log(
    `Chat text purge (older than ${PURGE_AFTER_DAYS} days): ${cleared.matchEvents} match events, ` +
      `${cleared.messages} messages, ${cleared.conversations} conversation titles`,
  );
  return cleared;
}

export function startChatPurgeCron(): void {
  if (process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test') {
    console.log(`Chat text purge cron disabled in ${process.env.NODE_ENV}`);
    return;
  }

  console.log(`Chat text purge cron started (first tick ≥ ${TARGET_HOUR_UTC}:00 UTC daily, machine: ${MACHINE_ID})`);

  cronIntervalId = setInterval(async () => {
    try {
      const now = new Date();
      if (now.getUTCHours() < TARGET_HOUR_UTC) return;

      const todayStr = now.toISOString().slice(0, 10);
      if (lastRunDate === todayStr) return;

      // Acquire stays inside the try/catch (US-28 AC2: a lock error retries next tick).
      await purgeWithLock(todayStr, now);
      lastRunDate = todayStr;
    } catch (error) {
      console.error('Chat text purge cron error:', error);
      Sentry.captureException(error, { tags: { feature: 'chat_text_purge_cron' } });
    }
  }, CRON_INTERVAL_MS);
}

export function stopChatPurgeCron(): void {
  if (cronIntervalId) {
    clearInterval(cronIntervalId);
    cronIntervalId = null;
    console.log('Chat text purge cron stopped');
  }
}

startChatPurgeCron();
