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
});
