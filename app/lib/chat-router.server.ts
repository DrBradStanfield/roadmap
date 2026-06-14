/**
 * LLM retrieval router for the Health Roadmap chatbot.
 *
 * Reads the 991-entry blog index (cached as a single Anthropic prompt cache
 * block) and returns 0-3 content handles for the current user turn.
 *
 * Separate from chat.server.ts for single-responsibility and testability.
 */
import fs from 'fs';
import path from 'path';
import { z } from 'zod';
import * as Sentry from '@sentry/react-router';
import { callAnthropicWithUsage, extractJsonObject, type AnthropicUsage } from './anthropic.server';
import { loadBlogIndex, type BlogIndexEntry } from './blog-index.server';

// ---------------------------------------------------------------------------
// Version — bump when router prompt or index format changes so chat_match_events
// can segment pre/post-change analytics.
// ---------------------------------------------------------------------------

export const ROUTER_VERSION = 1;

// ---------------------------------------------------------------------------
// Model — same as main LLM (Haiku 4.5), faster and cheaper for classification
// ---------------------------------------------------------------------------

const ROUTER_MODEL = 'claude-haiku-4-5-20251001';

const BLOG_INDEX = loadBlogIndex();

// ---------------------------------------------------------------------------
// Valid handles allowlist — O(1) lookup to drop hallucinated handles
// ---------------------------------------------------------------------------

export const VALID_HANDLES = new Set(BLOG_INDEX.map(e => e.handle));

// ---------------------------------------------------------------------------
// Router index block — one line per entry, sorted by type then handle for
// stable Anthropic cache keys. Locking this sort order; changes = cache miss.
// Type order: pathway, guideline, reference, article (clinical first).
// ---------------------------------------------------------------------------

const TYPE_ORDER: Record<string, number> = { pathway: 0, guideline: 1, reference: 2, article: 3 };

function typeRank(entry: BlogIndexEntry): number {
  return TYPE_ORDER[entry.type ?? 'article'] ?? 3;
}

const ROUTER_INDEX_BLOCK: string = (() => {
  const sorted = [...BLOG_INDEX].sort((a, b) => {
    const tr = typeRank(a) - typeRank(b);
    if (tr !== 0) return tr;
    return a.handle.localeCompare(b.handle);
  });
  return sorted
    .map(e => `[${e.type ?? 'article'}] ${e.handle}: ${e.summary ?? e.title}`)
    .join('\n');
})();

// ---------------------------------------------------------------------------
// Router system prompt — loaded from chat-router-prompt.md with 60s TTL so
// Brad can edit the prompt and see effects within a minute without restart.
// ---------------------------------------------------------------------------

let cachedPrompt: string | null = null;
let promptCachedAt = 0;
const PROMPT_TTL_MS = 60_000;
const PROMPT_PATH = path.join(process.cwd(), 'app/lib/chat-router-prompt.md');

function getRouterPrompt(): string {
  if (cachedPrompt && Date.now() - promptCachedAt < PROMPT_TTL_MS) {
    return cachedPrompt;
  }
  try {
    cachedPrompt = fs.readFileSync(PROMPT_PATH, 'utf-8');
    promptCachedAt = Date.now();
    return cachedPrompt;
  } catch {
    console.warn('chat-router: chat-router-prompt.md not found');
    return '';
  }
}

// ---------------------------------------------------------------------------
// Sanitization — strip control chars, cap per-string length
// ---------------------------------------------------------------------------

export function sanitizeForRouter(s: string): string {
  return s.replace(/[\u0000-\u001F\u007F]/g, ' ').slice(0, 2000);
}

// ---------------------------------------------------------------------------
// US → UK spelling normalisation. Our index (Auckland HealthPathways) uses
// UK spelling. US-spelled queries miss on literal text match despite any
// "understand spelling variants" rule in the prompt — Haiku scans the index
// as text, not by semantic meaning. Normalise once, server-side, before the
// Anthropic call: one lookup, all handles covered, zero per-summary edits.
//
// When a new variant shows up in chat_match_events, add a line here.
// ---------------------------------------------------------------------------

const US_TO_UK_SPELLINGS: Record<string, string> = {
  apnea: 'apnoea',
  estrogen: 'oestrogen',
  diarrhea: 'diarrhoea',
  anemia: 'anaemia',
  hemorrhage: 'haemorrhage',
  edema: 'oedema',
  tumor: 'tumour',
  fiber: 'fibre',
  pediatric: 'paediatric',
  gynecology: 'gynaecology',
  orthopedic: 'orthopaedic',
  leukemia: 'leukaemia',
  celiac: 'coeliac',
  esophagus: 'oesophagus',
  esophageal: 'oesophageal',
  hematoma: 'haematoma',
  hemoglobin: 'haemoglobin',
};

export function normaliseSpellings(msg: string): string {
  let out = msg;
  for (const [us, uk] of Object.entries(US_TO_UK_SPELLINGS)) {
    out = out.replace(new RegExp(`\\b${us}\\b`, 'gi'), m =>
      /^[A-Z]/.test(m) ? uk[0].toUpperCase() + uk.slice(1) : uk,
    );
  }
  return out;
}

// ---------------------------------------------------------------------------
// Output types
// ---------------------------------------------------------------------------

export interface RouterResult {
  handles: string[];
  rawJson: string | null;
  usage: AnthropicUsage;
  latencyMs: number;
  cacheHit: boolean;
  error: string | null;
}

const EMPTY_USAGE: AnthropicUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationTokens: 0,
  cacheReadTokens: 0,
};

const RouterOutput = z.object({
  handles: z.array(z.string().regex(/^[a-z0-9-]+$/).max(120)).max(3),
});

// ---------------------------------------------------------------------------
// Core routing function
// ---------------------------------------------------------------------------

export async function routeQuery(
  currentMessage: string,
  firstMessage?: string,
  recentUserMessages?: string[],
): Promise<RouterResult> {
  const t0 = Date.now();

  // Normalise US → UK spelling so the index (UK-spelled) matches on literal
  // text. The user never sees this transformation; it only affects what the
  // router LLM reads.
  const normCurrent = normaliseSpellings(currentMessage);
  const normFirst = firstMessage ? normaliseSpellings(firstMessage) : undefined;
  const normRecent = recentUserMessages?.map(normaliseSpellings);

  // Build the context block — all user-sourced strings stay inside a labeled
  // user-role block; no string concatenation that could let them escape context.
  const contextLines: string[] = [];
  if (normFirst) contextLines.push(`First: ${normFirst}`);
  if (normRecent?.length) {
    contextLines.push(`Recent:\n${normRecent.map(m => `    - ${m}`).join('\n')}`);
  }
  const contextBlock = contextLines.length > 0
    ? `Conversation context:\n${contextLines.map(l => `  ${l}`).join('\n')}\n\n`
    : '';

  // The prompt file ends with "Knowledge base index:" — the index entries go in
  // the second system block so both cache independently (prompt changes don't
  // bust the 37K index cache).
  const routerPrompt = getRouterPrompt();

  const body = {
    model: ROUTER_MODEL,
    max_tokens: 200,
    temperature: 0,
    system: [
      {
        type: 'text',
        text: routerPrompt,
        cache_control: { type: 'ephemeral' },
      },
      {
        type: 'text',
        text: ROUTER_INDEX_BLOCK,
        cache_control: { type: 'ephemeral' },
      },
    ],
    messages: [
      {
        role: 'user',
        content: `${contextBlock}Current query: ${normCurrent}`,
      },
    ],
  };

  let rawJson: string | null = null;

  try {
    const result = await callAnthropicWithUsage(body, 5_000);
    rawJson = result.content;

    // Sanitize before schema parse: normalise spaces/caps so a malformatted
    // handle degrades gracefully rather than causing parse() to throw and drop
    // all handles. e.g. "Cardiovascular Disease" → "cardiovascular-disease".
    const rawParsed = JSON.parse(extractJsonObject(rawJson)) as { handles?: unknown };
    if (Array.isArray(rawParsed.handles)) {
      rawParsed.handles = rawParsed.handles
        .filter((h): h is string => typeof h === 'string')
        .map(h => h.trim().toLowerCase().replace(/[^a-z0-9-]/g, ''))
        .filter(h => h.length > 0);
    }
    const parsed = RouterOutput.parse(rawParsed);

    // Allowlist: drop any handle the router hallucinated
    const validHandles = parsed.handles.filter(h => VALID_HANDLES.has(h));

    const latencyMs = Date.now() - t0;
    const cacheHit = result.usage.cacheReadTokens > 0;

    return {
      handles: validHandles,
      rawJson,
      usage: result.usage,
      latencyMs,
      cacheHit,
      error: null,
    };
  } catch (err) {
    const latencyMs = Date.now() - t0;
    const errorMsg = err instanceof Error ? err.name === 'AbortError' ? 'timeout' : err.message : String(err);

    return {
      handles: [],
      rawJson,
      usage: EMPTY_USAGE,
      latencyMs,
      cacheHit: false,
      error: errorMsg,
    };
  }
}

