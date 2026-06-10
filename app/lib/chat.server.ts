/**
 * Chat feature — context assembly, daily limit check, system prompt construction.
 *
 * Grounded in health_roadmap_algorithm.md and evidence.ts.
 * All user health data is assembled server-side — the client sends only the question.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import * as Sentry from '@sentry/remix';
import fs from 'fs';
import path from 'path';
import { loadBlogIndex, type BlogIndexEntry } from './blog-index.server';
import type { HealthInputs } from '../../packages/health-core/src/types';
import { calculateHealthResults } from '../../packages/health-core/src/calculations';
import { SUGGESTION_EVIDENCE } from '../../packages/health-core/src/evidence';
import { LONGITUDINAL_FIELDS, METRIC_TO_FIELD } from '../../packages/health-core/src/mappings';
import { healthInputSchema } from '../../packages/health-core/src/validation';
import { loadHealthData } from './supabase.server';
import { callAnthropicWithUsage, type AnthropicUsage } from './anthropic.server';
import { decodeSex, decodeUnitSystem } from '../../packages/health-core/src/types';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CHAT_MODEL = 'claude-haiku-4-5-20251001';
const CHAT_MAX_TOKENS = 2048;
const MAX_MESSAGE_LENGTH = 500;
const HISTORY_TOKEN_BUDGET = 8000;
const MAX_BLOG_CHARS = 80_000; // ~20K tokens — cap on combined blog articles in context

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
    path.join(process.cwd(), 'docs/products.md'), 'utf-8',
  );
} catch {
  console.warn('docs/products.md not found — chat will not have product knowledge');
  PRODUCTS_DOC = '';
}

// ---------------------------------------------------------------------------
// Blog article index — read once at module load
// ---------------------------------------------------------------------------

const BLOG_INDEX: BlogIndexEntry[] = loadBlogIndex();

function buildKnowledgeOverview(): string {
  if (BLOG_INDEX.length === 0) return '';
  const blogCount = BLOG_INDEX.filter(a => !a.type || a.type === 'article').length;
  const refCount = BLOG_INDEX.filter(a => a.type === 'reference').length;
  const guidelines = BLOG_INDEX.filter(a => a.type === 'guideline');
  const pathwayCount = BLOG_INDEX.filter(a => a.type === 'pathway').length;

  const guidelineLines = guidelines.map(g => {
    let line = `- ${g.title}`;
    if (g.summary) {
      const words = g.summary.split(/\s+/);
      line += ` — ${words.length > 50 ? words.slice(0, 50).join(' ') + '...' : g.summary}`;
    }
    return line;
  }).join('\n');

  // Load pathway categories if available
  let pathwaySection = '';
  if (pathwayCount > 0) {
    try {
      const catRaw = fs.readFileSync(path.join(process.cwd(), 'docs/pathway/categories.json'), 'utf-8');
      const categories: Record<string, string[]> = JSON.parse(catRaw);
      const catLines = Object.entries(categories)
        .sort((a, b) => b[1].length - a[1].length)
        .map(([cat, names]) => {
          const examples = names.slice(0, 5).join(', ');
          return `- ${cat} (${names.length}): ${examples}${names.length > 5 ? '...' : ''}`;
        });
      pathwaySection = `### Clinical Pathways (${pathwayCount} conditions)\nEvidence-based clinical pathways from Auckland Region HealthPathways, organized by specialty:\n${catLines.join('\n')}`;
    } catch {
      pathwaySection = `### Clinical Pathways (${pathwayCount} conditions)\nEvidence-based pathways covering cardiovascular, respiratory, endocrine, GI, dermatology, musculoskeletal, neurology, haematology, infectious disease, and more. Source: Auckland Region HealthPathways.`;
    }
  }

  return `## Knowledge Base

You have access to a health knowledge base with ${BLOG_INDEX.length} entries. When the user asks about a topic, a retrieval step loads relevant content if available. You do not need to search or request content — if it's relevant, it will appear below.

### Blog & Reference Articles (${blogCount + refCount})
${blogCount} video-based articles and ${refCount} supplement reference articles covering: supplements, skin health, bone health, sleep, longevity, diet, exercise, blood pressure, cholesterol, and blood test interpretation.

### Clinical Guidelines
${guidelineLines}

${pathwaySection}

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
// Context assembly (cached per user for 5 minutes)
// ---------------------------------------------------------------------------

const contextCache = new Map<string, { context: ChatContext; expiresAt: number }>();
const CONTEXT_CACHE_TTL = 5 * 60_000;

setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of contextCache) {
    if (now > entry.expiresAt) contextCache.delete(key);
  }
}, 5 * 60_000);

export interface ChatContext {
  userContextJson: string;
  subscriptionPlan: string;
  messageCredits: number;
  /** Full documents for content matching (avoids second DB call) */
  healthDocuments: Array<{ title: string; document_date: string | null; document_type: string; content_md: string }>;
}

export async function assembleChatContext(
  client: SupabaseClient,
  userId?: string,
): Promise<ChatContext | null> {
  // Return cached context if available (health data doesn't change between chat messages)
  if (userId) {
    const cached = contextCache.get(userId);
    if (cached && Date.now() < cached.expiresAt) return cached.context;
  }

  const data = await loadHealthData(client);
  if (!data) return null;

  const { profile, inputs, medInputs, screenInputs, healthDocuments } = data;

  // Incomplete profile — can't personalize chat. Surface upstream as "load
  // health data" failure so the UI prompts the user to finish onboarding.
  if (profile.sex == null) return null;

  const unitSystem = profile.unit_system != null ? decodeUnitSystem(profile.unit_system) : 'si';

  const results = calculateHealthResults(inputs, unitSystem, medInputs, screenInputs);

  const userContext = {
    profile: {
      sex: decodeSex(profile.sex),
      age: results.age,
      heightCm: profile.height,
      unitSystem,
    },
    latestValues: buildLatestValues(inputs),
    medications: medInputs,
    screenings: screenInputs,
    currentSuggestions: results.suggestions.map(s => ({
      id: s.id,
      category: s.category,
      priority: s.priority,
      title: s.title,
    })),
    uploadedDocuments: (healthDocuments ?? []).map(d => ({
      title: d.title,
      date: d.document_date,
      type: d.document_type,
    })),
  };

  const context: ChatContext = {
    userContextJson: JSON.stringify(userContext, null, 2),
    subscriptionPlan: profile.subscription_plan ?? 'free',
    messageCredits: profile.message_credits ?? 0,
    healthDocuments: healthDocuments ?? [],
  };

  if (userId) {
    contextCache.set(userId, { context, expiresAt: Date.now() + CONTEXT_CACHE_TTL });
  }

  return context;
}

/**
 * Build chat context from client-supplied guest health inputs.
 * Same output shape as assembleChatContext but without DB calls.
 * Returns null if inputs fail validation.
 */
export function assembleGuestChatContext(guestInputs: unknown): ChatContext | null {
  const parsed = healthInputSchema.safeParse(guestInputs);
  if (!parsed.success) return null;

  const inputs = parsed.data as HealthInputs;
  const raw = guestInputs as Record<string, unknown>;
  const unitSystem = raw?.unitSystem === 'conventional' ? 'conventional' : 'si';

  // Sanitize medications/screenings — only allow plain objects with string/number values
  // to prevent prompt injection via crafted nested objects
  const medications = sanitizeFlatObject(raw?.medications);
  const screenings = sanitizeFlatObject(raw?.screenings);

  const results = calculateHealthResults(inputs, unitSystem, medications, screenings);

  const latestValues = buildLatestValues(inputs);

  // Local-first builds (Health Plan v2) send the full dated blood-test/vitals
  // time series, which the snapshot inputs don't carry. Two uses:
  //  1. Expose the trend so "what's changed since last time" works.
  //  2. Override each metric's latestValues entry with the most-recent dated
  //     reading — the client's single snapshot field can be ambiguous (it
  //     reported LDL 2.0 where the newest dated lab was 1.2), so the dated
  //     series is the source of truth for "most recent".
  const measurementHistory = sanitizeMeasurementHistory((guestInputs as Record<string, unknown>)?.measurementHistory);
  const hasHistory = Object.keys(measurementHistory).length > 0;
  if (hasHistory) {
    for (const [metric, series] of Object.entries(measurementHistory)) {
      const field = METRIC_TO_FIELD[metric];
      if (field && series.length > 0) latestValues[field] = `${series[series.length - 1].value}`;
    }
  }

  const userContext = {
    profile: {
      sex: inputs.sex,
      age: results.age,
      heightCm: inputs.heightCm,
      unitSystem,
    },
    latestValues,
    // Chronological per metric; the LAST entry is the most recent. SI values,
    // same units as latestValues. Omitted (undefined) when no history was sent.
    ...(hasHistory ? { measurementHistory } : {}),
    medications,
    screenings,
    currentSuggestions: results.suggestions.map(s => ({
      id: s.id,
      category: s.category,
      priority: s.priority,
      title: s.title,
    })),
    uploadedDocuments: [],
  };

  return {
    userContextJson: JSON.stringify(userContext, null, 2),
    subscriptionPlan: 'free',
    messageCredits: 0,
    healthDocuments: [],
  };
}

/**
 * Validate client-supplied dated measurement history: an object mapping metric
 * key → chronological array of {date: YYYY-MM-DD, value: number}. Hard caps
 * (24 points/metric, 400 total) bound the payload + prompt size; anything
 * malformed is dropped, so a crafted object can't inject prose into the prompt.
 */
function sanitizeMeasurementHistory(obj: unknown): Record<string, Array<{ date: string; value: number }>> {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return {};
  const out: Record<string, Array<{ date: string; value: number }>> = {};
  let total = 0;
  for (const [metric, series] of Object.entries(obj as Record<string, unknown>)) {
    if (metric.length > 40 || !Array.isArray(series)) continue;
    const clean: Array<{ date: string; value: number }> = [];
    for (const entry of series) {
      if (clean.length >= 24 || total >= 400) break;
      const date = (entry as { date?: unknown })?.date;
      const value = (entry as { value?: unknown })?.value;
      if (typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date) && typeof value === 'number' && Number.isFinite(value)) {
        clean.push({ date, value });
        total++;
      }
    }
    if (clean.length > 0) out[metric] = clean;
  }
  return out;
}

/** Sanitize an object to only contain string/number/boolean/null values (no nested objects). */
function sanitizeFlatObject(obj: unknown): Record<string, unknown> {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return {};
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || value === null) {
      result[key] = value;
    }
  }
  return result;
}

function buildLatestValues(inputs: HealthInputs): Record<string, string> {
  const result: Record<string, string> = {};
  for (const field of LONGITUDINAL_FIELDS) {
    const value = inputs[field as keyof HealthInputs];
    if (value !== undefined && value !== null) {
      result[field] = `${value}`;
    }
  }
  return result;
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
 * Load the full markdown content of a blog article by handle.
 * Caches in memory after first read — articles don't change at runtime.
 * Returns null if the file doesn't exist.
 */
const blogArticleCache = new Map<string, string | null>();

function getContentDir(handle: string): string {
  const entry = BLOG_INDEX.find(a => a.handle === handle);
  if (entry?.type === 'guideline') return 'docs/guideline';
  if (entry?.type === 'pathway') return 'docs/pathway';
  return 'docs/blog';
}

export function loadBlogArticle(handle: string): string | null {
  // Validate handle to prevent path traversal
  if (!/^[a-z0-9-]+$/.test(handle)) return null;

  const cached = blogArticleCache.get(handle);
  if (cached !== undefined) return cached;

  try {
    const dir = getContentDir(handle);
    const content = fs.readFileSync(
      path.join(process.cwd(), dir, `${handle}.md`), 'utf-8',
    );
    blogArticleCache.set(handle, content);
    return content;
  } catch {
    blogArticleCache.set(handle, null);
    return null;
  }
}

/**
 * Load and concatenate blog article content for the handles returned by the LLM router.
 * Reuses the existing path-traversal-safe, memoized loadBlogArticle().
 */
export function loadMatchedArticlesFromHandles(handles: string[]): string | null {
  if (handles.length === 0) return null;

  const parts: string[] = [];
  let totalChars = 0;
  for (const handle of handles) {
    const content = loadBlogArticle(handle);
    if (!content) {
      Sentry.captureMessage(`Router picked handle with no content: ${handle}`, { level: 'warning' });
      continue;
    }
    if (totalChars + content.length > MAX_BLOG_CHARS) break;
    parts.push(content);
    totalChars += content.length;
  }
  return parts.length > 0 ? parts.join('\n\n---\n\n') : null;
}

// ---------------------------------------------------------------------------
// Message building (system blocks + conversation messages)
// ---------------------------------------------------------------------------

interface SystemBlock {
  type: 'text';
  text: string;
  cache_control?: { type: 'ephemeral' };
}

export function buildSystemBlocks(
  userContextJson: string,
  opts?: { documentContent?: string | null; orderSummary?: string; blogArticles?: string | null },
): SystemBlock[] {
  // Cached blocks first (shared across all users), then per-user blocks
  const blocks: SystemBlock[] = [
    {
      type: 'text',
      text: SYSTEM_PROMPT_WITH_ALGORITHM,
      cache_control: { type: 'ephemeral' },
    },
    {
      type: 'text',
      text: EVIDENCE_DOC,
      cache_control: { type: 'ephemeral' },
    },
    ...(PRODUCTS_DOC ? [{
      type: 'text' as const,
      text: `## Dr Stanfield's Products\n\n${PRODUCTS_DOC}`,
      cache_control: { type: 'ephemeral' as const },
    }] : []),
    ...(KNOWLEDGE_OVERVIEW ? [{
      type: 'text' as const,
      text: KNOWLEDGE_OVERVIEW,
      cache_control: { type: 'ephemeral' as const },
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

  if (history.length > 0) {
    // Always keep the first user message for topic context
    let budget = HISTORY_TOKEN_BUDGET;
    const firstMsg = history[0];
    if (firstMsg.role === 'user') {
      const tokens = estimateTokens(firstMsg.content);
      messages.push(firstMsg);
      budget -= tokens;
    }

    // Add most recent messages that fit within budget (from newest to oldest)
    const remaining = firstMsg.role === 'user' ? history.slice(1) : history;
    const recentMessages: typeof history = [];

    for (let i = remaining.length - 1; i >= 0; i--) {
      const tokens = estimateTokens(remaining[i].content);
      if (budget - tokens < 0) break;
      recentMessages.unshift(remaining[i]);
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

export type ChatFailureMode = 'api-error' | 'empty-response';

export interface ChatCompletionResult {
  content: string;
  usage: AnthropicUsage;
  /** True when the LLM call failed or returned empty and we substituted the fallback message. */
  isFallback: boolean;
  /** Populated only when isFallback is true. */
  failureMode?: ChatFailureMode;
  /** The original error message, if any — for Sentry context. Not shown to users. */
  errorDetail?: string;
}

export async function getChatCompletion(
  systemBlocks: SystemBlock[],
  messages: Array<{ role: 'user' | 'assistant'; content: string }>,
): Promise<ChatCompletionResult> {
  const body = {
    model: CHAT_MODEL,
    max_tokens: CHAT_MAX_TOKENS,
    temperature: 0.3,
    system: systemBlocks,
    messages,
  };

  try {
    const result = await callAnthropicWithUsage(body);
    // Empty-response check: API returned 200 but no usable text. Treated as a
    // failure mode distinct from API errors — different cause, same UX (fallback).
    if (!result.content || result.content.trim().length === 0) {
      return {
        content: FALLBACK_RESPONSE,
        usage: result.usage,
        isFallback: true,
        failureMode: 'empty-response',
      };
    }
    return {
      content: result.content,
      usage: result.usage,
      isFallback: false,
    };
  } catch (err) {
    // API errors (timeout, 5xx, network, malformed response). fetchAnthropicRaw
    // already Sentry-captures the low-level error; reportChatFallback() below
    // adds chat-specific context from the call site (web vs Discord).
    const errorDetail = err instanceof Error ? err.message : String(err);
    return {
      content: FALLBACK_RESPONSE,
      // Usage is unknown when the call failed before returning — zero it out so
      // downstream logging doesn't mis-charge.
      usage: { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 },
      isFallback: true,
      failureMode: 'api-error',
      errorDetail,
    };
  }
}

/**
 * Capture a main-LLM fallback to Sentry with chat-specific context.
 *
 * Called from BOTH the web path (api.chat.ts) and the Discord path
 * (discord-bot.server.ts via platform-chat.server.ts). Without this shared
 * helper, Discord fallbacks silently miss Sentry alerts and the audit-tool
 * is_fallback flag.
 *
 * No-op when completion.isFallback is false — safe to call unconditionally.
 *
 * Failure-mode handling:
 *  - 'api-error' (5xx/timeout/network) → captureException at level 'error'.
 *    Sentry groups by exception, matching the surrounding pattern in
 *    api.chat.ts and the low-level capture in anthropic.server.ts.
 *  - 'empty-response' (200 with whitespace-only content) → captureMessage at
 *    level 'warning'. Different cause, lower urgency, no exception to bind to.
 *
 * errorDetail is truncated to 500 chars to limit PII exposure — Anthropic 400
 * responses can echo prompt content.
 */
export function reportChatFallback(params: {
  completion: ChatCompletionResult;
  platform: 'shopify' | 'discord';
  conversationId: string | null;
  messagePreview: string;
  latencyMs: number;
  matchedHandles: string[];
  userId?: string;
  isGuest?: boolean;
  authorTag?: string;
}): void {
  if (!params.completion.isFallback) return;
  const failureMode = params.completion.failureMode ?? 'unknown';
  const errorDetail = params.completion.errorDetail?.slice(0, 500);
  const tags = { feature: 'chat', subsystem: 'main-llm', failureMode, platform: params.platform };
  const extras = {
    conversationId: params.conversationId,
    platform: params.platform,
    userId: params.userId,
    isGuest: params.isGuest,
    authorTag: params.authorTag,
    messagePreview: params.messagePreview.slice(0, 100),
    latencyMs: params.latencyMs,
    matchedHandles: params.matchedHandles,
    errorDetail,
  };
  if (failureMode === 'api-error') {
    Sentry.captureException(new Error(errorDetail ?? 'main-LLM api-error'), { level: 'error', tags, extra: extras });
  } else {
    Sentry.captureMessage(`Chat: main-LLM fallback (${failureMode})`, { level: 'warning', tags, extra: extras });
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
  const truncated = firstMessage.slice(0, 80);
  const lastSpace = truncated.lastIndexOf(' ');
  return lastSpace > 40 ? truncated.slice(0, lastSpace) + '…' : truncated + '…';
}

// ---------------------------------------------------------------------------
// Exports for testing
// ---------------------------------------------------------------------------

export { CHAT_MODEL, MAX_MESSAGE_LENGTH };
