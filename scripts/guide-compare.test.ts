/**
 * publish-guides.mjs PUTs a guide only when its rendered body differs from the live
 * Shopify copy, compared through norm(). The builder escapes quotes (US-64 AC30) and
 * a re-serialised live body may not, so quote entities count as equal in text. Inside
 * a tag they never do: an attribute delimiter and an encoded quote are different
 * markup, and a publish that fixes a broken live anchor must not be skipped.
 */
import { describe, it, expect } from 'vitest';
import { norm } from './guide-compare.mjs';

describe('guide-compare norm (US-64 AC30)', () => {
  it('treats a quote and its entity in text as the same', () => {
    expect(norm("<p>it's</p>")).toBe(norm('<p>it&#39;s</p>'));
    expect(norm('<p>say "x"</p>')).toBe(norm('<p>say &quot;x&quot;</p>'));
  });

  it('keeps an attribute delimiter apart from an encoded quote inside a tag', () => {
    expect(norm('<a href="a" title=x>t</a>')).not.toBe(norm('<a href="a&quot; title=x">t</a>'));
  });

  it('still lowercases tags, expands self-closing ones and drops whitespace between tags', () => {
    expect(norm('<svg viewBox="0 0 1 1"/>\n<P>x</P>')).toBe('<svg viewbox="0 0 1 1"></svg><p>x</p>');
  });
});
