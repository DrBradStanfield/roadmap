/**
 * US-74 review F7: the widget bundle carries the full app's field styles
 * (src/components/fields.css) scoped to the block. Run through the bundle's own
 * PostCSS step, every selector stays inside .hr-widget, so none reaches the
 * store's page, and each keeps the specificity it has in the app.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { preprocessCSS, resolveConfig } from 'vite';
import { scopeSelector } from './vite.config.widgets';

const FIELDS = resolve(__dirname, 'src/components/fields.css');

/** The selectors of every rule outside @keyframes, as the bundle emits them. */
async function scoped(): Promise<string[]> {
  const config = await resolveConfig({ configFile: resolve(__dirname, 'vite.config.widgets.ts') }, 'build');
  const { code } = await preprocessCSS(readFileSync(FIELDS, 'utf8'), FIELDS, config);
  const css = code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/@keyframes[^{]*\{(?:[^{}]*\{[^}]*\})*[^}]*\}/g, '');
  return [...css.matchAll(/([^{}@;]+)\{[^{}]*\}/g)].flatMap((m) => m[1].split(',').map((s) => s.trim())).filter(Boolean);
}

describe('fields.css in the widget bundle (US-74 F7)', () => {
  it('every selector the bundle emits is inside the widget root', async () => {
    const selectors = await scoped();
    expect(selectors.length).toBeGreaterThan(15);
    expect(selectors.filter((s) => !s.includes('.hr-widget'))).toEqual([]);
    expect(selectors.filter((s) => s.includes('.health-tool'))).toEqual([]);
  });

  it('keeps each rule\'s specificity: the app root swapped, an unscoped rule wrapped in :where(), :root the block', () => {
    expect(scopeSelector('.health-tool .health-field input:focus')).toBe('.hr-widget .health-field input:focus');
    expect(scopeSelector('.error-message')).toBe(':where(.hr-widget) .error-message');
    expect(scopeSelector(':root')).toBe('.hr-widget');
  });

  it.each(['.health-tool', '.health-tool.dark .x', '.health-tool>.x', '.a .health-tool .b'])('refuses a selector it cannot scope rightly: %s', (s) => {
    expect(() => scopeSelector(s)).toThrow(/cannot scope/);
  });
});
