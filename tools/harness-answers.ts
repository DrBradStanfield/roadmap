/**
 * Pure helpers for tools/test-chatbot-matching.ts: how an answer is read for the
 * must_not_claim, regex and profile-edit checks, and what a run would cost before it spends
 * anything (--estimate; Brad 2026-11-10: no paid run without a cost estimate first).
 */
import { PRICES } from '../packages/health-core/src/models';
import type { ProposedEdit, ProposedProfileEdit } from '../packages/health-core/src/chat-edits';

const NEGATION = /\b(no|not|never|cannot|without|nor|nothing|none|neither)\b|n't\b/;
// A negation only excuses a phrase from inside its own clause.
const CLAUSE_BREAK = /[;—–]|\bbut\b|\band\b/g;
// Idioms that hold a negation word but affirm ("there is no doubt it can …").
const AFFIRMING = /\b(no doubt|not only|no wonder|no question|without (a )?doubt|none other than)\b/g;

/** The answer as must_not_claim and the regex checks see it: lower case, straight quotes, no markdown * or _. */
export const plain = (response: string) => response.toLowerCase().replace(/[’‘]/g, "'").replace(/[*_]/g, '');

/** Phrases stated as fact: no negation in the up-to-12 words before them, within their clause. */
export function claimed(response: string, phrases: string[]): string[] {
  const text = plain(response);
  const sentences = text.split(/(?<=[.!?])\s+|\n+/);
  return phrases.filter(p => sentences.some(s => {
    const phrase = p.toLowerCase().replace(/[’‘]/g, "'");
    for (let at = s.indexOf(phrase); at !== -1; at = s.indexOf(phrase, at + 1)) {
      const clause = s.slice(0, at).split(CLAUSE_BREAK).pop() ?? '';
      // Mask each idiom word in place, so the 12-word window keeps its true span.
      const masked = clause.replace(AFFIRMING, m => m.split(/\s+/).map(() => '_').join(' '));
      const window = masked.trim().split(/\s+/).slice(-12).join(' ');
      if (!NEGATION.test(window)) return true;
    }
    return false;
  }));
}

/** US-16 AC2: why a reply's profile proposal is not the expected one, merged as the widget merges it. */
export function profileEditFailures(expected: { sex?: 'male' | 'female'; heightCm?: number }, edits: ProposedEdit[]): string[] {
  const profiles = edits.filter((e): e is ProposedProfileEdit => e.kind === 'profile');
  if (profiles.length === 0) return ['no propose_profile_edit'];
  const sex = profiles.reduce<string | null>((a, e) => e.sex ?? a, null);
  const heightCm = profiles.reduce<number | null>((a, e) => e.heightCm ?? a, null);
  return [
    ...(expected.sex !== undefined && sex !== expected.sex ? [`proposed sex ${sex ?? 'none'}, not ${expected.sex}`] : []),
    ...(expected.heightCm !== undefined && (heightCm === null || Math.abs(heightCm - expected.heightCm) > 0.1)
      ? [`proposed height ${heightCm ?? 'none'} cm, not ${expected.heightCm}`] : []),
  ];
}

/** Characters per token, the rough rule the weekly lint uses too. */
export const CHARS_PER_TOKEN = 3.5;
/** Output tokens assumed per call: a router reply is a short JSON list; an answer includes its thinking. */
export const ROUTER_OUT_TOKENS = 60;
export const ANSWER_OUT_TOKENS = 1500;

export interface RunPlan {
  /** Router calls, the warmup included. */
  routerCalls: number;
  /** Characters of the cached router prompt (instructions plus index). */
  routerPromptChars: number;
  /** Characters of each answer call's input (system plus loaded articles plus the question). */
  answerCallChars: number[];
}

/**
 * What a run would cost, in dollars, on Sonnet 5.5 prices. The router prompt is written to the
 * cache once and read on every later call. Answer input is priced uncached, so the answer figure
 * is an upper bound; a repeat of the same context reads from the cache for less.
 */
export function estimateRunCost(plan: RunPlan) {
  const p = PRICES.sonnet55;
  const promptTokens = plan.routerPromptChars / CHARS_PER_TOKEN;
  const router = plan.routerCalls === 0 ? 0 : (promptTokens * p.cacheWrite
    + (plan.routerCalls - 1) * promptTokens * p.cacheRead
    + plan.routerCalls * ROUTER_OUT_TOKENS * p.output) / 1e6;
  const answer = plan.answerCallChars.reduce((t, chars) =>
    t + ((chars / CHARS_PER_TOKEN) * p.input + ANSWER_OUT_TOKENS * p.output) / 1e6, 0);
  return { router, answer, total: router + answer };
}
