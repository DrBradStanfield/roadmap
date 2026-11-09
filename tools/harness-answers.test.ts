// Brad 2026-11-10: every paid harness run is priced first (--estimate).
import { describe, it, expect } from 'vitest';
import { estimateRunCost, CHARS_PER_TOKEN, ROUTER_OUT_TOKENS, ANSWER_OUT_TOKENS } from './harness-answers';
import { PRICES } from '../packages/health-core/src/models';

const p = PRICES.sonnet55;

describe('estimateRunCost', () => {
  it('prices nothing for an empty run', () => {
    expect(estimateRunCost({ routerCalls: 0, routerPromptChars: 350_000, answerCallChars: [] })).toEqual({ router: 0, answer: 0, total: 0 });
  });

  it('writes the router prompt to the cache once, then reads it on every later call', () => {
    const tokens = 350_000 / CHARS_PER_TOKEN; // 100K tokens
    const { router } = estimateRunCost({ routerCalls: 3, routerPromptChars: 350_000, answerCallChars: [] });
    expect(router).toBeCloseTo((tokens * p.cacheWrite + 2 * tokens * p.cacheRead + 3 * ROUTER_OUT_TOKENS * p.output) / 1e6, 10);
  });

  it('prices each answer call uncached, as an upper bound, and sums the total', () => {
    const cost = estimateRunCost({ routerCalls: 0, routerPromptChars: 0, answerCallChars: [175_000, 175_000] });
    const each = ((175_000 / CHARS_PER_TOKEN) * p.input + ANSWER_OUT_TOKENS * p.output) / 1e6; // $0.115
    expect(cost.answer).toBeCloseTo(2 * each, 10);
    expect(cost.total).toBeCloseTo(cost.router + cost.answer, 10);
  });
});
