/**
 * Chat feature — context assembly, daily limit check, system prompt construction.
 *
 * Grounded in health_roadmap_algorithm.md and evidence.ts.
 * Health data is local-first (v2): the client sends the user's plan as
 * `guestInputs` with every message — the server holds no health data at all.
 */
import * as Sentry from '@sentry/react-router';
import fs from 'fs';
import path from 'path';
import { loadBlogIndex, type BlogIndexEntry } from './blog-index.server';
import { loadBlogArticle, loadMatchedContent } from './matched-content';
import { SUGGESTION_EVIDENCE } from '../../packages/health-core/src/evidence';
import { buildChatContextJson } from '../../packages/health-core/src/chat-context';
import { toolOnlyAck, type ProposedEdit } from '../../packages/health-core/src/chat-edits';
import { chatToolsFor, withRoadmapRound, type ChatTurnMessage, type RoadmapRoundCounts, type ToolResultFor } from '../../packages/health-core/src/run-roadmap';
import { callAnthropicWithUsage, streamAnthropicWithUsage, isNetworkOrTimeoutError, type AnthropicStreamEvent, type AnthropicUsage } from './anthropic.server';
import { CHAT_EFFORT, CHAT_MAX_TOKENS, CHAT_MODEL, PROMPT_CACHE, modelParams, refusalLine, type RefusalCategory } from '../../packages/health-core/src/models';
import { cutText } from '../../packages/health-core/src/chat-history';
import { PRODUCTS_BLOCK_FILES, productsBlockText } from './chat-products-block';
import { PROPOSE_SUBSCRIPTION_CHANGE_TOOL, parseSubscriptionProposal, type SubscriptionProposal } from './subscription-gateway.server';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// The main answer runs on Sonnet 5.5 (CHAT_MODEL, pinned in health-core
// models.ts with every other hop); the router is Sonnet 5.5 with thinking off,
// the classifier Haiku 5.5 with thinking off.
// The 2026-08-06 audit's failures were self-check failures in the ANSWER
// (fabricated citation ids), so the answer is the hop worth the better model;
// 5.5 reasons better than Sonnet 5 at the same price and tokenizer.
//
// Request shape (modelParams; differs from Haiku, never copy between them):
//   • No `temperature`/`top_p`/`top_k`: non-default sampling params return 400.
//   • Adaptive thinking at effort medium: thinking is the self-check ("do I
//     have a DOI for this in context?"). `display: 'summarized'` lets a stream
//     show it later. `max_tokens` caps thinking plus answer together.
//   • On 5.5, text written before a tool call can come back as a `thinking`
//     block, not `text` (with `display: 'summarized'` that block carries a
//     summary; it is not empty): a form-edit turn with no `text` then shows
//     toolOnlyAck (below).
//   • A refusal returns 200 with `stop_reason: 'refusal'`: its own outcome.
// Persistence paths tag rows with CHAT_MODEL re-exported from here; never
// re-declare the string locally (Discord once did, and mislabelled its rows).
const MAX_MESSAGE_LENGTH = 8000;
const HISTORY_TOKEN_BUDGET = 8000;

// ---------------------------------------------------------------------------
// Algorithm document — read once at module load from project root
// ---------------------------------------------------------------------------

let ALGORITHM_DOC: string;
try {
  ALGORITHM_DOC = fs.readFileSync(
    path.join(process.cwd(), 'health_roadmap_algorithm.md'), 'utf-8',
  );
} catch {
  console.warn('health_roadmap_algorithm.md not found — chat will have limited context');
  ALGORITHM_DOC = '';
}

// ---------------------------------------------------------------------------
// Products document — read once at module load
// ---------------------------------------------------------------------------

let PRODUCTS_DOC: string;
try {
  PRODUCTS_DOC = fs.readFileSync(
    path.join(process.cwd(), PRODUCTS_BLOCK_FILES.products), 'utf-8',
  );
} catch {
  console.warn('docs/products.md not found — chat will not have product knowledge');
  PRODUCTS_DOC = '';
}

// ---------------------------------------------------------------------------
// Writing style + answer bank — read once at module load, synced or generated
// from claude_business (never edited here). They ride in the products block.
// Missing = every answer silently loses them, so this logs loudly.
// ---------------------------------------------------------------------------

function loadSharedDoc(file: string): string {
  try {
    return fs.readFileSync(path.join(process.cwd(), file), 'utf-8');
  } catch {
    console.error(`CHAT KNOWLEDGE MISSING: ${file} not found — the chatbot answers without it`);
    Sentry.captureMessage(`Chat knowledge file missing: ${file}`, { level: 'error' });
    return '';
  }
}

// Every surface (both websites, YouTube, Discord) gets the same block (US-15 AC29).
const PRODUCTS_BLOCK = productsBlockText({
  products: PRODUCTS_DOC,
  writingStyle: loadSharedDoc(PRODUCTS_BLOCK_FILES.writingStyle),
  answerBank: loadSharedDoc(PRODUCTS_BLOCK_FILES.answerBank),
});

// ---------------------------------------------------------------------------
// Blog article index — read once at module load
// ---------------------------------------------------------------------------

const BLOG_INDEX: BlogIndexEntry[] = loadBlogIndex();

function buildKnowledgeOverview(): string {
  if (BLOG_INDEX.length === 0) return '';
  const blogCount = BLOG_INDEX.filter(a => !a.type || a.type === 'article').length;
  const refCount = BLOG_INDEX.filter(a => a.type === 'reference').length;
  const guidelines = BLOG_INDEX.filter(a => a.type === 'guideline');

  const guidelineLines = guidelines.map(g => {
    let line = `- ${g.title}`;
    if (g.summary) {
      const words = g.summary.split(/\s+/);
      line += ` — ${words.length > 50 ? words.slice(0, 50).join(' ') + '...' : g.summary}`;
    }
    return line;
  }).join('\n');

  return `## Knowledge Base

You have access to a health knowledge base with ${BLOG_INDEX.length} entries. When the user asks about a topic, a retrieval step loads relevant content if available. You do not need to search or request content — if it's relevant, it will appear below.

### Blog & Reference Articles (${blogCount + refCount})
${blogCount} video-based articles and ${refCount} supplement reference articles covering: supplements, skin health, bone health, sleep, longevity, diet, exercise, blood pressure, cholesterol, and blood test interpretation.

### Clinical Guidelines
${guidelineLines}

If matched content appears below, use it to inform your answer. If no content is loaded for a topic, answer from the algorithm, evidence, and product knowledge above.`;
}

const KNOWLEDGE_OVERVIEW = buildKnowledgeOverview();

// ---------------------------------------------------------------------------
// Evidence document — serialized from evidence.ts at module load
// ---------------------------------------------------------------------------

function serializeEvidence(): string {
  const lines: string[] = ['# Clinical Evidence Reference\n'];
  for (const [id, ev] of Object.entries(SUGGESTION_EVIDENCE)) {
    lines.push(`## ${id}`);
    lines.push(`Reason: ${ev.reason}`);
    if (ev.guidelines.length > 0) {
      lines.push(`Guidelines: ${ev.guidelines.join(', ')}`);
    }
    for (const ref of ev.references) {
      lines.push(`- ${ref.label} (${ref.url})`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

const EVIDENCE_DOC = serializeEvidence();

// ---------------------------------------------------------------------------
// System prompt — read once at module load from app/lib/chat-system-prompt.md
// ---------------------------------------------------------------------------

let CHAT_SYSTEM_PROMPT: string;
try {
  CHAT_SYSTEM_PROMPT = fs.readFileSync(
    path.join(process.cwd(), 'app/lib/chat-system-prompt.md'), 'utf-8',
  );
} catch {
  console.warn('app/lib/chat-system-prompt.md not found — chat will have no system prompt');
  CHAT_SYSTEM_PROMPT = '';
}

// Pre-concatenate at module level to avoid per-request string allocation
const SYSTEM_PROMPT_WITH_ALGORITHM = CHAT_SYSTEM_PROMPT + ALGORITHM_DOC;

// ---------------------------------------------------------------------------
// Surface posture blocks — the per-surface override layer (identity, voice, and
// product policy) injected after the shared cached base. The base stays
// byte-identical across surfaces so its Anthropic prompt cache is shared; the
// posture block is small and uncached. DOCTOR is the strict default (used by
// drstanfield.com web, Discord, and YouTube); BRAND loosens it for the
// microvitamin.com store. See claude_business docs/chat-architecture.md → "Surface posture".
// ---------------------------------------------------------------------------

function loadPosture(file: string): string {
  try {
    return fs.readFileSync(path.join(process.cwd(), 'app/lib', file), 'utf-8');
  } catch {
    console.warn(`Chat: ${file} not found — surface posture missing`);
    return '';
  }
}

export const DOCTOR_POSTURE = loadPosture('chat-posture-doctor.md');
export const BRAND_POSTURE = loadPosture('chat-posture-brand.md');

// ---------------------------------------------------------------------------
// Context assembly — always from the client-supplied plan (local-first v2)
// ---------------------------------------------------------------------------

export interface ChatContext {
  userContextJson: string;
  /** Full documents for content matching (avoids second DB call) */
  healthDocuments: Array<{ title: string; document_date: string | null; document_type: string; content_md: string }>;
}

/** No-data context: chat still answers general questions. */
export const EMPTY_CHAT_CONTEXT: ChatContext = Object.freeze({
  userContextJson: '{}',
  healthDocuments: [],
});

/**
 * Resolve the health context for a chat turn — logged-in or guest alike.
 *
 * The v1 server-side health tables were purged June 2026, so the
 * client-supplied `guestInputs` is the ONLY possible source of health context.
 * Inputs that are absent or hold nothing (an empty form — v2 invites chat
 * before any data entry — or a malformed payload) degrade to the empty
 * context, never an error; saved values with no sex or height still reach the
 * model, with no plan (US-15 AC36). (Regression: Sentry 7563968375 — the logged-in
 * path used to read the purged tables and 500 on every message.) The Pages
 * BYOK chat builds the same JSON with the same function, which is also the
 * anti-injection boundary: see health-core chat-context.ts (US-15 AC11).
 */
export function resolveChatContext(guestInputs: unknown): ChatContext {
  const userContextJson = guestInputs ? buildChatContextJson(guestInputs) : null;
  return userContextJson === null ? EMPTY_CHAT_CONTEXT : { userContextJson, healthDocuments: [] };
}

// ---------------------------------------------------------------------------
// Document content matching
// ---------------------------------------------------------------------------

const DOCUMENT_KEYWORDS = [
  'colonoscopy', 'mammogram', 'dexa', 'mri', 'ct', 'ultrasound', 'xray', 'x-ray',
  'echocardiogram', 'scan', 'lab', 'blood test', 'clinic', 'letter', 'discharge',
  'pathology', 'biopsy', 'vaccination', 'vaccine', 'report',
];

export function matchDocumentTitle(
  userMessage: string,
  documents: Array<{ title: string; documentDate: string | null; documentType: string }>,
): string | null {
  if (documents.length === 0) return null;

  const msgLower = userMessage.toLowerCase();

  let bestMatch: { title: string; score: number } | null = null;

  for (const doc of documents) {
    const titleLower = doc.title.toLowerCase();
    const typeLower = doc.documentType.toLowerCase().replace('_', ' ');
    let score = 0;

    for (const kw of DOCUMENT_KEYWORDS) {
      if (msgLower.includes(kw) && (titleLower.includes(kw) || typeLower.includes(kw))) {
        score += 2;
      }
    }

    const titleWords = titleLower.split(/\W+/).filter(w => w.length > 3);
    for (const word of titleWords) {
      if (msgLower.includes(word)) score++;
    }

    if (score > 0 && (!bestMatch || score > bestMatch.score)) {
      bestMatch = { title: doc.title, score };
    }
  }

  return bestMatch?.title ?? null;
}

/**
 * The router's handles as answer context (loadMatchedContent in
 * matched-content.ts), plus a Sentry warning for a handle with no file.
 * Null when nothing loaded.
 */
export function loadMatchedArticlesFromHandles(handles: string[]): { content: string; titles: string[]; skipped: string[]; reduced: string[] } | null {
  for (const handle of handles) {
    if (!loadBlogArticle(handle)) Sentry.captureMessage(`Router picked handle with no content: ${handle}`, { level: 'warning' });
  }
  const { content, ...rest } = loadMatchedContent(handles);
  return content ? { content, ...rest } : null;
}

// ---------------------------------------------------------------------------
// Message building (system blocks + conversation messages)
// ---------------------------------------------------------------------------

interface SystemBlock {
  type: 'text';
  text: string;
  cache_control?: typeof PROMPT_CACHE;
}

export function buildSystemBlocks(
  userContextJson: string,
  opts?: { surfaceContext?: string; documentContent?: string | null; orderSummary?: string; subscriptionBlock?: string | null; blogArticles?: string | null },
): SystemBlock[] {
  // Cached blocks first (shared across all users AND all surfaces — keep
  // byte-identical so the prompt cache is shared), then the per-surface posture
  // block (uncached), then per-user blocks. All four markers are 1-hour
  // (PROMPT_CACHE): in chat_timing only 170 of 456 turns (37%) came within
  // 5 minutes of the one before (router calls: 38 of 169, 22%; audit F9).
  const blocks: SystemBlock[] = [
    {
      type: 'text',
      text: SYSTEM_PROMPT_WITH_ALGORITHM,
      cache_control: PROMPT_CACHE,
    },
    {
      type: 'text',
      text: EVIDENCE_DOC,
      cache_control: PROMPT_CACHE,
    },
    ...(PRODUCTS_BLOCK ? [{
      type: 'text' as const,
      text: PRODUCTS_BLOCK,
      cache_control: PROMPT_CACHE,
    }] : []),
    ...(KNOWLEDGE_OVERVIEW ? [{
      type: 'text' as const,
      text: KNOWLEDGE_OVERVIEW,
      cache_control: PROMPT_CACHE,
    }] : []),
    ...(opts?.surfaceContext ? [{
      type: 'text' as const,
      text: opts.surfaceContext,
    }] : []),
    {
      type: 'text',
      text: `## Current User Health Data\n\n${userContextJson}`,
    },
  ];

  if (opts?.orderSummary) {
    blocks.push({
      type: 'text',
      text: `## Your Recent Orders\n\n${opts.orderSummary}`,
    });
  }

  // US-49: the logged-in customer's subscriptions and the rules for proposing a
  // change (brand surface, while enabled). Per request and uncached, like orders.
  if (opts?.subscriptionBlock) {
    blocks.push({ type: 'text', text: opts.subscriptionBlock });
  }

  if (opts?.documentContent) {
    blocks.push({
      type: 'text',
      text: `## Referenced Health Document\n\n${opts.documentContent}`,
    });
  }

  if (opts?.blogArticles) {
    blocks.push({
      type: 'text',
      text: `## Referenced Blog Articles\n\n${opts.blogArticles}`,
    });
  }

  return blocks;
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function buildConversationMessages(
  history: Array<{ role: 'user' | 'assistant'; content: string }>,
  newMessage: string,
): Array<{ role: 'user' | 'assistant'; content: string }> {
  const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [];

  // History rows come straight from chat_messages and carry extra columns
  // (created_at, is_fallback). The Anthropic Messages API strict-validates
  // message objects and 400s on unexpected keys, so reduce every row to the
  // two API-valid fields before it enters the outgoing messages array.
  const toApiMessage = (m: { role: 'user' | 'assistant'; content: string }) =>
    ({ role: m.role, content: m.content });

  if (history.length > 0) {
    // Always keep the first user message for topic context
    let budget = HISTORY_TOKEN_BUDGET;
    const firstMsg = history[0];
    if (firstMsg.role === 'user') {
      const tokens = estimateTokens(firstMsg.content);
      messages.push(toApiMessage(firstMsg));
      budget -= tokens;
    }

    // Add most recent messages that fit within budget (from newest to oldest)
    const remaining = firstMsg.role === 'user' ? history.slice(1) : history;
    const recentMessages: Array<{ role: 'user' | 'assistant'; content: string }> = [];

    for (let i = remaining.length - 1; i >= 0; i--) {
      const tokens = estimateTokens(remaining[i].content);
      if (budget - tokens < 0) break;
      recentMessages.unshift(toApiMessage(remaining[i]));
      budget -= tokens;
    }

    messages.push(...recentMessages);
  }

  // Append new user message
  messages.push({ role: 'user', content: newMessage });

  return messages;
}

// ---------------------------------------------------------------------------
// Main chat completion
// ---------------------------------------------------------------------------

/**
 * User-facing message when the main LLM call fails or returns no content.
 * Exported so api.chat.ts and tests can reference the exact string.
 */
export const FALLBACK_RESPONSE =
  "Sorry — I'm having trouble responding right now. Please try again, or email brad@drstanfield.com if it keeps happening.";

export type ChatFailureMode = 'api-error' | 'empty-response' | 'refusal';

/** Closed set for the Sentry `errorKind` tag. Derived from the error's shape, never its text. */
export type ChatErrorKind = 'timeout' | 'http_5xx' | 'overloaded_529' | 'parse' | 'other';

export function classifyChatError(err: unknown): ChatErrorKind {
  if (isNetworkOrTimeoutError(err)) return 'timeout';
  if (err instanceof SyntaxError) return 'parse';
  const message = err instanceof Error ? err.message : '';
  if (/\(status 529\)|\(overloaded_error\)/.test(message)) return 'overloaded_529';
  if (/\(status 5\d\d\)/.test(message)) return 'http_5xx';
  if (message === 'No text in Anthropic response') return 'parse';
  return 'other';
}

export interface ChatCompletionResult {
  content: string;
  usage: AnthropicUsage;
  /** True when the LLM call failed or returned empty and we substituted the fallback message. */
  isFallback: boolean;
  /** True when the model declined: content is a REFUSAL_RESPONSES line. Not a fallback. */
  isRefusal?: boolean;
  refusalCategory?: RefusalCategory;
  /** The API's stop_reason; absent when the call failed. */
  stopReason?: string;
  /** Set on a fallback, and 'refusal' on a refusal. */
  failureMode?: ChatFailureMode;
  /** Error detail for the conversation failure record; never sent to Sentry. */
  errorDetail?: string;
  /** Sentry grouping key for api-error fallbacks; the only error-derived value that leaves the process. */
  errorKind?: ChatErrorKind;
  /** Form edits the model proposed via tool_use (additive — empty on normal turns). */
  proposedEdits?: ProposedEdit[];
  /** Set when the turn ran run_roadmap (US-15 AC33): how many stated values it used and rejected. Counts only, never a value. */
  roadmapRun?: RoadmapRoundCounts;
  /** A subscription change the model proposed (US-49); the route turns it into a confirm card or drops it. */
  subscriptionProposal?: SubscriptionProposal;
}

/** Shown when the model proposed a subscription change with no prose; the card carries the detail (US-49). */
export const SUBSCRIPTION_TOOL_ONLY_ACK = 'Here is the change for you to confirm.';

/** What the web chat streams: the model's deltas, and a status line between a tool round's two calls. */
export type ChatStreamEvent = AnthropicStreamEvent | { type: 'status'; text: string };

/** Shown while the second call of a run_roadmap round runs (US-15 AC33). The widget clears the text streamed before any status line (AC38), so the first call's preamble goes. */
export const ROADMAP_STATUS = 'Running your numbers through the roadmap';

const addUsage = (a: AnthropicUsage, b: AnthropicUsage): AnthropicUsage => ({
  inputTokens: a.inputTokens + b.inputTokens,
  outputTokens: a.outputTokens + b.outputTokens,
  cacheCreationTokens: a.cacheCreationTokens + b.cacheCreationTokens,
  cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
});

const SUBSCRIPTION_PROPOSED = 'Proposed: a card under your reply asks the customer to confirm this change. Nothing has changed yet; it changes only if they press Confirm.';
const SUBSCRIPTION_NOT_PROPOSED = 'Not proposed: no card shows for this call. One change per reply, for a subscription and action marked "yes" in the list.';

/**
 * The tool_result for propose_subscription_change called beside run_roadmap
 * (US-49 with US-15 AC33): the call that becomes the card (the reply's first
 * valid one, as parseSubscriptionProposal picks it) is proposed; any other is not.
 */
const subscriptionToolResult: ToolResultFor = (b, blocks) => {
  if (b.name !== PROPOSE_SUBSCRIPTION_CHANGE_TOOL.name) return undefined;
  return blocks.find((x) => parseSubscriptionProposal([x])) === b ? SUBSCRIPTION_PROPOSED : SUBSCRIPTION_NOT_PROPOSED;
};

/**
 * With `onEvent` the answer streams (the web chat, US-15 AC16/AC17); the
 * result is the same either way. Deltas already sent are not the answer on a
 * refusal or a fallback: the reply goes out with `isFallback: true`, and the
 * client replaces them with its content.
 *
 * `canApplyEdits`: the form tools and run_roadmap go only to a client that
 * applies them (the widget's own chat, US-15 AC19). `tools` render before
 * `system`, so each tool list caches separately.
 *
 * With the form tools comes run_roadmap when the latest or the previous user
 * message has a digit (US-15 AC33, `chatToolsFor`): when the model calls it, the
 * plan code runs on `opts.guestInputs` plus the stated values and a second call
 * answers from its output (health-core `withRoadmapRound`, at most one round).
 * The answer is the second call's text; usage is the two calls' sum. A failed
 * second call is the api-error fallback, with no tool output in it, that keeps
 * the first call's usage and the round's counts.
 *
 * `opts.subscriptionTool` (US-49): the propose-only subscription tool, sent on
 * every brand-surface turn while subscription actions are enabled, logged in or
 * not, so that surface keeps one cached prefix shape. In a run_roadmap round its
 * call gets its own tool_result, and the proposal is read from both calls' blocks.
 *
 * `opts.profileEdits` (US-16 AC2): propose_profile_edit goes only to a client
 * that says it applies it. A widget built before it applies any edit that is
 * not a field as a medication, so it gets neither the tool nor a profile edit.
 */
export async function getChatCompletion(
  systemBlocks: SystemBlock[],
  messages: ChatTurnMessage[],
  canApplyEdits: boolean,
  onEvent?: (event: ChatStreamEvent) => void,
  opts?: { subscriptionTool?: boolean; guestInputs?: unknown; profileEdits?: boolean },
): Promise<ChatCompletionResult> {
  const profileEdits = opts?.profileEdits === true;
  const tools = [...(canApplyEdits ? chatToolsFor(messages, profileEdits) : []), ...(opts?.subscriptionTool ? [PROPOSE_SUBSCRIPTION_CHANGE_TOOL] : [])];
  const body = {
    ...modelParams(CHAT_MODEL, CHAT_MAX_TOKENS, CHAT_EFFORT),
    system: systemBlocks,
    ...(tools.length ? { tools } : {}),
  };
  // Every call's usage, and the round's counts, survive a failed second call (S4).
  let usage: AnthropicUsage = { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 };
  let roadmapRun: { roadmapRun?: RoadmapRoundCounts } = {};
  const send = async (fields: { messages: ChatTurnMessage[]; tool_choice?: { type: 'none' } }) => {
    const reply = onEvent ? await streamAnthropicWithUsage({ ...body, ...fields }, onEvent) : await callAnthropicWithUsage({ ...body, ...fields });
    usage = addUsage(usage, reply.usage);
    return reply;
  };

  try {
    const turn = canApplyEdits
      ? await withRoadmapRound(messages, send, opts?.guestInputs, (counts) => {
        roadmapRun = { roadmapRun: counts };
        onEvent?.({ type: 'status', text: ROADMAP_STATUS });
      }, subscriptionToolResult)
      : null;
    const result = turn ? turn.final : await send({ messages });
    const { stopReason } = result;
    if (stopReason === 'refusal') {
      const refusalCategory = result.refusalCategory ?? 'other';
      return {
        content: refusalLine(refusalCategory),
        usage,
        isFallback: false,
        isRefusal: true,
        refusalCategory,
        stopReason,
        failureMode: 'refusal',
        ...roadmapRun,
      };
    }
    // Truncated: keep the answer, add nothing the user sees, log the stop only.
    if (stopReason === 'max_tokens') console.warn(JSON.stringify({ evt: 'chat_truncated', stopReason }));
    const proposedEdits = (turn?.proposedEdits ?? []).filter(e => profileEdits || e.kind !== 'profile');
    // A round's proposal may be in its first call (beside run_roadmap), so read both.
    const blocks = turn && turn.final !== turn.first ? [...turn.first.contentBlocks, ...result.contentBlocks] : result.contentBlocks;
    const subscriptionProposal = opts?.subscriptionTool ? parseSubscriptionProposal(blocks) : null;
    // Empty-response check: API returned 200 but no usable text. A tool-only
    // response (model proposed an edit with no prose) is NOT empty — give the
    // thread a short line; the confirmation card carries the detail.
    if (!result.content || result.content.trim().length === 0) {
      if (proposedEdits.length > 0) {
        return {
          content: toolOnlyAck(proposedEdits),
          usage,
          isFallback: false,
          stopReason,
          proposedEdits,
          ...(subscriptionProposal ? { subscriptionProposal } : {}),
          ...roadmapRun,
        };
      }
      if (subscriptionProposal) {
        return { content: SUBSCRIPTION_TOOL_ONLY_ACK, usage, isFallback: false, stopReason, subscriptionProposal, ...roadmapRun };
      }
      return {
        content: FALLBACK_RESPONSE,
        usage,
        isFallback: true,
        stopReason,
        failureMode: 'empty-response',
        ...roadmapRun,
      };
    }
    return {
      content: result.content,
      usage,
      isFallback: false,
      stopReason,
      ...(proposedEdits.length > 0 ? { proposedEdits } : {}),
      ...(subscriptionProposal ? { subscriptionProposal } : {}),
      ...roadmapRun,
    };
  } catch (err) {
    // API errors (timeout, 5xx, network, malformed response). fetchAnthropicRaw
    // already Sentry-captures the low-level error; reportChatFallback() below
    // adds chat-specific context from the call site (web vs Discord).
    const errorDetail = err instanceof Error ? err.message : String(err);
    return {
      content: FALLBACK_RESPONSE,
      // The failed call's usage is unknown, so it counts zero; a first call that
      // returned before a failed second one keeps its usage and its round.
      usage,
      isFallback: true,
      failureMode: 'api-error',
      errorDetail,
      errorKind: classifyChatError(err),
      ...roadmapRun,
    };
  }
}

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Report only bounded diagnostics. Conversation content never belongs in telemetry.
 * `conversationId` is an opaque UUID: the join key from an alert to the `chat_*` failure row.
 */
export function reportChatFallback(params: {
  completion: ChatCompletionResult;
  platform: 'shopify' | 'discord' | 'youtube';
  latencyMs: number;
  conversationId?: string | null;
}): void {
  const { completion } = params;
  // Accept only a UUID shape: anything else is not a join key and must not leave the process.
  const conversationId = UUID_SHAPE.test(params.conversationId ?? '') ? params.conversationId : null;
  const extra = { latencyMs: params.latencyMs, conversationId };
  if (completion.isRefusal) {
    // Bounded tags only: never the question, the partial answer or the API's explanation.
    Sentry.captureMessage('Chat: main-LLM refusal', {
      level: 'warning',
      tags: { feature: 'chat', subsystem: 'main-llm', platform: params.platform, stopReason: 'refusal', refusalCategory: completion.refusalCategory ?? 'other' },
      extra,
    });
    return;
  }
  if (!completion.isFallback) return;
  const failureMode = completion.failureMode === 'api-error' ? 'api-error' : 'empty-response';
  const tags = { feature: 'chat', subsystem: 'main-llm', failureMode, platform: params.platform };
  if (failureMode === 'api-error') {
    const errorKind = completion.errorKind ?? 'other';
    Sentry.captureException(new Error(`Chat: main-LLM API failure (${errorKind})`), {
      level: 'error', tags: { ...tags, errorKind }, extra,
    });
  } else {
    Sentry.captureMessage('Chat: main-LLM fallback (empty-response)', { level: 'warning', tags, extra });
  }
}

// ---------------------------------------------------------------------------
// Prompt cache warmup
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Conversation title generation
// ---------------------------------------------------------------------------

/** Generate a conversation title from the first user message. */
export function generateTitle(firstMessage: string): string {
  const sentenceMatch = firstMessage.match(/^(.+?[.?!])\s/);
  if (sentenceMatch && sentenceMatch[1].length > 15 && sentenceMatch[1].length <= 80) {
    return sentenceMatch[1];
  }
  if (firstMessage.length <= 80) return firstMessage;
  const truncated = cutText(firstMessage, 80);
  const lastSpace = truncated.lastIndexOf(' ');
  return lastSpace > 40 ? truncated.slice(0, lastSpace) + '…' : truncated + '…';
}

// ---------------------------------------------------------------------------
// Exports for testing
// ---------------------------------------------------------------------------

export { CHAT_MODEL, MAX_MESSAGE_LENGTH };
