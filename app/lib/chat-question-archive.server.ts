/**
 * The chat purge's archive step (US-15 AC44), split out of
 * `chat-purge-cron.server.ts` (US-15 AC61, file budget): scrub the questions
 * the purge held once their rows blanked, drop any whose conversation is gone,
 * and insert the rest in one shuffled batch. Counts only, never the text.
 */
import * as Sentry from '@sentry/react-router';
import { supabaseAdmin } from './supabase.server';
import { scrubQuestion, SCRUB_TIMEOUT_MS } from './chat-question-scrub.server';
import { withTimeout } from './cron-helpers.server';

/** The archive step's whole run (US-15 AC44): scrubs plus the one insert. */
const ARCHIVE_BUDGET_MS = 5 * 60_000;
/** Kept back from the scrubs for the conversation check and the insert, so a
 *  budget spent on scrubbing never throws away what was scrubbed. */
const ARCHIVE_WRITE_RESERVE_MS = 20_000;

/** The archive step's counts. Working means eligible = kept + skipped. */
export interface ArchiveCounts {
  eligible: number;
  kept: number;
  skipped: number;
}

/** A question whose row's blank has landed, held in memory until the scrub.
 *  The conversation id (shopify only) is for the deleted-conversation check,
 *  never stored. */
interface PendingQuestion {
  platform: string;
  week: string;
  text: string;
  conversationId: string | null;
}

/** The run's held questions, and how many qualified (the cap's excess included). */
export interface Held {
  questions: PendingQuestion[];
  eligible: number;
  /** Row ids already held, so a row selected again is held once (US-15 AC60).
   *  In memory for this run only: never stored, never sent, so it can never
   *  link a kept copy to its row. */
  ids: Set<string>;
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
export async function archiveQuestions({ questions, eligible }: Held): Promise<ArchiveCounts> {
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
