import { describe, it, expect } from 'vitest';
import { CHAT_EFFORT, CHAT_MAX_TOKENS, CHAT_MODEL, CLASSIFIER_MODEL, EXTRACTION_MODEL, EXTRACTION_STOP_CODES, PROMPT_CACHE, ROUTER_MODEL, extractionStopCode, getArg, modelParams, summaryLine, toStat } from './models';

// Request shapes per model family (docs/chat-audit-2026-09-29.md F1, US-15 AC13).
// Sonnet 5 and 5.5 400 on sampling params; 5.5 also 400s on `disabled` thinking.
// Haiku 5.5 400s on sampling params too, and thinks unless told not to (US-15 AC31).
describe('modelParams', () => {
  it('Haiku 5.5 thinking-off: disabled thinking, the caller max_tokens, no sampling param', () => {
    const p = modelParams('claude-haiku-5-5', 8);
    expect(p).toEqual({ model: 'claude-haiku-5-5', max_tokens: 8, thinking: { type: 'disabled' } });
    expect(p).not.toHaveProperty('temperature');
  });
  it('Haiku 5.5 with an effort level: adaptive thinking, effort in output_config, at least 1024 tokens', () => {
    expect(modelParams('claude-haiku-5-5', 8, 'low')).toEqual({
      model: 'claude-haiku-5-5',
      max_tokens: 1024,
      thinking: { type: 'adaptive', display: 'summarized' },
      output_config: { effort: 'low' },
    });
  });
  it('the production classifier and extraction bodies: Haiku 5.5 with thinking off (US-15 AC31)', () => {
    expect(CLASSIFIER_MODEL).toBe('claude-haiku-5-5');
    expect(EXTRACTION_MODEL).toBe('claude-haiku-5-5');
    expect(modelParams(CLASSIFIER_MODEL, 16))
      .toEqual({ model: 'claude-haiku-5-5', max_tokens: 16, thinking: { type: 'disabled' } });
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
  it('throws on an id outside Haiku 5.5 and the Sonnet 5 family, never guessing a shape (US-15 AC13)', () => {
    expect(() => modelParams('claude-opus-5-5', 200)).toThrow(/claude-opus-5-5/);
    expect(() => modelParams('claude-3-5-haiku-20241022', 200)).toThrow();
    expect(() => modelParams('claude-sonnet-4-5', 200)).toThrow();
    // Haiku 4.5 took temperature 0; its branch went with the 2026-10-16 switch.
    expect(() => modelParams('claude-haiku-4-5-20251001', 8)).toThrow();
    expect(() => modelParams('claude-haiku-5-5', 8)).not.toThrow();
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
  it('the production router body: Sonnet 5.5 with thinking off, as chat-router.server.ts sends it', () => {
    expect(modelParams(ROUTER_MODEL, 200))
      .toEqual({ model: 'claude-sonnet-5-5', max_tokens: 200, thinking: { type: 'between_tools' } });
  });
});

describe('summaryLine', () => {
  it('prices cache reads at the model rate and reports pass rate and latency', () => {
    const stats = [toStat(100, { cache_read_input_tokens: 1_000_000 }), toStat(300, { output_tokens: 1000 })];
    const haiku = summaryLine('classifier', 'claude-haiku-5-5', true, 9, 10, stats, 0);
    expect(haiku).toContain('pass=9/10 (90.0%)');
    expect(haiku).toContain('p50=100ms');
    expect(haiku).toContain('arm=thinking-off');
    expect(haiku).toContain('cost=$0.0105'); // 1M cache reads at $0.01 + 1K output at $0.50
    const sonnet = summaryLine('router', 'claude-sonnet-5-5', true, 9, 10, stats, 0);
    expect(sonnet).toContain('cost=$0.2100'); // $0.20 + $0.01
  });
  // US-15: the chat hops cache for 1 hour, and a 1-hour write bills at 2x base
  // input (5-minute writes were 1.25x), so the harness cost line must too.
  it('prices cache writes at 2x base input, the 1-hour TTL rate', () => {
    const stats = [toStat(100, { cache_creation_input_tokens: 1_000_000 })];
    expect(summaryLine('classifier', 'claude-haiku-5-5', true, 1, 1, stats, 0)).toContain('cost=$0.2000');
    expect(summaryLine('router', 'claude-sonnet-5-5', true, 1, 1, stats, 0)).toContain('cost=$4.0000');
  });
});

describe('PROMPT_CACHE', () => {
  it('is the 1-hour ephemeral marker every chat hop and harness sends (US-15)', () => {
    expect(PROMPT_CACHE).toEqual({ type: 'ephemeral', ttl: '1h' });
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

// US-15 AC31: one vocabulary for an extraction that stopped short, on the
// server, the Pages build and the upload modal alike.
describe('extractionStopCode', () => {
  it('names a refusal and a max_tokens stop, and nothing else', () => {
    expect(EXTRACTION_STOP_CODES).toEqual(['refused', 'too_long']);
    expect(extractionStopCode('refusal')).toBe('refused');
    expect(extractionStopCode('max_tokens')).toBe('too_long');
    for (const other of ['end_turn', 'tool_use', 'stop_sequence', '', undefined]) expect(extractionStopCode(other)).toBeUndefined();
  });
});
