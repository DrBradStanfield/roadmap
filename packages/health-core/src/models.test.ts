import { describe, it, expect } from 'vitest';
import { CHAT_EFFORT, CHAT_MAX_TOKENS, CHAT_MODEL, getArg, modelParams, summaryLine, toStat } from './models';

// Request shapes per model family (docs/chat-audit-2026-09-29.md F1, US-15 AC13).
// Sonnet 5 and 5.5 400 on the Haiku body shape; 5.5 also 400s on `disabled` thinking.
describe('modelParams', () => {
  it('keeps the Haiku shape: temperature 0 and the caller max_tokens, whatever thinking is asked for', () => {
    expect(modelParams('claude-haiku-4-5-20251001', 8))
      .toEqual({ model: 'claude-haiku-4-5-20251001', max_tokens: 8, temperature: 0 });
    expect(modelParams('claude-haiku-4-5-20251001', 800, 'medium'))
      .toEqual({ model: 'claude-haiku-4-5-20251001', max_tokens: 800, temperature: 0 });
  });
  it('Sonnet 5.5 thinking-off: between_tools, no temperature, no other thinking field', () => {
    const p = modelParams('claude-sonnet-5-5', 200, 'off');
    expect(p).toEqual({ model: 'claude-sonnet-5-5', max_tokens: 200, thinking: { type: 'between_tools' } });
    expect(p).not.toHaveProperty('temperature');
  });
  it('Sonnet 5 gets no temperature and disabled thinking, not between_tools', () => {
    expect(modelParams('claude-sonnet-5', 200, 'off'))
      .toEqual({ model: 'claude-sonnet-5', max_tokens: 200, thinking: { type: 'disabled' } });
    expect(modelParams('claude-sonnet-5', 200, 'low')).not.toHaveProperty('temperature');
  });
  it('adaptive: effort in output_config, summarized display, and room for thinking plus answer', () => {
    expect(modelParams('claude-sonnet-5-5', 200, 'low')).toEqual({
      model: 'claude-sonnet-5-5',
      max_tokens: 1024,
      thinking: { type: 'adaptive', display: 'summarized' },
      output_config: { effort: 'low' },
    });
  });
  it('throws on an id outside Haiku 4.5 and the Sonnet 5 family, never guessing a shape (US-15 AC13)', () => {
    expect(() => modelParams('claude-opus-5-5', 200)).toThrow(/claude-opus-5-5/);
    expect(() => modelParams('claude-3-5-haiku-20241022', 200)).toThrow();
    expect(() => modelParams('claude-sonnet-4-5', 200)).toThrow();
    expect(() => modelParams('claude-haiku-4-5', 8)).not.toThrow();
  });
  it('the production answer body: Sonnet 5.5, adaptive at medium, 4096 tokens, no sampling param', () => {
    expect(CHAT_MODEL).toBe('claude-sonnet-5-5');
    expect(modelParams(CHAT_MODEL, CHAT_MAX_TOKENS, CHAT_EFFORT)).toEqual({
      model: 'claude-sonnet-5-5',
      max_tokens: 4096,
      thinking: { type: 'adaptive', display: 'summarized' },
      output_config: { effort: 'medium' },
    });
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
