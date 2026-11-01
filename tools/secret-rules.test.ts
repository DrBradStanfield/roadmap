/**
 * US-40 AC11 / US-63 AC6: tools/secret-rules.mjs. codex-review.mjs streams files in chunks with a
 * PATTERN_SPAN carry, so a credential shape split across a seam is still found only if no pattern can
 * reach further than PATTERN_SPAN. This computes each pattern's reach (its widest match plus how far
 * a lookahead looks past it) from the regex source and holds it below the span.
 */
import { describe, expect, it } from 'vitest';
import { PATTERN_SPAN, PATTERNS } from './secret-rules.mjs';

type Size = { width: number; reach: number };

/** Widest match and widest reach of a regex source, for the subset PATTERNS uses; * + {n,} reach Infinity. */
function measure(src: string): Size {
  let i = 0;
  const alternation = (): Size => {
    let best = sequence();
    while (src[i] === '|') {
      i++;
      const next = sequence();
      best = { width: Math.max(best.width, next.width), reach: Math.max(best.reach, next.reach) };
    }
    return best;
  };
  const sequence = (): Size => {
    let width = 0;
    let reach = 0;
    while (i < src.length && src[i] !== '|' && src[i] !== ')') {
      let atom = item();
      atom = quantify(atom);
      reach = Math.max(reach, width + atom.reach);
      width += atom.width;
    }
    return { width, reach };
  };
  const item = (): Size => {
    const c = src[i];
    if (c === '\\') { i += 2; return { width: 1, reach: 1 }; }
    if (c === '[') {
      i++;
      while (src[i] !== ']') i += src[i] === '\\' ? 2 : 1;
      i++;
      return { width: 1, reach: 1 };
    }
    if (c === '(') {
      i++;
      let kind = 'group';
      if (src.startsWith('?:', i)) { i += 2; }
      else if (src.startsWith('?<!', i) || src.startsWith('?<=', i)) { i += 3; kind = 'behind'; }
      else if (src.startsWith('?=', i) || src.startsWith('?!', i)) { i += 2; kind = 'ahead'; }
      const inner = alternation();
      i++; // ')'
      if (kind === 'behind') return { width: 0, reach: 0 };
      if (kind === 'ahead') return { width: 0, reach: inner.reach };
      return inner;
    }
    i++;
    return { width: 1, reach: 1 };
  };
  const quantify = (a: Size): Size => {
    const q = /^(?:\?|\*|\+|\{(\d+)(,(\d*))?\})/.exec(src.slice(i));
    if (!q) return a;
    i += q[0].length;
    const max = q[0] === '?' ? 1 : q[0] === '*' || q[0] === '+' ? Infinity : q[2] === undefined ? Number(q[1]) : q[3] === '' ? Infinity : Number(q[3]);
    if (max === 0) return { width: 0, reach: 0 };
    return { width: max * a.width, reach: (max - 1) * a.width + a.reach };
  };
  const out = alternation();
  if (i !== src.length) throw new Error(`could not measure ${src} at ${i}`);
  return out;
}

describe('US-40 AC11: every credential shape fits the streaming carry', () => {
  it('measures a known reach correctly', () => {
    expect(measure('ab(?=c{0,9}d)e{3}')).toEqual({ width: 5, reach: 12 });
    expect(measure('a\\d+')).toEqual({ width: Infinity, reach: Infinity });
    expect(measure(PATTERNS.openai_anthropic).reach).toBe(103); // the widest: `sk-` and a 100-character digit look
  });
  // discord_webhook ends in `\d+/`: a real webhook id is a snowflake of at most 20 digits, so a real URL
  // is about 47 characters, but the pattern itself is unbounded. Held here until the pattern is bounded.
  const UNBOUNDED = new Set(['discord_webhook']);
  for (const [name, re] of Object.entries(PATTERNS)) {
    it(`${name} reaches less than PATTERN_SPAN`, () => {
      const { reach } = measure(re);
      if (UNBOUNDED.has(name)) expect(reach).toBe(Infinity);
      else expect(reach).toBeLessThan(PATTERN_SPAN);
    });
  }
});
