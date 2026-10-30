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
 * Before it blanks a web chat question (`shopify` or `widget`, classified
 * `ROUTE` or `MEASUREMENT`), the pass keeps a scrubbed copy of that one
 * question, with no end date, in `chat_question_archive` (US-15 AC44): the
 * question with names, places, dates, ages, contact details, ids and jobs
 * replaced, its platform, and the Monday of its week. We do not link it
 * to an account, a conversation or a session (US-15 AC44 says how it could be traced). The scrub runs only after all
 * three passes; a failure there is counted, never thrown. Off unless the
 * `CHAT_QUESTION_ARCHIVE` secret is `on`: then no model call, no insert, no event.
 *
 * `chat_messages` and `chat_conversations` are the transcripts behind the blog
 * bubble, the chatbot embed and the Discord bot: question and reply, plus a
 * title made of the first few words of the question. Both get blanked on the
 * same schedule, on `platform in ('shopify','discord')` — a question typed at the
 * bot is as private as a bubble question (Brad's decision, 2026-09-10 evening).
 * YouTube stays: those transcripts are public comments, kept with no deletion
 * date, as are the replied-to rows in `youtube_bot_log` (its cleanup trims only
 * skipped rows past the latest 200). The shape of the conversation survives: id, role, timestamps,
 * model, token counts, `is_fallback`, `failure_mode`. Only the words go.
 *
 * Same shape as the other crons (trending, reminder v2): hourly setInterval, a
 * `< target hour` catch-up check so a deploy can't skip the day, and the
 * shared `cron_lock` row so only one machine runs it (both Fly apps share this
 * Supabase project).
 */
import * as Sentry from '@sentry/react-router';
import { supabaseAdmin, tryAcquireCronLock } from './supabase.server';
import { scrubQuestion, SCRUB_TIMEOUT_MS } from './chat-question-scrub.server';
import { withTimeout } from './cron-helpers.server';
import { recordServerEvent } from './product-events.server';

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

/** The archive step's whole run (US-15 AC44): scrubs plus the one insert. */
const ARCHIVE_BUDGET_MS = 5 * 60_000;
/** Kept back from the scrubs for the conversation check and the insert, so a
 *  budget spent on scrubbing never throws away what was scrubbed. */
const ARCHIVE_WRITE_RESERVE_MS = 20_000;
/** Questions held in memory per run; past it they count as skipped. */
export const ARCHIVE_MAX_QUESTIONS = 200;
/** Web chat surfaces and labels whose questions are copied (US-15 AC44). */
const ARCHIVED_PLATFORMS = ['shopify', 'widget'];
const ARCHIVED_CLASSIFICATIONS = ['ROUTE', 'MEASUREMENT'];

/** The archive step's counts. Working means eligible = kept + skipped. */
export interface ArchiveCounts {
  eligible: number;
  kept: number;
  skipped: number;
}

/** What one run cleared, per table, and what it archived. Counts, never text. */
export interface PurgeCounts {
  matchEvents: number;
  messages: number;
  conversations: number;
  /** Null when the archive is switched off. */
  archive: ArchiveCounts | null;
}

/** A question read before its row is blanked, held in memory until the scrub.
 *  The conversation id (shopify only) is for the deleted-conversation check,
 *  never stored. */
interface PendingQuestion {
  platform: string;
  week: string;
  text: string;
  conversationId: string | null;
}

/** The run's held questions, and how many qualified (the cap's excess included). */
interface Held {
  questions: PendingQuestion[];
  eligible: number;
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
  if (!supabaseAdmin) return { matchEvents: 0, messages: 0, conversations: 0, archive: null };
  const cutoff = new Date(now.getTime() - PURGE_AFTER_DAYS * 86400_000).toISOString();
  // US-15 AC44 ships off: no question text is even selected until Brad switches it on.
  const held: Held | null = process.env.CHAT_QUESTION_ARCHIVE === 'on' ? { questions: [], eligible: 0 } : null;
  const counts = {
    matchEvents: await purgeMatchEvents(cutoff, held),
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
  // Only now, with every pass done: nothing here can delay or undo the purge.
  return { ...counts, archive: held && (await archiveQuestions(held)) };
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

/** Any of the three still holding text: rows purged before `router_raw`
 *  came into scope have a null `message` already. */
const HOLDS_TEXT = 'message.not.is.null,router_raw.not.is.null,router_error.not.is.null';

interface MatchEventRow {
  id: string;
  router_context: Record<string, unknown> | null;
  created_at?: string;
  message?: string | null;
  classification?: string | null;
  conversation_id?: string | null;
}

/**
 * Clear a batch of match events. Per row, because `router_context` differs per
 * row and a single UPDATE cannot subtract keys from each one's own JSON. Every
 * field goes in the same statement, so a row can never be left half-cleared,
 * which is what makes the HOLDS_TEXT filter complete.
 */
async function clearMatchEventRows(rows: MatchEventRow[]): Promise<Fallible> {
  for (const row of rows) {
    const context = { ...row.router_context };
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
}

/** With the archive on, the question and what decides whether it is copied. */
const HELD_COLUMNS = 'id, router_context, created_at, message, classification, conversation_id';

function purgeMatchEvents(cutoff: string, held: Held | null): Promise<number> {
  return purgeInBatches(
    'chat text',
    () =>
      supabaseAdmin!
        .from('chat_match_events')
        .select(held ? HELD_COLUMNS : 'id, router_context')
        .lt('created_at', cutoff)
        .or(HOLDS_TEXT)
        .returns<MatchEventRow[]>()
        .limit(BATCH_SIZE),
    (rows: MatchEventRow[]) => {
      if (held) holdQuestions(rows, held);
      return clearMatchEventRows(rows);
    },
  );
}

/**
 * US-15 AC44: read the copyable questions out of a batch about to be blanked.
 * The row's own question only, never `first` or `recent`, so each question is
 * read at most once, from its own row. Past the cap a question still counts.
 */
function holdQuestions(rows: MatchEventRow[], held: Held): void {
  for (const row of rows) {
    const platform = row.router_context?.platform;
    if (
      typeof platform !== 'string' || !ARCHIVED_PLATFORMS.includes(platform) ||
      !row.classification || !ARCHIVED_CLASSIFICATIONS.includes(row.classification) ||
      !row.message || !row.created_at
    ) continue;
    held.eligible++;
    if (held.questions.length < ARCHIVE_MAX_QUESTIONS) {
      held.questions.push({ platform, week: mondayOf(row.created_at), text: row.message, conversationId: row.conversation_id ?? null });
    }
  }
}

/**
 * The chat DELETE's half of US-15 AC44: blank one conversation's match events
 * now, so a deleted conversation is never copied. The caller has already
 * checked the conversation is this user's; the filter names the user too.
 * Returns how many rows it cleared. Throws on a database error.
 */
export function clearConversationMatchEvents(conversationId: string, userId: string): Promise<number> {
  if (!supabaseAdmin) return Promise.resolve(0);
  return purgeInBatches(
    'deleted chat text',
    () =>
      supabaseAdmin!
        .from('chat_match_events')
        .select('id, router_context')
        .eq('conversation_id', conversationId)
        .eq('user_id', userId)
        .or(HOLDS_TEXT)
        .limit(BATCH_SIZE),
    clearMatchEventRows,
  );
}

/** The Monday (UTC) of the week an ISO time falls in, as YYYY-MM-DD. */
function mondayOf(iso: string): string {
  const day = new Date(iso);
  day.setUTCDate(day.getUTCDate() - ((day.getUTCDay() + 6) % 7));
  return day.toISOString().slice(0, 10);
}

/** Fisher-Yates, so the batch's order says nothing about the rows' order. */
function shuffle<T>(items: T[]): T[] {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
}

/**
 * The shopify questions whose conversation still exists, plus every widget
 * question (the widget keeps no conversation here). Covers a DELETE during
 * the scrub, one racing the match-event insert, and a failed blank. A
 * question with no conversation id is dropped. Throws on a database error.
 */
async function withLiveConversations(items: ScrubbedQuestion[]): Promise<ScrubbedQuestion[]> {
  const ids = [...new Set(items.flatMap((q) => (q.conversationId ? [q.conversationId] : [])))];
  let live = new Set<string>();
  if (ids.length) {
    const { data, error } = await supabaseAdmin!.from('chat_conversations').select('id').in('id', ids).limit(ids.length);
    if (error) throw new Error('conversation check failed');
    live = new Set((data ?? []).map((r: { id: string }) => r.id));
  }
  return items.filter((q) => q.platform !== 'shopify' || (q.conversationId !== null && live.has(q.conversationId)));
}

type ScrubbedQuestion = PendingQuestion & { question: string };

/**
 * US-15 AC44: scrub each held question and insert the kept ones in one
 * shuffled batch. Sequential at this volume, inside a 5-minute budget that
 * each call and the final writes take their time from (the deadline pattern of
 * `extractOrClassify`); a question the budget never reached is a skip, as is
 * one past the cap. Never throws, and reports counts only: never the text,
 * never a database error's details or hint.
 */
async function archiveQuestions({ questions, eligible }: Held): Promise<ArchiveCounts> {
  const counts = (kept: number) => ({ eligible, kept, skipped: eligible - kept });
  if (!questions.length) return counts(0);
  const until = Date.now() + ARCHIVE_BUDGET_MS;
  const left = () => until - Date.now();
  try {
    const scrubbed: ScrubbedQuestion[] = [];
    for (const q of questions) {
      const scrubTime = left() - ARCHIVE_WRITE_RESERVE_MS;
      if (scrubTime <= 0) break;
      const timeoutMs = Math.min(SCRUB_TIMEOUT_MS, scrubTime);
      // The call aborts itself at timeoutMs; the outer limit holds even if it never settles.
      const out = await withTimeout(scrubQuestion(q.text, { timeoutMs }), timeoutMs + 1_000, 'archive scrub').catch(() => null);
      if (out) scrubbed.push({ ...q, question: out });
    }
    // Immediately before the insert, so a DELETE during the scrub still counts.
    const live = await withTimeout(withLiveConversations(scrubbed), Math.max(left(), 1), 'archive conversation check');
    if (!live.length) return counts(0);
    const rows = shuffle(live.map(({ platform, week, question }) => ({ platform, week, question })));
    // No time limit on the insert: a write cut off by a timer can still commit, and the counts must say what landed.
    const { error } = await supabaseAdmin!.from('chat_question_archive').insert(rows);
    if (error) {
      reportArchiveFailure('insert');
      return counts(0);
    }
    return counts(rows.length);
  } catch {
    reportArchiveFailure('error');
    return counts(0);
  }
}

/** A fixed message and a stage word: the error itself may quote a question. */
function reportArchiveFailure(stage: 'insert' | 'error'): void {
  console.error(`Chat question archive failed (${stage})`);
  Sentry.captureMessage('Chat question archive failed', {
    level: 'warning',
    tags: { feature: 'chat_question_archive', stage },
  });
}

/** The day's work, behind the shared lock. Returns null if another machine
 *  won the day. Exported for the test suite. */
export async function purgeWithLock(todayStr: string, now: Date = new Date()): Promise<PurgeCounts | null> {
  const acquired = await tryAcquireCronLock(MACHINE_ID, todayStr, 'chat_text_purge');
  if (!acquired) return null;
  const cleared = await purgeOldChatText(now);
  const { archive } = cleared;
  console.log(
    `Chat text purge (older than ${PURGE_AFTER_DAYS} days): ${cleared.matchEvents} match events, ` +
      `${cleared.messages} messages, ${cleared.conversations} conversation titles; ` +
      (archive
        ? `questions archived: ${archive.eligible} eligible, ${archive.kept} kept, ${archive.skipped} skipped`
        : 'question archive off'),
  );
  if (archive) await recordServerEvent('chat_question_archived', { ...archive });
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
