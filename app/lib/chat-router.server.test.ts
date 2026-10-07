import { describe, it, expect, vi } from 'vitest';
import { sanitizeRawHandles, sanitizeForRouter, RouterOutput, routeQuery } from './chat-router.server';
import { classifyMessage } from './chat-classifier.server';
import { callAnthropicWithUsage } from './anthropic.server';

vi.mock('./anthropic.server', async (orig) => ({
  ...(await orig<typeof import('./anthropic.server')>()),
  callAnthropicWithUsage: vi.fn(async () => ({
    content: '{"handles":[]}',
    usage: { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 },
  })),
}));

// US-15: chat turns are spread across the day, so a 5-minute entry was usually
// gone by the next turn: only 38 of 169 router calls (22%) and 170 of 456 turns
// (37%) came within 5 minutes of the one before (audit F9). Every cached block is 1h.
describe('prompt cache TTL on the router and classifier hops', () => {
  it('marks every system block ephemeral with a 1-hour TTL', async () => {
    await routeQuery('vitamin d');
    await classifyMessage('vitamin d');
    const bodies = vi.mocked(callAnthropicWithUsage).mock.calls.map(c => c[0] as { system: Array<{ cache_control?: unknown }> });
    expect(bodies).toHaveLength(2);
    for (const body of bodies) {
      for (const block of body.system) expect(block.cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
    }
  });
});

describe('sanitizeRawHandles', () => {
  it('soft-truncates >3 handles so a 4th match cannot void the first three (W33 router_error defect)', () => {
    const four = ['cardiovascular-disease', 'hypertension-in-adults', 'statins', 'ldl-cholesterol'];
    const out = sanitizeRawHandles(four);
    expect(out).toEqual(four.slice(0, 3));
    expect(() => RouterOutput.parse({ handles: out })).not.toThrow();
  });

  it('keeps ≤3 handles unchanged', () => {
    const three = ['a-b', 'c-d', 'e-f'];
    expect(sanitizeRawHandles(three)).toEqual(three);
    expect(sanitizeRawHandles([])).toEqual([]);
  });

  it('drops non-strings and empties, trims and lowercases', () => {
    expect(sanitizeRawHandles(['  STATINS ', 42, '', null, 'ldl-cholesterol'])).toEqual([
      'statins',
      'ldl-cholesterol',
    ]);
  });

  it('passes non-arrays through untouched (schema parse still rejects them)', () => {
    expect(sanitizeRawHandles(undefined)).toBeUndefined();
    expect(sanitizeRawHandles('statins')).toBe('statins');
  });
});

// US-15 AC7: the widget's telemetry row keeps the current question verbatim and
// only the columns it is allowed to carry — never the earlier turns.
import { redactForWidget } from './chat-router.server';

describe('redactForWidget', () => {
  const row = {
    message_id: null,
    conversation_id: 'c1',
    user_id: 'u1',
    message: 'my LDL is 4.2',
    router_context: { platform: 'shopify', first: 'HbA1c 41', recent: ['HbA1c 41', 'BP 140/90'] },
    matched_handles: ['ldl-cholesterol'],
    router_version: 3,
    router_raw: '{"handles":["ldl-cholesterol"]}',
    router_error: null,
    classification: 'ROUTE',
    router_skipped: false,
    is_fallback: false,
    failure_mode: null,
  };

  it('keeps the question verbatim, names the surface, and drops the earlier turns', () => {
    const out = redactForWidget(row);
    expect(out.message).toBe('my LDL is 4.2');
    expect(out.router_context).toEqual({ platform: 'widget' });
    expect(JSON.stringify(out)).not.toContain('BP 140/90');
    expect(JSON.stringify(out)).not.toContain('HbA1c 41');
    expect(out.router_raw).toBe(row.router_raw);
    expect(out.matched_handles).toEqual(['ldl-cholesterol']);
  });

  it('drops a column it does not know, so a reply or error text cannot ride along', () => {
    const out = redactForWidget({ ...row, error_detail: 'raw provider text', content: 'the reply' });
    expect(out).not.toHaveProperty('error_detail');
    expect(out).not.toHaveProperty('content');
  });
});

// US-15 AC26: the router's 2,000-char slice never splits an emoji.
describe('US-15 AC26 — sanitizeForRouter', () => {
  it('US-15 AC26: an emoji straddling 1999/2000 is dropped, not split', () => {
    expect(sanitizeForRouter('a'.repeat(1999) + '😀')).toBe('a'.repeat(1999));
  });
});
