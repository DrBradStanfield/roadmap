import { describe, it, expect } from 'vitest';
import { sanitizeRawHandles, RouterOutput } from './chat-router.server';

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

// US-15 AC7: the widget's telemetry row keeps the question verbatim and only
// the columns it is allowed to carry.
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

  it('keeps the question and its context verbatim and names the surface', () => {
    const out = redactForWidget(row);
    expect(out.message).toBe('my LDL is 4.2');
    expect(out.router_context).toEqual({ platform: 'widget', first: 'HbA1c 41', recent: ['HbA1c 41', 'BP 140/90'] });
    expect(out.router_raw).toBe(row.router_raw);
    expect(out.matched_handles).toEqual(['ldl-cholesterol']);
  });

  it('drops a column it does not know, so a reply or error text cannot ride along', () => {
    const out = redactForWidget({ ...row, error_detail: 'raw provider text', content: 'the reply' });
    expect(out).not.toHaveProperty('error_detail');
    expect(out).not.toHaveProperty('content');
  });
});
