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
 * Once a web chat question's blank has landed (`shopify` or `widget`, classified
 * `ROUTE` or `MEASUREMENT`), the run keeps a scrubbed copy of that one
 * question, with no end date, in `chat_question_archive` (US-15 AC44): the
 * question with names, places, dates, ages, contact details, ids and jobs
 * replaced, its platform, and the Monday of its week. We do not link it
 * to an account, a conversation or a session (US-15 AC44 says how it could be traced). The scrub runs only after all
 * three passes (`chat-question-archive.server.ts`); a failure there is counted, never thrown. Off unless the
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
 * shared `cron_lock` row so only one machine runs it. It starts only on
 * health-tool-app (`RUN_SHARED_CRONS`, US-28 AC8), since both Fly apps share
 * this Supabase project and the winner would run with its own app's env.
 */
import * as Sentry from '@sentry/react-router';
import { endCronLock, supabaseAdmin, tryAcquireCronLock } from './supabase.server';
import { archiveQuestions, type ArchiveCounts, type Held } from './chat-question-archive.server';
import { MACHINE_ID, MACHINE_LABEL, reportStuckRun, sharedCronsOn } from './daily-cron.server';
import { lockClock, stuckLimitMs, transition, type CronDay } from './cron-day';
import { recordServerEvent } from './product-events.server';
import { safeErrorFields } from './safe-error-fields.server';

const CRON_INTERVAL_MS = 60 * 60 * 1000;
const TARGET_HOUR_UTC = 4;

/** How long the question and the router's answer stay readable for the audit. */
export const PURGE_AFTER_DAYS = 30;
/** Rows cleared per round trip. The loop re-selects until nothing is left. 100 ids keep the
 *  update's URL near 3.7 KB, under common gateway limits (US-15 AC51). */
const BATCH_SIZE = 100;
/** Stuck ids a pass's select may skip (US-15 AC61). They ride in its URL: at 100 ids near 3.7 KB
 *  (AC51), 150 stay near 6.1 KB once URL-encoded, under the common 8 KB request-line limit. Past it the pass ends. */
const STUCK_SKIP_MAX = 150;

/** Platforms whose transcripts are private text on a 30-day clock. YouTube is
 *  absent on purpose: those turns are public comments. */
export const PURGED_PLATFORMS = ['shopify', 'discord'];

/** What a reader sees where a purged message used to be. The row is still
 *  there — the words are not. Anything rendering a transcript substitutes it. */
export const PURGED_TEXT = '[removed after 30 days]';

/** Questions held in memory per run; past it they count as skipped. */
export const ARCHIVE_MAX_QUESTIONS = 200;
/** Web chat surfaces and labels whose questions are copied (US-15 AC44). */
export const ARCHIVED_PLATFORMS = ['shopify', 'widget'];
const ARCHIVED_CLASSIFICATIONS = ['ROUTE', 'MEASUREMENT'];

/** What one run cleared, per table, and what it archived. Counts, never text. */
export interface PurgeCounts {
  matchEvents: number;
  messages: number;
  conversations: number;
  /** Null when the archive is switched off. */
  archive: ArchiveCounts | null;
  /** Rows selected again after their blank was sent (US-15 AC60): text past its window. */
  didNotBlank: number;
}

let day: CronDay = { phase: 'open' };
let cronIntervalId: ReturnType<typeof setInterval> | null = null;

/** The question keys. Everything else in `router_context` (the surface name,
 *  YouTube's video and comment ids) is not a question and stays. */
const QUESTION_KEYS = ['first', 'recent'];

/**
 * Clear the free text from every row older than the window, in all three
 * tables. Returns how many rows each pass cleared — counts, never the text.
 * Throws on a database error so the caller's catch reports it instead of
 * logging a clean run. A row that will not blank does not throw: its pass
 * ends, the rest of the run goes on, and the count is reported (US-15 AC61).
 */
export async function purgeOldChatText(now: Date = new Date()): Promise<PurgeCounts> {
  if (!supabaseAdmin) return { matchEvents: 0, messages: 0, conversations: 0, archive: null, didNotBlank: 0 };
  const cutoff = new Date(now.getTime() - PURGE_AFTER_DAYS * 86400_000).toISOString();
  // US-15 AC44 ships off: no question text is even selected until Brad switches it on.
  const held: Held | null = process.env.CHAT_QUESTION_ARCHIVE === 'on' ? { questions: [], eligible: 0, ids: new Set() } : null;
  // Ids selected again after their blank was sent; in memory for this run only, never stored or sent.
  const stuck: Stuck = { ids: new Set(), capReached: false };
  const end = { onNoProgress: 'end', stuck } as const;
  let counts;
  try {
    counts = {
      matchEvents: await purgeMatchEvents(cutoff, held, end),
      // `!inner` makes the join a filter: a message qualifies only if its own
      // conversation is on a purged platform. Without it PostgREST would return
      // every message and merely null the embed.
      messages: await purgeInBatches(
        'chat message',
        (skip) =>
          skipping(
            supabaseAdmin!
              .from('chat_messages')
              .select('id, chat_conversations!inner(platform)')
              .in('chat_conversations.platform', PURGED_PLATFORMS)
              .lt('created_at', cutoff)
              .not('content', 'is', null),
            skip,
          ).limit(BATCH_SIZE),
        (rows) => supabaseAdmin!.from('chat_messages').update({ content: null }).in('id', rows.map((r) => r.id)),
        end,
      ),
      // The title is the first words of the question, so it is question text.
      // `updated_at` is the conversation's own clock: a thread stays readable
      // for 30 days after its last turn, not after its first.
      conversations: await purgeInBatches(
        'chat title',
        (skip) =>
          skipping(
            supabaseAdmin!
              .from('chat_conversations')
              .select('id')
              .in('platform', PURGED_PLATFORMS)
              .lt('updated_at', cutoff)
              .not('title', 'is', null),
            skip,
          ).limit(BATCH_SIZE),
        (rows) => supabaseAdmin!.from('chat_conversations').update({ title: null }).in('id', rows.map((r) => r.id)),
        end,
      ),
    };
  } finally {
    // Once per run, a thrown run included: a count, never an id or the text.
    if (stuck.ids.size) reportDidNotBlank(stuck);
  }
  // Only now, with every pass done: nothing here can delay or undo the purge.
  return { ...counts, archive: held && (await archiveQuestions(held)), didNotBlank: stuck.ids.size };
}

/** US-15 AC60, AC61: a row that came back after its blank was sent holds text past its window; a person must look.
 *  `stuck_cap_reached` says a pass ended at STUCK_SKIP_MAX, so rows behind the stuck ones may be unreached. */
function reportDidNotBlank({ ids, capReached }: Stuck): void {
  Sentry.captureMessage('Chat text purge: rows did not blank', {
    level: 'error',
    tags: { feature: 'chat_text_purge', stuck_rows: ids.size, ...(capReached && { stuck_cap_reached: true }) },
  });
}

/** What the daily passes collect about rows that will not blank. In memory for this run only. */
interface Stuck {
  ids: Set<string>;
  capReached: boolean;
}

/** What a pass does on a batch holding only rows it already sent a blank for. */
type OnNoProgress = { onNoProgress: 'end'; stuck: Stuck } | { onNoProgress: 'throw' };

/** The select without the ids given (US-15 AC61); none given, the select as it was. */
function skipping<Q extends { not: (column: 'id', operator: 'in', value: string) => unknown }>(query: Q, ids: string[]): Q {
  return ids.length ? (query.not('id', 'in', `(${ids.join(',')})`) as Q) : query;
}

interface Fallible {
  error: { message: string } | null;
}

/**
 * One table's pass: select a batch of stale rows, clear them, repeat until the
 * select comes back empty. All three passes share it, so all three share the
 * no-progress guard — a row selected again after its blank was sent did not
 * blank (a policy or trigger swallowing it), and a batch holding no new row
 * makes no progress (US-15 AC60). Ids live in memory for this pass only, never stored or sent.
 * `end` (the daily purge): rows that came back go into `stuck.ids`, and the
 * pass selects again past them, so stuck rows cannot hide the rows behind them;
 * it ends when nothing is left, or at STUCK_SKIP_MAX skipped ids (US-15 AC61).
 * `throw` (the chat DELETE): a user's explicit delete must fail loudly to its
 * caller, which reports it.
 */
async function purgeInBatches<T extends { id: string }>(
  label: string,
  stale: (skip: string[]) => PromiseLike<Fallible & { data: T[] | null }>,
  clear: (rows: T[]) => PromiseLike<Fallible>,
  mode: OnNoProgress,
): Promise<number> {
  let cleared = 0;
  const sent = new Set<string>();
  const skip: string[] = [];
  for (;;) {
    const { data, error } = await stale(skip);
    if (error) throw new Error(`${label} purge select failed: ${error.message}`);
    if (!data?.length) return cleared;
    const back = data.filter((r) => sent.has(r.id));
    if (mode.onNoProgress === 'end') for (const r of back) mode.stuck.ids.add(r.id);
    if (back.length === data.length) {
      if (mode.onNoProgress === 'throw') throw new Error(`${label} purge made no progress`);
      // Skipped rows are never selected again, so every row here is new to `skip`.
      if (skip.length + back.length > STUCK_SKIP_MAX) {
        mode.stuck.capReached = true;
        return cleared;
      }
      skip.push(...back.map((r) => r.id));
      continue;
    }
    for (const r of data) sent.add(r.id);

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

function purgeMatchEvents(cutoff: string, held: Held | null, mode: OnNoProgress): Promise<number> {
  return purgeInBatches(
    'chat text',
    (skip) =>
      skipping(
        supabaseAdmin!
          .from('chat_match_events')
          .select(held ? HELD_COLUMNS : 'id, router_context')
          .lt('created_at', cutoff)
          .or(HOLDS_TEXT),
        skip,
      )
        .returns<MatchEventRow[]>()
        .limit(BATCH_SIZE),
    async (rows: MatchEventRow[]) => {
      const cleared = await clearMatchEventRows(rows);
      return held && !cleared.error ? holdBlanked(rows, held) : cleared;
    },
    mode,
  );
}

/**
 * US-15 AC61: hold only the questions whose blank landed. A per-row update can
 * match nothing with no error, so a separate select of the batch's ids finds
 * the rows that exist and now hold no text, and only those are held. A row
 * still holding text is held on the day it finally blanks; a row another
 * writer deleted is never held. Only with the archive on, so an off run pays nothing.
 */
async function holdBlanked(rows: MatchEventRow[], held: Held): Promise<Fallible> {
  const { data, error } = await supabaseAdmin!
    .from('chat_match_events')
    .select('id')
    .in('id', rows.map((r) => r.id))
    .is('message', null)
    .is('router_raw', null)
    .is('router_error', null)
    .limit(rows.length);
  if (error) return { error };
  const blank = new Set((data ?? []).map((r: { id: string }) => r.id));
  holdQuestions(rows.filter((r) => blank.has(r.id)), held);
  return { error: null };
}

/**
 * US-15 AC44: read the copyable questions out of a batch whose blank landed.
 * The row's own question only, never `first` or `recent`, so each question is
 * read at most once, from its own row. Past the cap a question still counts.
 */
function holdQuestions(rows: MatchEventRow[], held: Held): void {
  for (const row of rows) {
    if (held.ids.has(row.id)) continue;
    held.ids.add(row.id);
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
    { onNoProgress: 'throw' },
  );
}

/** The Monday (UTC) of the week an ISO time falls in, as YYYY-MM-DD. */
function mondayOf(iso: string): string {
  const day = new Date(iso);
  day.setUTCDate(day.getUTCDate() - ((day.getUTCDay() + 6) % 7));
  return day.toISOString().slice(0, 10);
}

/** The day's work, behind the shared lock. Returns the lock's answer,
 *  'closed' or 'busy', if the day is not this machine's now. Its end, finished
 *  or failed, is written to the lock row (US-28 AC9). Exported for the test suite. */
export async function purgeWithLock(todayStr: string, now: Date = new Date()): Promise<PurgeCounts | 'closed' | 'busy'> {
  const lock = await tryAcquireCronLock(MACHINE_ID, todayStr, 'chat_text_purge', lockClock('chat_text_purge', now));
  if (lock !== 'won') return lock;
  // The acquire wrote `now` as locked_at; the end writes match it.
  const cleared = await purgeOldChatText(now).catch(async (runError: unknown) => {
    await endCronLock(MACHINE_ID, todayStr, 'chat_text_purge', now, 'failed', new Date());
    throw runError;
  });
  await endCronLock(MACHINE_ID, todayStr, 'chat_text_purge', now, 'finished', new Date());
  const { archive } = cleared;
  console.log(
    `Chat text purge (older than ${PURGE_AFTER_DAYS} days): ${cleared.matchEvents} match events, ` +
      `${cleared.messages} messages, ${cleared.conversations} conversation titles; ` +
      (archive
        ? `questions archived: ${archive.eligible} eligible, ${archive.kept} kept, ${archive.skipped} skipped`
        : 'question archive off') +
      `; ${cleared.didNotBlank} rows did not blank`,
  );
  if (archive) await recordServerEvent('chat_question_archived', { ...archive });
  return cleared;
}

export function startChatPurgeCron(): void {
  if (process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test') {
    console.log(`Chat text purge cron disabled in ${process.env.NODE_ENV}`);
    return;
  }
  if (!sharedCronsOn()) return;

  console.log(`Chat text purge cron started (first tick ≥ ${TARGET_HOUR_UTC}:00 UTC daily, machine: ${MACHINE_LABEL})`);

  cronIntervalId = setInterval(async () => {
    try {
      const now = new Date();
      const todayStr = now.toISOString().slice(0, 10);
      const step = transition(day, { type: 'tick', today: todayStr, now: now.getTime(), limitMs: stuckLimitMs('chat_text_purge') });
      day = step.day;
      if (step.decision === 'skip-and-report-stuck' && day.phase === 'running') {
        reportStuckRun('Chat text purge cron', 'chat_text_purge_cron', day.startedAt, now.getTime());
      }
      if (step.decision !== 'try' || now.getUTCHours() < TARGET_HOUR_UTC) return;

      // Running while the purge goes, so one that outlasts the hour, or
      // midnight, is not started twice on this machine; a throw (a lock error
      // included, US-28 AC2) opens the day, so the next tick retries. A closed
      // lock marks the day done (US-28 AC7); a busy one reopens it (AC9).
      day = transition(day, { type: 'started', date: todayStr, now: now.getTime() }).day;
      const outcome = await purgeWithLock(todayStr, now).catch((runError: unknown) => {
        day = transition(day, { type: 'failed' }).day;
        throw runError;
      });
      day = transition(
        day,
        outcome === 'busy' ? { type: 'busy' } : outcome === 'closed' ? { type: 'held', date: todayStr } : { type: 'finished' },
      ).day;
    } catch (error) {
      console.error('Chat text purge cron error:', safeErrorFields(error));
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
