import { describe, it, expect } from 'vitest';
import { getArg, modelParams, summaryLine, toStat } from './model-arm';

// Harness plumbing for the 2026-09-29 Haiku vs Sonnet 5.5 comparison
// (docs/chat-audit-2026-09-29.md §3). Sonnet 5.5 400s on the Haiku body shape.
describe('modelParams', () => {
  it('keeps the Haiku shape: temperature 0 and the caller max_tokens', () => {
    expect(modelParams('claude-haiku-4-5-20251001', 8, false))
      .toEqual({ model: 'claude-haiku-4-5-20251001', max_tokens: 8, temperature: 0 });
  });
  it('Sonnet 5.5 thinking-off: between_tools, no temperature, no other thinking field', () => {
    const p = modelParams('claude-sonnet-5-5', 200, true);
    expect(p).toEqual({ model: 'claude-sonnet-5-5', max_tokens: 200, thinking: { type: 'between_tools' } });
    expect(p).not.toHaveProperty('temperature');
  });
  it('Sonnet 5 (the production answer model) gets no temperature and disabled thinking, not between_tools', () => {
    expect(modelParams('claude-sonnet-5', 200, true))
      .toEqual({ model: 'claude-sonnet-5', max_tokens: 200, thinking: { type: 'disabled' } });
    expect(modelParams('claude-sonnet-5', 200, false)).not.toHaveProperty('temperature');
    expect(modelParams('claude-sonnet-5-5', 200, true).thinking).toEqual({ type: 'between_tools' });
  });
  it('Sonnet 5.5 adaptive: effort low and room for thinking plus answer', () => {
    expect(modelParams('claude-sonnet-5-5', 200, false))
      .toEqual({ model: 'claude-sonnet-5-5', max_tokens: 1024, output_config: { effort: 'low' } });
  });
});

describe('summaryLine', () => {
  it('prices cache reads at the model rate and reports pass rate and latency', () => {
    const stats = [toStat(100, { cache_read_input_tokens: 1_000_000 }), toStat(300, { output_tokens: 1000 })];
    const haiku = summaryLine('router', 'claude-haiku-4-5-20251001', false, 9, 10, stats, 0);
    expect(haiku).toContain('pass=9/10 (90.0%)');
    expect(haiku).toContain('p50=100ms');
    expect(haiku).toContain('cost=$0.1050'); // 1M cache reads at $0.10 + 1K output at $5
    const sonnet = summaryLine('router', 'claude-sonnet-5-5', true, 9, 10, stats, 0);
    expect(sonnet).toContain('cost=$0.2100'); // $0.20 + $0.01
  });
});

describe('getArg', () => {
  it('reads the value after the flag', () => {
    expect(getArg(['--runs', '1', '--concurrency', '2'], '--concurrency', '9')).toBe('2');
  });
  it('falls back to the default when the flag is absent, even with other flags present', () => {
    // The old parser returned args[0] ('--runs') here, so concurrency became NaN and no worker ran.
    expect(getArg(['--runs', '1'], '--concurrency', '2')).toBe('2');
    expect(getArg([], '--runs', '3')).toBe('3');
  });
});
