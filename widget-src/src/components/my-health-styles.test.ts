/**
 * US-62 AC30: My health's style rules jsdom cannot compute, read from styles.css.
 * The screenshots in the PR check the picture; these keep the two causes from returning.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(resolve(__dirname, '../styles.css'), 'utf8');
/** Every declaration block whose selector list names `selector`. */
const blocks = (selector: RegExp) => [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)].filter(([, sel]) => selector.test(sel)).map(([, , body]) => body);

describe('US-62 AC30: My health styles', () => {
  it('(a) no rule paints the section symbols one colour over their inline tint', () => {
    for (const body of blocks(/\.section-icon\b/)) expect(body).not.toMatch(/(^|;|\s)color\s*:/);
  });

  it('(b) a rows card\'s 4px top and bottom beat the phone\'s forced 12px card padding', () => {
    // The phone rule is `.section-card { padding: 12px !important }`; a plain 4px loses to it.
    expect(blocks(/(^|,)\s*\.section-card\s*$/m).join('')).toMatch(/padding:\s*12px\s*!important/);
    const rows = blocks(/\.mh-rows-card\.section-card\s*$/).join('');
    expect(rows).toMatch(/padding-top:\s*4px\s*!important/);
    expect(rows).toMatch(/padding-bottom:\s*4px\s*!important/);
  });

  it('AC32, AC34: a phone draws no title, still there for screen readers, and no header row; desktop keeps it', () => {
    const phone = css.slice(css.lastIndexOf('@media (max-width: 768px)'));
    const title = /\.mh-title\s*\{([^}]*)\}/.exec(phone)![1];
    expect(title).toMatch(/position:\s*absolute/);
    expect(title).toMatch(/clip:\s*rect\(0,\s*0,\s*0,\s*0\)/);
    expect(title).not.toMatch(/display:\s*none/); // still read, still focusable
    // AC34 (option A): Sign in and Settings live in the Account tab, so the row draws no box at all.
    expect(/\.mh-header\s*\{\s*display:\s*contents;\s*\}/.test(phone)).toBe(true);
    // The base rule (desktop) draws it.
    const base = blocks(/^\s*\.mh-title\s*$/)[0]; // the first, outside any media query
    expect(base).toMatch(/font-size:\s*28px/);
    expect(base).not.toMatch(/clip:/);
  });
});
