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
    // A > inside a quoted attribute does not end the tag (Codex re-check).
    expect(norm('<a href="a>b&quot; title=&quot;x">t</a>')).not.toBe(norm('<a href="a>b" title="x">t</a>'));
  });

  it('decodes text before an unclosed <, and leaves what follows it as written (stricter, never looser)', () => {
    expect(norm('it&#39;s 3 < 4 &quot;x&quot;')).toBe('it\'s 3 < 4 &quot;x&quot;');
    expect(norm('<p>it&#39;s</p> and <b>&quot;y&quot;</b>')).toBe('<p>it\'s</p> and <b>"y"</b>');
  });

  it('stays linear on 200k characters of unclosed tags', () => {
    for (const unit of ['<a "', '<']) {
      const t = Date.now();
      norm(unit.repeat(200_000 / unit.length));
      expect(Date.now() - t).toBeLessThan(1000);
    }
  });

  it('still lowercases tags, expands self-closing ones and drops whitespace between tags', () => {
    expect(norm('<svg viewBox="0 0 1 1"/>\n<P>x</P>')).toBe('<svg viewbox="0 0 1 1"></svg><p>x</p>');
  });
});
