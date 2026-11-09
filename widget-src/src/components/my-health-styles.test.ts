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

describe('US-62 AC35: the Account tab design', () => {
  const standalone = readFileSync(resolve(__dirname, '../../standalone/standalone.css'), 'utf8');

  it('(a) no Settings rule flattens the storage button into a heading: it keeps its fill, 44px, on desktop too', () => {
    for (const [sel, body] of [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)]) {
      if (/\.mh-settings[^,]*\.hr-sync-btn/.test(sel)) expect(body, sel).not.toMatch(/background:\s*none/);
    }
    const desktop = blocks(/^\s*\.mh-settings \.hr-sync \.hr-sync-btn-full\s*$/m).join('');
    expect(desktop).toMatch(/min-height:\s*44px/);
    expect(desktop).toMatch(/width:\s*auto/); // a control hugs its words on desktop
    // The base style is the filled teal button.
    expect(/\.hr-sync-btn\s*\{[^}]*background:\s*var\(--color-brand-text\)/.test(standalone)).toBe(true);
  });

  it('(b) a phone\'s Account is grouped cards on the page grey: no outer card, white 12px groups, one heading style', () => {
    const sheet = blocks(/^\s*\.mh-account \.mh-settings\s*$/m).join('');
    expect(sheet).toMatch(/background:\s*none/);
    expect(sheet).toMatch(/box-shadow:\s*none/);
    const group = blocks(/\.mh-account \.mh-settings > \.hr-sync\b/).join('');
    expect(group).toMatch(/background:\s*#fff/);
    expect(group).toMatch(/border-radius:\s*12px/);
    // The group list names every kind of part: the storage card, units, About you's rows, reminders, delete.
    const groupSel = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)].find(([sel]) => /\.mh-account \.mh-settings > \.hr-sync\b/.test(sel))![1];
    for (const part of ['> .section-card > .basic-info-units', '.prefill-fields-wrapper', '.hr-reminders-section > .hr-sync', '> .delete-data-section']) {
      expect(groupSel).toContain(part);
    }
    // About you's and the reminders' headings share one rule: one heading style above their cards.
    const headingSel = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)].find(([sel]) => /\.mh-account .*\.hr-reminders-heading/.test(sel));
    expect(headingSel?.[1]).toMatch(/\.mh-account \.about-card \.hr-section-card-header/);
    expect(headingSel?.[2]).toMatch(/padding:\s*0 16px/);
    // Delete all my data is the iPhone's destructive row: centred red words, 44px, no underline.
    const del = blocks(/\.mh-account \.delete-data-link/).join('');
    expect(del).toMatch(/min-height:\s*44px/);
    expect(del).toMatch(/text-decoration:\s*none/);
  });

  it('(c) the hero hides while a phone shows Chat or Account (the tab bar marks the page)', () => {
    expect(standalone.replace(/\s+/g, ' ')).toContain('html[data-hr-tab="chat"] .hr-hero, html[data-hr-tab="account"] .hr-hero { display: none; }');
  });
});
