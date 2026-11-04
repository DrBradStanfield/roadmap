// @vitest-environment jsdom
/**
 * US-15 AC53: the store-wide chat bubble shows on a phone. `site-chat.tsx`
 * imports the widget's `styles.css`, so a phone rule written for the widget's
 * own floating button also lands on every storefront page through
 * `health-site-chat.css`. jsdom ignores media queries, so this test applies
 * the stylesheet's rules itself: every rule that matches the mounted bubble
 * and whose media query holds at the given width decides its `display`.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';

vi.mock('./lib/sentry', () => ({ initSentry: vi.fn() }));
vi.mock('./components/ChatSection', () => ({ ChatSection: () => null }));

const css = readFileSync(resolve(__dirname, 'styles.css'), 'utf8');

/** Whether a media query holds on a touch screen `width` px wide (phones are coarse, no hover). */
function mediaHolds(query: string, width: number): boolean {
  const touch = width <= 768;
  return query.split(',').some((part) => part.trim().split(/\s+and\s+/).every((feature) => {
    const f = feature.trim().replace(/^\(|\)$/g, '').trim();
    if (f === 'screen' || f === 'all') return true;
    const [name, value = ''] = f.split(':').map((s) => s.trim());
    if (name === 'max-width') return width <= parseFloat(value);
    if (name === 'min-width') return width >= parseFloat(value);
    if (name === 'hover') return (value === 'none') === touch;
    if (name === 'pointer') return (value === 'coarse') === touch;
    return false; // print, prefers-reduced-motion and the rest: not this screen
  }));
}

/** The bubble's `display` at `width`: the last matching rule in source order wins. That is
 *  the cascade here because no earlier matching rule is more specific than a later one. */
function displayAt(el: Element, width: number): string {
  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);
  let display = 'unset';
  const walk = (rules: CSSRuleList) => {
    for (const rule of Array.from(rules)) {
      if (rule instanceof CSSMediaRule) {
        if (mediaHolds(rule.media.mediaText, width)) walk(rule.cssRules);
      } else if (rule instanceof CSSStyleRule) {
        let matches = false;
        try { matches = el.matches(rule.selectorText); } catch { matches = false; }
        const value = rule.style.getPropertyValue('display');
        if (matches && value) display = value;
      }
    }
  };
  walk((style.sheet as CSSStyleSheet).cssRules);
  style.remove();
  return display;
}

async function mountBubble(): Promise<Element> {
  const root = document.createElement('div');
  root.id = 'health-chat-root';
  root.dataset.fabLabel = 'Need help? Ask here';
  root.style.display = 'none';
  document.body.appendChild(root);
  await act(async () => { await import('./site-chat'); });
  const fab = document.querySelector('.chat-fab');
  expect(fab).not.toBeNull();
  return fab!;
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.resetModules();
});
afterEach(() => { document.body.replaceChildren(); });

describe('US-15 AC53: the store-wide chat bubble shows on a phone', () => {
  it('shows on a 375px phone and at the 767px edge', async () => {
    const fab = await mountBubble();
    expect(displayAt(fab, 375)).toBe('flex');
    expect(displayAt(fab, 767)).toBe('flex');
  });

  it('shows on a tablet and a desktop', async () => {
    const fab = await mountBubble();
    expect(displayAt(fab, 768)).toBe('flex');
    expect(displayAt(fab, 1440)).toBe('flex');
  });

  it('control: on a page with the chatbot embed, a phone still hides the bubble', async () => {
    const embed = document.createElement('div');
    embed.id = 'health-chatbot-embed-root';
    document.body.appendChild(embed);
    const fab = await mountBubble();
    expect(displayAt(fab, 375)).toBe('none');
    expect(displayAt(fab, 1440)).toBe('flex');
  });
});
