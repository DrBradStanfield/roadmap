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

// US-15 AC7: the widget's telemetry row keeps the current question, with its
// numbers masked (AC33, S2), and only the columns it is allowed to carry —
// never the earlier turns.
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

  it('keeps the question with its numbers masked, names the surface, and drops the earlier turns', () => {
    const out = redactForWidget(row);
    expect(out.message).toBe('my LDL is #');
    expect(out.router_context).toEqual({ platform: 'widget' });
    expect(JSON.stringify(out)).not.toContain('BP 140/90');
    expect(JSON.stringify(out)).not.toContain('HbA1c 41');
    expect(out.router_raw).toBe(row.router_raw);
    expect(out.matched_handles).toEqual(['ldl-cholesterol']);
  });

  it('US-15 AC33 (S2): every digit run is masked, decimals and comma decimals whole; a question with no digit is verbatim', () => {
    const masked = redactForWidget({ ...row, message: 'BP 182/112, LDL 4,6 mmol/L, HbA1c 41.5 and Lp(a) 75 nmol/L' }).message;
    expect(masked).toBe('BP #/#, LDL # mmol/L, HbA1c # and Lp(a) # nmol/L');
    expect(String(masked).replace('HbA1c', '')).not.toMatch(/\d/);
    // Any script's digits, not only ASCII: a fullwidth or Arabic-Indic value is masked too.
    expect(redactForWidget({ ...row, message: 'LDL ４.１ and HbA1c ٤١' }).message).toBe('LDL # and HbA1c #');
    expect(redactForWidget({ ...row, message: 'how am I doing overall?' }).message).toBe('how am I doing overall?');
  });

  it('US-15 AC33 (R5): topic names that hold a digit are kept; every other digit run is masked, glued values too', () => {
    const mask = (message: string) => redactForWidget({ ...row, message }).message;
    for (const topic of ['HbA1c', 'hba1c', 'B1', 'B6', 'B9', 'B12', 'D2', 'D3', 'K1', 'K2', 'GLP-1', 'SGLT2', 'omega-3',
      'CoQ10', 'PCSK9', 'T1DM', 'T2DM', 'type 1', 'Type 2', 'Zone 2']) {
      expect(mask(`what about ${topic}?`)).toBe(`what about ${topic}?`);
    }
    expect(mask('my LDL is 4.1 and HbA1c 41')).toBe('my LDL is # and HbA1c #');
    expect(mask('BP132/84')).toBe('BP#/#');
    expect(mask('LDL4.1, HbA1c41, B12 300, D3 2000 IU, B1.2')).toBe('LDL#, HbA#c#, B12 #, D3 # IU, B#');
    expect(mask('my Lp(a) is 75')).toBe('my Lp(a) is #');
    expect(String(mask('BP132/84 LDL4.1'))).not.toMatch(/\d/);
  });

  it('US-15 AC33 (R6): router_raw and router_error are masked the same way when they are strings', () => {
    const out = redactForWidget({ ...row, router_raw: '{"handles":["type-2-diabetes"],"note":"LDL 4.1"}', router_error: 'parse failed at "HbA1c 41"' });
    expect(out.router_raw).toBe('{"handles":["type-2-diabetes"],"note":"LDL #"}');
    expect(out.router_error).toBe('parse failed at "HbA1c #"');
    expect(redactForWidget(row).router_error).toBeNull();
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

// US-15 AC27 (Sentry 6Y): V8's JSON.parse message quotes a 10-unit snippet of
// the bad input, which can end mid-pair. router_error stores that message, so
// a lone surrogate there makes PostgREST reject the whole match-event row.
describe('US-15 AC27: router_error carries no lone surrogate', () => {
  it('a prose reply with an emoji at the snippet edge yields a well-formed error', async () => {
    vi.mocked(callAnthropicWithUsage).mockResolvedValueOnce({
      content: 'Hi there 😀 how can I help',
      usage: { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 },
    } as Awaited<ReturnType<typeof callAnthropicWithUsage>>);
    const r = await routeQuery('hello');
    expect(r.error).toBeTruthy();
    expect(JSON.stringify(r.error)).not.toMatch(/\\u[dD][89a-fA-F]/);
  });
});

// US-15 AC28 (2026-10-07, YouTube): JSON, then "Wait — correction", then the
// corrected JSON. The first-to-last-brace slice threw, so the turn got no handles.
describe('US-15 AC28: a corrected second object routes the turn', () => {
  const reply = (content: string) => vi.mocked(callAnthropicWithUsage).mockResolvedValueOnce({
    content,
    usage: { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 },
  } as Awaited<ReturnType<typeof callAnthropicWithUsage>>);

  it('routes on the correction, with no router_error', async () => {
    reply('{"handles": ["diet", "this-study-proved-we-were-wrong-about-vitamin-d"]}\n\nWait — correction. The second handle was a mistake; returning only the relevant ones:\n\n{"handles": ["diet", "best-diet-confirmed-by-5248916-person-year-study", "diet-strongly-suspected-best"]}');
    const r = await routeQuery('what is the best diet');
    expect(r.error).toBeNull();
    expect(r.handles).toEqual(['diet', 'best-diet-confirmed-by-5248916-person-year-study', 'diet-strongly-suspected-best']);
  });

  it('a reply with no object still fails with the same router_error', async () => {
    reply('Sorry, nothing fits.');
    const r = await routeQuery('hello');
    expect(r.handles).toEqual([]);
    expect(r.error).toMatch(/^Unexpected token/);
  });
});
