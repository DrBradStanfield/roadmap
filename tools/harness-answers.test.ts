// Brad 2026-11-10: every paid harness run is priced first (--estimate).
import { describe, it, expect } from 'vitest';
import { estimateRunCost, CHARS_PER_TOKEN, ROUTER_OUT_TOKENS, ANSWER_OUT_TOKENS } from './harness-answers';
import { PRICES } from '../packages/health-core/src/models';

const p = PRICES.sonnet55;

describe('estimateRunCost (US-15 AC24b)', () => {
  const call = (cacheKey: string, cachedChars = 350_000, chars = 0) => ({ cacheKey, cachedChars, chars });
  const base = 350_000 / CHARS_PER_TOKEN; // 100K tokens
  const out = (n: number) => n * ANSWER_OUT_TOKENS * p.output;
  const answers = (answerCalls: ReturnType<typeof call>[], concurrency?: number) =>
    estimateRunCost({ routerCalls: 0, routerPromptChars: 0, answerCalls, concurrency });

  it('prices nothing for an empty run', () => {
    const zero = { router: 0, answer: 0, total: 0 };
    expect(estimateRunCost({ routerCalls: 0, routerPromptChars: 350_000, answerCalls: [] })).toEqual({ expected: zero, upper: zero });
  });

  it('router: expected writes the prompt once, then reads; upper writes it on every call', () => {
    const { expected, upper } = estimateRunCost({ routerCalls: 3, routerPromptChars: 350_000, answerCalls: [] });
    expect(expected.router).toBeCloseTo((base * p.cacheWrite + 2 * base * p.cacheRead + 3 * ROUTER_OUT_TOKENS * p.output) / 1e6, 10);
    expect(upper.router).toBeCloseTo((3 * base * p.cacheWrite + 3 * ROUTER_OUT_TOKENS * p.output) / 1e6, 10);
  });

  // Codex R1 on PR 1652, both rounds: the answer calls' cached prefix is written once per tool shape, then read.
  it('one tool shape: expected is one cache write, then reads; upper writes on every call', () => {
    const three = answers([call('edit'), call('edit'), call('edit')]);
    expect(three.expected.answer).toBeCloseTo((base * (p.cacheWrite + 2 * p.cacheRead) + out(3)) / 1e6, 10);
    expect(three.upper.answer).toBeCloseTo((3 * base * p.cacheWrite + out(3)) / 1e6, 10);
  });

  it('two tool shapes: a cold cache write for each, never one shared entry', () => {
    const two = answers([call('edit'), call('run'), call('edit')]);
    expect(two.expected.answer).toBeCloseTo((base * (2 * p.cacheWrite + p.cacheRead) + out(3)) / 1e6, 10);
    expect(two.expected.answer).toBeGreaterThan(answers([call('edit'), call('edit'), call('edit')]).expected.answer);
  });

  it('--concurrency n: up to n cold writes of each shape before the reads', () => {
    const cost = answers([call('edit'), call('edit'), call('edit'), call('run')], 2);
    expect(cost.expected.answer).toBeCloseTo((base * (3 * p.cacheWrite + p.cacheRead) + out(4)) / 1e6, 10);
  });

  it('the upper figure is never below the expected one, and equals it with one call per shape', () => {
    const sets = [
      [call('edit')], [call('edit'), call('run')], [call('edit'), call('edit')], [call('edit'), call('run'), call('edit', 400_000, 9_000)],
      [call('', 350_000, 175_000), call('run', 1_000), call('run', 2_000), call('edit')],
    ];
    for (const set of sets) for (const concurrency of [undefined, 2, 10]) {
      const { expected, upper } = answers(set, concurrency);
      expect(upper.answer).toBeGreaterThanOrEqual(expected.answer);
      expect(upper.total).toBeGreaterThanOrEqual(expected.total);
    }
    for (const set of [[call('edit')], [call('edit'), call('run')], [call('edit'), call('run'), call('')]]) {
      const { expected, upper } = answers(set);
      expect(upper.answer).toBeCloseTo(expected.answer, 10);
    }
  });

  it('prices each answer call\'s uncached input at the input rate and sums the total', () => {
    const { expected, upper } = answers([call('edit', 0, 175_000), call('edit', 0, 175_000)]);
    const each = ((175_000 / CHARS_PER_TOKEN) * p.input + ANSWER_OUT_TOKENS * p.output) / 1e6; // $0.115
    for (const cost of [expected, upper]) {
      expect(cost.answer).toBeCloseTo(2 * each, 10);
      expect(cost.total).toBeCloseTo(cost.router + cost.answer, 10);
    }
  });
});
