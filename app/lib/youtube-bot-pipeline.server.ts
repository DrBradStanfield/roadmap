/**
 * YouTube comment auto-replier: the per-comment decisions. Top-level filters,
 * the follow-up gates and thread history, and the chat pipeline (classifier,
 * conditional router, main LLM). Split out of youtube-bot.server.ts (issue
 * #429), which re-exports its public names.
 */
import * as Sentry from '@sentry/react-router';
import { classifyMessage, isUnreadableAnswer, shouldFireRouter } from './chat-classifier.server';
import { routeQuery, sanitizeForRouter, type RouterResult } from './chat-router.server';
import { SILENT_ON_YOUTUBE } from '../../packages/health-core/src/models';
import { findBlogByVideoId, loadBlogIndex, type BlogIndexEntry } from './blog-index.server';
import { preferMasters } from './router-view';
import { loadBlogArticle } from './matched-content';
import { stripFrontmatter } from './frontmatter';
import { buildYouTubePlatformContext, loadedHandles } from './youtube-context';
import {
  buildSystemBlocks,
  buildConversationMessages,
  getChatCompletion,
  reportChatFallback,
  loadMatchedArticlesFromHandles,
  DOCTOR_POSTURE,
  type ChatCompletionResult,
} from './chat.server';
import {
  CHANNEL_ID,
  COMMENT_MAX_AGE_DAYS,
  MIN_WORDS,
  FOLLOWUP_MIN_WORDS,
  CRISIS,
  MAX_CHANNEL_REPLIES_PER_THREAD,
} from './youtube-bot-config.server';
import type { YouTubeThread, YouTubeReply } from './youtube-bot-api.server';

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

interface FilterResult {
  pass: boolean;
  reason?: string;
}

function wordCount(text: string): number {
  return text.trim().split(/\s+/).length;
}

function ageInDays(publishedAt: string): number {
  return (Date.now() - new Date(publishedAt).getTime()) / (24 * 60 * 60_000);
}

/** The video's companion blog post + its body (frontmatter stripped), or null
 *  when the video has no linked article or the file is unreadable. */
export function loadVideoBody(videoId: string): { entry: BlogIndexEntry; body: string } | null {
  const entry = findBlogByVideoId(videoId);
  if (!entry) return null;
  const fullContent = loadBlogArticle(entry.handle);
  if (!fullContent) return null;
  return { entry, body: stripFrontmatter(fullContent) };
}

/** The comment's word count when it is under the floor, or null when it may go on.
 *  A short crisis or emergency comment always goes on, top-level or follow-up, so it
 *  gets the chat's emergency reply (US-15 AC39 review N5, AC56). */
function belowWordFloor(text: string, floor: number): number | null {
  const words = wordCount(text);
  return words < floor && !CRISIS.test(text) ? words : null;
}

export function filterThread(thread: YouTubeThread): FilterResult {
  if (thread.canReply === false) return { pass: false, reason: 'cannot reply' };
  if (!thread.text || !thread.text.trim()) return { pass: false, reason: 'empty' };
  const words = belowWordFloor(thread.text, MIN_WORDS);
  if (words !== null) return { pass: false, reason: `too short (${words} words)` };

  // Don't reply to Brad's own comments
  if (thread.authorChannelId && CHANNEL_ID && thread.authorChannelId === CHANNEL_ID) {
    return { pass: false, reason: "Brad's own comment" };
  }

  // Stale comments — don't dig up old ones on first launch / after downtime
  if (ageInDays(thread.publishedAt) > COMMENT_MAX_AGE_DAYS) {
    return { pass: false, reason: `older than ${COMMENT_MAX_AGE_DAYS} days` };
  }

  return { pass: true };
}

// ---------------------------------------------------------------------------
// Follow-up replies (multi-turn) — three gates, decided 2026-08-10 with Brad:
//   1. Addressee: only replies directed at the bot — the thread's original
//      author continuing after our reply, or an explicit @our-handle mention
//      (YouTube auto-inserts it when someone taps Reply on our reply). Other
//      users talking to each other are never interrupted.
//   2. Brad-engaged exit: any channel-authored reply we didn't post means Brad
//      is personally in the thread — the bot leaves it to him, permanently.
//   3. Hard cap: MAX_CHANNEL_REPLIES_PER_THREAD channel replies per thread
//      (initial + one follow-up), regardless of quality — the screenshot-risk
//      control. Hostile/bait follow-ups additionally die in the pipeline
//      (classifier skip or SKIP_NO_REPLY with the follow-up posture block).
// ---------------------------------------------------------------------------

/** The same hygiene gates as a top-level comment, with the shorter follow-up word
 *  floor: the gate's name when the follow-up is skipped, or null. */
function followUpHygiene(reply: YouTubeReply): 'stale' | 'too-short' | null {
  if (ageInDays(reply.publishedAt) > COMMENT_MAX_AGE_DAYS) return 'stale';
  if (belowWordFloor(reply.text, FOLLOWUP_MIN_WORDS) !== null) return 'too-short';
  return null;
}

type FollowUpDecision = { skip: string } | { candidate: YouTubeReply };

export function assessThreadFollowUp(p: {
  replies: YouTubeReply[];       // full reply list, oldest-first
  botPostedIds: Set<string>;     // comment IDs the bot itself posted
  channelId: string;
  originalAuthor: string;        // display name of the thread's top-level author
  channelHandle: string | null;  // "@handle", or null when unknown
}): FollowUpDecision {
  const channelReplies = p.replies.filter(r => r.authorChannelId === p.channelId);

  if (channelReplies.some(r => !p.botPostedIds.has(r.id))) return { skip: 'brad-engaged' };
  if (channelReplies.length === 0) return { skip: 'no-bot-reply-visible' };
  if (channelReplies.length >= MAX_CHANNEL_REPLIES_PER_THREAD) return { skip: 'thread-cap' };

  const lastBotTime = channelReplies[channelReplies.length - 1].publishedAt;
  const handle = p.channelHandle?.toLowerCase();
  const candidates = p.replies.filter(r =>
    r.authorChannelId !== p.channelId &&
    r.publishedAt > lastBotTime &&
    (r.authorDisplayName === p.originalAuthor ||
      (handle ? r.text.trim().toLowerCase().startsWith(handle) : false)),
  );
  if (candidates.length === 0) return { skip: 'no-addressed-followup' };

  // The oldest that passes the hygiene gates, one follow-up per thread per tick. A short
  // or stale reply is passed over, so a later crisis reply in the thread is still seen (AC56).
  const passing = candidates.find(r => followUpHygiene(r) === null);
  return passing ? { candidate: passing } : { skip: followUpHygiene(candidates[0])! };
}

/** Rebuild the thread as chat history for the main LLM: top-level comment,
 *  then every reply before the candidate — bot turns as assistant, viewer
 *  turns as user (name-prefixed). Consecutive viewer turns are merged so a
 *  multi-comment aside reads as one turn (the trailing candidate is appended
 *  separately by buildConversationMessages and may still follow a user turn). */
export function buildThreadHistory(
  original: { author: string; text: string },
  replies: YouTubeReply[],
  channelId: string,
  candidateId: string,
): Array<{ role: 'user' | 'assistant'; content: string }> {
  const turns: Array<{ role: 'user' | 'assistant'; content: string }> = [
    { role: 'user', content: `${original.author}: ${original.text}` },
  ];
  for (const r of replies) {
    if (r.id === candidateId) break;
    turns.push(
      r.authorChannelId === channelId
        ? { role: 'assistant', content: r.text }
        : { role: 'user', content: `${r.authorDisplayName}: ${r.text}` },
    );
  }
  return turns.reduce<typeof turns>((merged, t) => {
    const prev = merged[merged.length - 1];
    if (prev && prev.role === t.role) prev.content += `\n\n${t.content}`;
    else merged.push({ ...t });
    return merged;
  }, []);
}

// ---------------------------------------------------------------------------
// Pipeline — classifier → conditional router → main LLM
// ---------------------------------------------------------------------------

export interface PipelineOutcome {
  posted: boolean;
  skipReason?: string;
  classification?: string;
  routerHandles?: string[];
  /** US-50 AC14: router picks replaced by their masters, and masters loaded reduced. */
  replaced?: string[];
  reduced?: string[];
  replyText?: string;
  /**
   * Telemetry for persistYouTubeTurn(). Previously all of this was computed and
   * then thrown away, which is why YouTube had no auditable/trainable record —
   * see the comment on persistYouTubeTurn().
   */
  routerResult?: RouterResult | null;
  routerSkipped?: boolean;
  /** The main LLM's result, its raw output INCLUDING 'SKIP_NO_REPLY' or a failed
   *  turn's fixed line. Absent if no LLM call happened. */
  completion?: ChatCompletionResult;
  isFallback?: boolean;
  failureMode?: string;
}

/**
 * How the main answer ends a turn. A fallback is transient (shouldUnclaim);
 * a refusal is a decision (US-15 AC15): unclaiming it would, by the code,
 * re-run the same comment every tick for up to 7 days, three model calls each
 * time. A refusal sends the web chat's bounded Sentry warning.
 */
export function completionOutcome(completion: ChatCompletionResult, latencyMs: number): Pick<PipelineOutcome, 'posted' | 'skipReason' | 'isFallback' | 'failureMode' | 'replyText'> {
  if (completion.isRefusal) {
    reportChatFallback({ completion, platform: 'youtube', latencyMs });
    return { posted: false, skipReason: `main-LLM refusal (${completion.refusalCategory ?? 'other'})`, failureMode: 'refusal' };
  }
  if (completion.isFallback) {
    const failureMode = completion.failureMode ?? 'unknown';
    tickFallbacks.set(failureMode, (tickFallbacks.get(failureMode) ?? 0) + 1);
    return { posted: false, skipReason: `main-LLM failure (${failureMode})`, isFallback: true, failureMode };
  }
  const replyText = completion.content.trim();
  // SKIP_NO_REPLY is still a real, deliberate model decision — worth keeping as training signal.
  if (replyText === 'SKIP_NO_REPLY') return { posted: false, skipReason: 'main-LLM returned SKIP_NO_REPLY' };
  return { posted: true, replyText };
}

/** Main-LLM fallbacks this tick, by failure mode (US-15 AC58). Ticks never overlap (runTick). */
const tickFallbacks = new Map<string, number>();

/**
 * One bounded Sentry warning for the tick's main-LLM fallbacks, then a fresh
 * count (US-15 AC58). A fallback is unclaimed and retried every tick, so an
 * alert per comment, as the web chat sends per question, would repeat for each
 * failing comment every 30 minutes; one per tick is at most 48 a day. Counts
 * and failure modes only, never a comment or a reply.
 */
export function reportTickFallbacks(): void {
  if (tickFallbacks.size === 0) return;
  const byMode = Object.fromEntries(tickFallbacks);
  tickFallbacks.clear();
  const count = Object.values(byMode).reduce((a, b) => a + b, 0);
  Sentry.captureMessage('YouTube bot: main-LLM fallbacks this tick', {
    level: 'warning', tags: { feature: 'youtube-bot', subsystem: 'main-llm', platform: 'youtube' }, extra: { count, byMode },
  });
}

/** Only a main-LLM failure is retried next tick; skips, silent classifier skips and refusals keep the claim. */
export function shouldUnclaim(outcome: Pick<PipelineOutcome, 'isFallback'>): boolean {
  return outcome.isFallback === true;
}

/** Exported for tests. */
export async function runPipeline(
  thread: YouTubeThread,
  entry: BlogIndexEntry,
  body: string,
  history: Array<{ role: 'user' | 'assistant'; content: string }> = [],
): Promise<PipelineOutcome> {
  const sanitized = sanitizeForRouter(thread.text);
  const isFollowUp = history.length > 0;

  const classifierResult = await classifyMessage(sanitized);
  const { classification } = classifierResult;
  const unreadable = isUnreadableAnswer(classifierResult);
  if (SILENT_ON_YOUTUBE.has(classification) || unreadable) {
    return {
      posted: false,
      // 'refusal' or 'unparseable' only; the raw model text stays out of the reason.
      skipReason: unreadable ? `classifier=ERROR (${classifierResult.error!.split(':')[0]})` : `classifier=${classification}`,
      classification,
      routerHandles: [],
      routerResult: null,
      routerSkipped: true,
    };
  }

  let routerHandles: string[] = [];
  let routerResult: RouterResult | null = null;
  const routerSkipped = !shouldFireRouter(classifierResult);
  if (!routerSkipped) {
    routerResult = await routeQuery(sanitized);
    routerHandles = routerResult.handles;
  }

  // US-50 AC14: an older post gives way to its topic masters, unless it is
  // this video's own post or the comment gives its URL or handle.
  const index = loadBlogIndex();
  const routed = routerResult ? preferMasters(routerHandles, index, thread.text, { keep: [entry.handle] }) : { handles: [], replaced: [] };
  const matched = loadMatchedArticlesFromHandles(routed.handles);
  const blogArticles = matched?.content ?? null;
  // Master views skip only masters that actually loaded, not ones the cap skipped (US-50 AC6).
  const platformContext = buildYouTubePlatformContext(thread.videoId, entry, body, loadedHandles(routed.handles, matched), isFollowUp);
  // YouTube is a doctor-family surface (Brad's public channel) → strict doctor posture.
  const systemBlocks = buildSystemBlocks(platformContext, { surfaceContext: DOCTOR_POSTURE, blogArticles });
  const conversationMessages = buildConversationMessages(history, thread.text);
  const tBeforeLlm = Date.now();
  // No form here to apply an edit to, so no tools (US-15 AC19).
  const completion = await getChatCompletion(systemBlocks, conversationMessages, false);

  return {
    classification: classifierResult.classification,
    routerHandles,
    replaced: routed.replaced,
    reduced: matched?.reduced,
    routerResult,
    routerSkipped,
    completion,
    ...completionOutcome(completion, Date.now() - tBeforeLlm),
  };
}
