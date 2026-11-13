// @vitest-environment jsdom
/**
 * US-62 AC30: My health's style rules jsdom cannot compute, resolved from styles.css
 * (testing/css-cascade.ts) on synthetic elements, or read as text where the check is a rule's absence.
 * The screenshots in the PR check the picture; these keep the two causes from returning.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cascaded, nest } from '../testing/css-cascade';

const PHONE = 390;
const DESKTOP = 1280;
afterEach(() => { document.body.replaceChildren(); });

const css = readFileSync(resolve(__dirname, '../styles.css'), 'utf8');
/** Every declaration block whose selector list names `selector`. */
const blocks = (selector: RegExp) => [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)].filter(([, sel]) => selector.test(sel)).map(([, , body]) => body);

describe('US-62 AC30: My health styles', () => {
  it('(a) no rule paints the section symbols one colour over their inline tint', () => {
    for (const body of blocks(/\.section-icon\b/)) expect(body).not.toMatch(/(^|;|\s)color\s*:/);
  });

  it('(b) a rows card\'s 4px top and bottom beat the phone\'s forced 12px card padding', () => {
    // The phone rule is `.section-card { padding: 12px !important }`; a plain 4px loses to it.
    const plain = nest('section-card');
    expect(cascaded(plain, 'padding-top', PHONE)).toBe('12px');
    expect(cascaded(plain, 'padding-bottom', PHONE)).toBe('12px');
    const rows = nest('section-card mh-rows-card');
    expect(cascaded(rows, 'padding-top', PHONE)).toBe('4px');
    expect(cascaded(rows, 'padding-bottom', PHONE)).toBe('4px');
  });

  it('AC30e: the supplement search is 16px, so iOS does not zoom on focus, and beats the old 13px rule', () => {
    expect(cascaded(nest('supplement-add', 'input|'), 'font-size', DESKTOP)).toBe('13px'); // the base rule, one class
    const add = nest('supplement-add mh-add-test', 'input|'); // two classes: wins on specificity
    expect(cascaded(add, 'font-size', DESKTOP)).toBe('16px');
    expect(cascaded(add, 'font-size', PHONE)).toBe('16px');
    expect(cascaded(nest('mh-add-test', 'supplement-dropdown-item'), 'min-height', PHONE)).toBe('44px');
  });

  it('AC30f: the supplement list sits in the page, never floating over the card below', () => {
    // A real iPhone sent a tap on the floating list to the card behind it (2026-11-10).
    const all = blocks(/\.supplement-dropdown\s*(,|$)/m).join('');
    expect(all).not.toMatch(/position:\s*(absolute|fixed)/);
    expect(all).not.toMatch(/overflow(-y)?:\s*(auto|scroll)/);
    expect(all).not.toMatch(/z-index/);
  });

  it('AC32, AC34: a phone draws no title, still there for screen readers, and no header row; desktop keeps it', () => {
    const title = nest('mh-header', 'h2|mh-title');
    const header = title.parentElement!;
    expect(cascaded(title, 'position', PHONE)).toBe('absolute');
    expect(cascaded(title, 'clip', PHONE)).toMatch(/^rect\(0,\s*0,\s*0,\s*0\)$/);
    expect(cascaded(title, 'display', PHONE)).not.toBe('none'); // still read, still focusable
    // AC34 (option A): Sign in and Settings live in the Account tab, so the row draws no box at all.
    expect(cascaded(header, 'display', PHONE)).toBe('contents');
    // Desktop draws it.
    expect(cascaded(title, 'font-size', DESKTOP)).toBe('28px');
    expect(cascaded(title, 'clip', DESKTOP)).toBeUndefined();
  });
});

describe('US-62 AC35: the Account tab design', () => {
  const standalone = readFileSync(resolve(__dirname, '../../standalone/standalone.css'), 'utf8');

  it('(a) no Settings rule flattens the storage button into a heading: it keeps its fill, 44px, on desktop too', () => {
    for (const [sel, body] of [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)]) {
      if (/\.mh-settings[^,]*\.hr-sync-btn/.test(sel)) expect(body, sel).not.toMatch(/background:\s*none/);
    }
    const desktop = nest('mh-settings', 'hr-sync', 'button|hr-sync-btn hr-sync-btn-full');
    expect(cascaded(desktop, 'min-height', DESKTOP)).toBe('44px');
    expect(cascaded(desktop, 'width', DESKTOP)).toBe('auto'); // a control hugs its words on desktop
    // The base style is the filled teal button.
    expect(/\.hr-sync-btn\s*\{[^}]*background:\s*var\(--color-brand-text\)/.test(standalone)).toBe(true);
  });

  it('(b) a phone\'s Account is grouped cards on the page grey: no outer card, white 12px groups, one heading style', () => {
    const group = nest('mh-account', 'mh-settings', 'hr-sync');
    const sheet = group.parentElement!;
    expect(cascaded(sheet, 'background', PHONE)).toBe('none');
    expect(cascaded(sheet, 'box-shadow', PHONE)).toBe('none');
    expect(cascaded(group, 'background', PHONE)).toBe('#fff');
    expect(cascaded(group, 'border-radius', PHONE)).toBe('12px');
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
    const del = nest('mh-account', 'mh-settings', 'delete-data-section', 'button|delete-data-link');
    expect(cascaded(del, 'min-height', PHONE)).toBe('44px');
    expect(cascaded(del, 'text-decoration', PHONE)).toBe('none');
  });

  it('(c) the hero hides while a phone shows Chat or Account (the tab bar marks the page)', () => {
    expect(standalone.replace(/\s+/g, ' ')).toContain('html[data-hr-tab="chat"] .hr-hero, html[data-hr-tab="account"] .hr-hero { display: none; }');
  });
});

describe('US-62 AC36: one card inset on every phone tab', () => {
  const sides = (el: Element, prop: 'padding' | 'margin', width: number) =>
    [cascaded(el, `${prop}-left`, width), cascaded(el, `${prop}-right`, width)];

  it('the tab panel\'s 16px sides are the inset; no card on any tab adds a side margin', () => {
    expect(sides(nest('hr-tabpanel'), 'padding', PHONE)).toEqual(['16px', '16px']);
    // My health (a plain card, a topic's card, the value page), Chat, Account (Settings is an .md-page).
    const cards = [
      nest('hr-tabpanel', 'health-input-panel', 'section-card'),
      nest('hr-tabpanel', 'mh-page', 'mh-topics', 'section|mh-topic', 'section-card'),
      nest('hr-tabpanel', 'section|md-page'),
      nest('hr-tabpanel', 'health-tool-chat', 'chat-embed-root', 'chat-embed'),
      nest('hr-tabpanel', 'mh-account', 'section|md-page mh-settings'),
    ];
    for (const card of cards) expect(sides(card, 'margin', PHONE).map(v => v ?? '0'), card.className).toEqual(['0', '0']);
  });

  it('desktop keeps its layout, and the chatbot embed (no tab panel) keeps its own 10px', () => {
    expect(cascaded(nest('section|md-page'), 'margin-left', DESKTOP)).toBe('0');
    const embed = nest('chat-embed-root', 'chat-embed');
    embed.parentElement!.id = 'health-chatbot-embed-root';
    expect(sides(embed, 'margin', PHONE)).toEqual(['10px', '10px']);
  });
});

describe('US-62 AC10b (H78): the value page focus ring', () => {
  it('the date box draws the Value box\'s inset teal ring on :focus-within, which WebKit matches', () => {
    const ring = blocks(/\.md-add input\[type="date"\]:focus-within/);
    expect(ring).toHaveLength(1);
    expect(ring[0]).toMatch(/outline:\s*2px solid var\(--color-brand-text\)/);
    expect(ring[0]).toMatch(/outline-offset:\s*-2px/);
    expect(blocks(/\.md-add input:focus-visible/)).toEqual(ring);
  });
});
