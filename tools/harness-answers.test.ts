// Brad 2026-11-10: every paid harness run is priced first (--estimate).
import { describe, it, expect } from 'vitest';
import { estimateRunCost, CHARS_PER_TOKEN, ROUTER_OUT_TOKENS, ANSWER_OUT_TOKENS } from './harness-answers';
import { PRICES } from '../packages/health-core/src/models';

const p = PRICES.sonnet55;

describe('estimateRunCost (US-15 AC24b)', () => {
  const call = (cacheKey: string, cachedChars = 350_000, chars = 0) => ({ cacheKey, cachedChars, chars });

  it('prices nothing for an empty run', () => {
    expect(estimateRunCost({ routerCalls: 0, routerPromptChars: 350_000, answerCalls: [] })).toEqual({ router: 0, answer: 0, total: 0 });
  });

  it('writes the router prompt to the cache once, then reads it on every later call', () => {
    const tokens = 350_000 / CHARS_PER_TOKEN; // 100K tokens
    const { router } = estimateRunCost({ routerCalls: 3, routerPromptChars: 350_000, answerCalls: [] });
    expect(router).toBeCloseTo((tokens * p.cacheWrite + 2 * tokens * p.cacheRead + 3 * ROUTER_OUT_TOKENS * p.output) / 1e6, 10);
  });

  // Codex R1 on PR 1652, both rounds: the answer calls' cached prefix is written once per tool shape, then read.
  it('one tool shape: one cache write, then reads', () => {
    const base = 350_000 / CHARS_PER_TOKEN;
    const one = estimateRunCost({ routerCalls: 0, routerPromptChars: 0, answerCalls: [call('edit')] });
    expect(one.answer).toBeCloseTo((base * p.cacheWrite + ANSWER_OUT_TOKENS * p.output) / 1e6, 10);
    const three = estimateRunCost({ routerCalls: 0, routerPromptChars: 0, answerCalls: [call('edit'), call('edit'), call('edit')] });
    expect(three.answer).toBeCloseTo((base * (p.cacheWrite + 2 * p.cacheRead) + 3 * ANSWER_OUT_TOKENS * p.output) / 1e6, 10);
  });

  it('two tool shapes: a cold cache write for each, never one shared entry', () => {
    const base = 350_000 / CHARS_PER_TOKEN;
    const two = estimateRunCost({ routerCalls: 0, routerPromptChars: 0, answerCalls: [call('edit'), call('run'), call('edit')] });
    expect(two.answer).toBeCloseTo((base * (2 * p.cacheWrite + p.cacheRead) + 3 * ANSWER_OUT_TOKENS * p.output) / 1e6, 10);
    const shared = estimateRunCost({ routerCalls: 0, routerPromptChars: 0, answerCalls: [call('edit'), call('edit'), call('edit')] });
    expect(two.answer).toBeGreaterThan(shared.answer);
  });

  it('--concurrency n: up to n cold writes of each shape before the reads', () => {
    const base = 350_000 / CHARS_PER_TOKEN;
    const calls = [call('edit'), call('edit'), call('edit'), call('run')];
    const cost = estimateRunCost({ routerCalls: 0, routerPromptChars: 0, answerCalls: calls, concurrency: 2 });
    expect(cost.answer).toBeCloseTo((base * (3 * p.cacheWrite + p.cacheRead) + 4 * ANSWER_OUT_TOKENS * p.output) / 1e6, 10);
  });

  it('prices each answer call\'s uncached input at the input rate, as an upper bound, and sums the total', () => {
    const cost = estimateRunCost({ routerCalls: 0, routerPromptChars: 0, answerCalls: [call('edit', 0, 175_000), call('edit', 0, 175_000)] });
    const each = ((175_000 / CHARS_PER_TOKEN) * p.input + ANSWER_OUT_TOKENS * p.output) / 1e6; // $0.115
    expect(cost.answer).toBeCloseTo(2 * each, 10);
    expect(cost.total).toBeCloseTo(cost.router + cost.answer, 10);
  });
});
