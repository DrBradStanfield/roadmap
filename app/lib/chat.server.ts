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
import type { HealthInputs } from '../../packages/health-core/src/types';
import { calculateHealthResults } from '../../packages/health-core/src/calculations';
import { SUGGESTION_EVIDENCE } from '../../packages/health-core/src/evidence';
import { LONGITUDINAL_FIELDS } from '../../packages/health-core/src/mappings';
import { healthInputSchema } from '../../packages/health-core/src/validation';
import { loadHealthData } from './supabase.server';
import { callAnthropicWithUsage, type AnthropicUsage } from './anthropic.server';
import { decodeSex, decodeUnitSystem } from '../../packages/health-core/src/types';
import { SYNONYM_SETS } from './synonyms';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CHAT_MODEL = 'claude-haiku-4-5-20251001';
const CHAT_MAX_TOKENS = 2048;
const MAX_MESSAGE_LENGTH = 500;
const GUEST_DAILY_LIMIT = 3;
const FREE_DAILY_LIMIT = 50;
const SUBSCRIBER_DAILY_LIMIT = 999; // effectively unlimited
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

interface BlogIndexEntry {
  title: string;
  handle: string;
  url: string;
  tags: string[];
  keywords: string[];
  type?: 'reference' | 'article' | 'guideline' | 'pathway';
  summary?: string;
}

let BLOG_INDEX: BlogIndexEntry[] = [];

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

You have access to a health knowledge base with ${BLOG_INDEX.length} entries. When the user asks about a topic, relevant content is automatically loaded into this conversation by a server-side keyword matcher. You do not need to search or request content — if it's relevant, it will appear below.

### Blog & Reference Articles (${blogCount + refCount})
${blogCount} video-based articles and ${refCount} supplement reference articles covering: supplements, skin health, bone health, sleep, longevity, diet, exercise, blood pressure, cholesterol, and blood test interpretation.

### Clinical Guidelines
${guidelineLines}

${pathwaySection}

If matched content appears below, use it to inform your answer. If no content is loaded for a topic, answer from the algorithm, evidence, and product knowledge above.`;
}

let KNOWLEDGE_OVERVIEW = '';
try {
  const raw = fs.readFileSync(path.join(process.cwd(), 'docs/blog/index.json'), 'utf-8');
  BLOG_INDEX = JSON.parse(raw);
  KNOWLEDGE_OVERVIEW = buildKnowledgeOverview();
} catch {
  console.warn('docs/blog/index.json not found — chat will not have blog knowledge');
}

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
// Daily limit check
// ---------------------------------------------------------------------------

const dailyLimitCache = new Map<string, { count: number; dateString: string }>();

// Clear stale entries every 30 minutes
setInterval(() => {
  const today = utcDateString();
  for (const [key, entry] of dailyLimitCache) {
    if (entry.dateString !== today) dailyLimitCache.delete(key);
  }
}, 30 * 60_000);

function utcDateString(): string {
  return new Date().toISOString().slice(0, 10);
}

export interface DailyLimitResult {
  allowed: boolean;
  remaining: number;
  useCredit: boolean;
  messageCredits: number;
}

export async function checkDailyLimit(
  client: SupabaseClient,
  userId: string,
  subscriptionPlan: string = 'free',
  messageCredits: number = 0,
  isGuest: boolean = false,
): Promise<DailyLimitResult> {
  const limit = isGuest ? GUEST_DAILY_LIMIT
    : subscriptionPlan === 'subscriber' ? SUBSCRIBER_DAILY_LIMIT
    : FREE_DAILY_LIMIT;
  const today = utcDateString();

  // Check cache first
  const cached = dailyLimitCache.get(userId);
  if (cached && cached.dateString === today && cached.count < limit) {
    return { allowed: true, remaining: limit - cached.count, useCredit: false, messageCredits };
  }

  // Query DB for authoritative count (explicit user_id for defense-in-depth beyond RLS)
  const startOfDay = `${today}T00:00:00.000Z`;
  const { count, error } = await client
    .from('chat_messages')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('role', 'user')
    .gte('created_at', startOfDay);

  if (error) {
    console.error('Error checking daily limit:', error);
    Sentry.captureException(new Error('Daily limit check failed'), {
      extra: { userId, error },
      tags: { feature: 'chat' },
    });
    return { allowed: false, remaining: 0, useCredit: false, messageCredits };
  }

  const messageCount = count ?? 0;
  dailyLimitCache.set(userId, { count: messageCount, dateString: today });

  const remaining = Math.max(0, limit - messageCount);

  if (messageCount < limit) {
    return { allowed: true, remaining, useCredit: false, messageCredits };
  }

  // Daily limit exhausted — check credits
  if (messageCredits > 0) {
    return { allowed: true, remaining: 0, useCredit: true, messageCredits };
  }

  return { allowed: false, remaining: 0, useCredit: false, messageCredits: 0 };
}

/** Increment the cached count after a successful message send. */
export function incrementDailyLimitCache(userId: string): void {
  const today = utcDateString();
  const cached = dailyLimitCache.get(userId);
  if (cached && cached.dateString === today) {
    cached.count++;
  } else {
    dailyLimitCache.set(userId, { count: 1, dateString: today });
  }
}

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
  const unitSystem = decodeUnitSystem(profile.unit_system) || 'si';

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

  const userContext = {
    profile: {
      sex: inputs.sex,
      age: results.age,
      heightCm: inputs.heightCm,
      unitSystem,
    },
    latestValues: buildLatestValues(inputs),
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

  // Check each document title for keyword overlap with the user's message
  let bestMatch: { title: string; score: number } | null = null;

  for (const doc of documents) {
    const titleLower = doc.title.toLowerCase();
    const typeLower = doc.documentType.toLowerCase().replace('_', ' ');
    let score = 0;

    // Check document type keywords
    for (const kw of DOCUMENT_KEYWORDS) {
      if (msgLower.includes(kw) && (titleLower.includes(kw) || typeLower.includes(kw))) {
        score += 2;
      }
    }

    // Check title words
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
 * Expand a user query via synonym equivalence sets (see synonyms.ts).
 * Short terms (<=4 chars) require word boundaries to avoid "mi" matching
 * the suffix of "gained", "ed" matching "tried", etc.
 */
function expandQuery(msg: string): string {
  const msgLower = msg.toLowerCase();
  const additions: string[] = [];
  for (const set of SYNONYM_SETS) {
    const matched = set.find(term => {
      const t = term.toLowerCase();
      if (t.length <= 4) {
        const escaped = t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        return new RegExp(`\\b${escaped}\\b`).test(msgLower);
      }
      return msgLower.includes(t);
    });
    if (matched) {
      for (const other of set) {
        if (other !== matched) additions.push(other);
      }
    }
  }
  return additions.length > 0 ? msg + ' ' + additions.join(' ') : msg;
}

/**
 * Match a user message against the blog index by tags and keywords.
 * Returns handles of the top matching articles, sorted by score descending.
 */
export function matchBlogArticles(userMessage: string, maxResults = 3): string[] {
  if (BLOG_INDEX.length === 0) return [];

  const msgLower = expandQuery(userMessage).toLowerCase();
  const matches: Array<{ handle: string; score: number }> = [];

  for (const article of BLOG_INDEX) {
    let score = 0;

    // Check keywords (highest signal) — lowercase for case-insensitive match.
    // Short keywords (≤4 chars) use word boundaries to avoid "ent" matching
    // "treatment", "AIN" matching "migraine", "mi" matching "minimum", etc.
    for (const kw of article.keywords) {
      const kwLower = kw.toLowerCase();
      if (kwLower.length <= 4) {
        const escaped = kwLower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        if (new RegExp(`\\b${escaped}\\b`).test(msgLower)) score += 2;
      } else {
        if (msgLower.includes(kwLower)) score += 2;
      }
    }

    // Check tags
    for (const tag of article.tags) {
      if (msgLower.includes(tag.toLowerCase())) score += 1;
    }

    // Check title words (3+ chars)
    const titleWords = article.title.toLowerCase().split(/\W+/).filter(w => w.length > 3);
    for (const word of titleWords) {
      if (msgLower.includes(word)) score += 1;
    }

    // Boost by content type — guidelines > reference articles > blog posts
    if ((article.type === 'guideline' || article.type === 'pathway') && score > 0) score += 8;
    else if (article.type === 'reference' && score > 0) score += 5;

    if (score > 2) {
      matches.push({ handle: article.handle, score });
    }
  }

  // Sort by score descending, return top N handles
  matches.sort((a, b) => b.score - a.score);
  return matches.slice(0, maxResults).map(m => m.handle);
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

function loadBlogArticle(handle: string): string | null {
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
 * Match a user message against the blog index and load the top matching articles.
 * Falls back to firstUserMessage if the current message yields no matches.
 * Returns the combined article content (separated by ---), or null if no matches.
 */
export function loadMatchedArticles(
  message: string,
  firstUserMessage?: string,
  userMessageCount?: number,
): string | null {
  let handles = matchBlogArticles(message);
  if (handles.length === 0 && firstUserMessage && (userMessageCount ?? 0) < 5) {
    handles = matchBlogArticles(firstUserMessage);
  }
  if (handles.length === 0) return null;

  const parts: string[] = [];
  let totalChars = 0;
  for (const handle of handles) {
    const content = loadBlogArticle(handle);
    if (!content) continue;
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

export interface ChatCompletionResult {
  content: string;
  usage: AnthropicUsage;
}

export async function getChatCompletion(
  systemBlocks: SystemBlock[],
  messages: Array<{ role: 'user' | 'assistant'; content: string }>,
): Promise<ChatCompletionResult> {
  const body = {
    model: CHAT_MODEL,
    max_tokens: CHAT_MAX_TOKENS,
    system: systemBlocks,
    messages,
  };

  const result = await callAnthropicWithUsage(body);

  return {
    content: result.content,
    usage: result.usage,
  };
}

// ---------------------------------------------------------------------------
// Prompt cache warmup
// ---------------------------------------------------------------------------

/**
 * Prime the Anthropic prompt cache with `max_tokens:1` against our 4 cached
 * system blocks. User context (`'{}'`) sits AFTER the last `cache_control`
 * breakpoint, so real requests with different user context still hit the
 * shared cached prefix. Returns usage so the caller can record cache metrics.
 */
export async function warmupCache(): Promise<AnthropicUsage> {
  const systemBlocks = buildSystemBlocks('{}');
  const result = await callAnthropicWithUsage({
    model: CHAT_MODEL,
    max_tokens: 1,
    system: systemBlocks,
    messages: [{ role: 'user', content: 'hi' }],
  });
  return result.usage;
}

// ---------------------------------------------------------------------------
// Exports for testing
// ---------------------------------------------------------------------------

export { CHAT_MODEL, MAX_MESSAGE_LENGTH, GUEST_DAILY_LIMIT, FREE_DAILY_LIMIT, SUBSCRIBER_DAILY_LIMIT };
