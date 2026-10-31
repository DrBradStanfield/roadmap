// @vitest-environment jsdom
/**
 * US-20 AC8: on a phone every input in the vitals matrix is at least 16px, so
 * iOS Safari does not zoom the page when one is tapped. The blood pressure
 * pair is the case that broke: its 13px rule has two classes and beat the
 * one-class phone guard. jsdom ignores media queries and computes no cascade,
 * so this resolves `font-size` from styles.css itself: the rules whose media
 * apply at the given width and whose selector matches the rendered input,
 * ranked by !important, specificity, then source order. Synthetic values.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { StartingInfoVitals } from './StartingInfoVitals';

afterEach(() => { cleanup(); localStorage.clear(); });

interface Rule { selectors: string[]; media: string | null; body: string; order: number }

/** Top-level rules and the rules inside top-level @media blocks; other at-rules are skipped. */
function parseRules(source: string): Rule[] {
  const css = source.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules: Rule[] = [];
  const block = (from: number): number => { // index just past the brace that closes the one at `from`
    let depth = 0;
    let quote: string | null = null;
    for (let i = from; i < css.length; i++) {
      const ch = css[i];
      if (quote) { if (ch === quote && css[i - 1] !== '\\') quote = null; continue; }
      if (ch === '"' || ch === "'") quote = ch;
      else if (ch === '{') depth++;
      else if (ch === '}' && --depth === 0) return i + 1;
    }
    throw new Error('unbalanced braces in styles.css');
  };
  const walk = (start: number, end: number, media: string | null) => {
    let i = start;
    while (i < end) {
      const open = css.indexOf('{', i);
      if (open === -1 || open >= end) break;
      const prelude = css.slice(i, open).trim();
      const close = block(open);
      if (prelude.startsWith('@media')) {
        if (media) throw new Error(`nested @media: ${prelude}`);
        walk(open + 1, close - 1, prelude.slice('@media'.length).trim());
      } else if (!prelude.startsWith('@')) {
        rules.push({ selectors: prelude.split(',').map(s => s.trim()), media, body: css.slice(open + 1, close - 1), order: rules.length });
      }
      i = close;
    }
  };
  walk(0, css.length, null);
  return rules;
}

/** A phone or a desktop screen: width features by number, a touch screen for hover and pointer. */
function mediaApplies(query: string, width: number): boolean {
  return query.split(',').some(alternative => alternative.trim().split(/\s+and\s+/).every(part => {
    const feature = /^\(\s*([\w-]+)\s*:\s*([^)]+?)\s*\)$/.exec(part.trim());
    if (!feature) {
      if (part.trim() === 'print') return false;
      if (part.trim() === 'screen') return true;
      throw new Error(`media part not understood: ${part}`);
    }
    const [, name, value] = feature;
    if (name === 'max-width') return width <= parseFloat(value);
    if (name === 'min-width') return width >= parseFloat(value);
    if (name === 'hover') return value === 'none';
    if (name === 'pointer') return value === 'coarse';
    if (name === 'prefers-reduced-motion') return value === 'no-preference';
    throw new Error(`media feature not understood: ${part}`);
  }));
}

/** [ids, classes + attributes + pseudo-classes, types]; :is/:not/:has take their argument's, :where none. */
function specificity(selector: string): [number, number, number] {
  let s = selector.replace(/\[[^\]]*\]/g, '[]');
  const total: [number, number, number] = [0, 0, 0];
  const fn = /:(is|not|has|where)\(([^()]*)\)/;
  for (let m = fn.exec(s); m; m = fn.exec(s)) {
    if (m[1] !== 'where') {
      const inner = m[2].split(',').map(specificity).sort(compare).at(-1)!;
      inner.forEach((n, k) => { total[k] += n; });
    }
    s = s.replace(m[0], '');
  }
  total[0] += (s.match(/#[\w-]+/g) ?? []).length;
  total[1] += (s.match(/\.[\w-]+|\[\]|:[\w-]+/g) ?? []).length;
  total[2] += (s.replace(/[.#:][\w-]+|\[\]/g, ' ').match(/(^|[\s>+~])[a-zA-Z][\w-]*/g) ?? []).length;
  return total;
}

function compare(a: [number, number, number], b: [number, number, number]): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

const RULES = parseRules(readFileSync(resolve(__dirname, '../styles.css'), 'utf8'));

/** The cascaded `font-size` of `el` at a screen `width`, in px. */
function fontSizeAt(el: Element, width: number): number {
  let best: { important: boolean; spec: [number, number, number]; order: number; value: string } | null = null;
  for (const rule of RULES) {
    if (rule.media && !mediaApplies(rule.media, width)) continue;
    const decl = /(?:^|;)\s*font-size\s*:\s*([^;!]+?)\s*(!important)?\s*(?:;|$)/.exec(rule.body);
    if (!decl) continue;
    const matching = rule.selectors.filter(sel => !sel.includes('::') && el.matches(sel));
    if (matching.length === 0) continue;
    const candidate = { important: !!decl[2], spec: matching.map(specificity).sort(compare).at(-1)!, order: rule.order, value: decl[1] };
    const wins = !best
      || (candidate.important !== best.important ? candidate.important
        : compare(candidate.spec, best.spec) !== 0 ? compare(candidate.spec, best.spec) > 0
        : candidate.order > best.order);
    if (wins) best = candidate;
  }
  if (!best) throw new Error(`no font-size rule matches ${el.outerHTML}`);
  const px = /^(\d+(?:\.\d+)?)px$/.exec(best.value);
  if (!px) throw new Error(`font-size is not in px: ${best.value}`);
  return Number(px[1]);
}

function renderVitals() {
  return render(
    <StartingInfoVitals vitalsHistory={[]} unitSystem="si"
      onSave={vi.fn()} onCorrectValue={vi.fn()} onDraftValue={() => {}} formStage={3}
      plan={{ age: 50, idealBodyWeight: 73, heightCm: 178 }} unitOverrides={{}} onToggleFieldUnit={() => {}}/>,
  );
}

const PHONE = 390;
const DESKTOP = 1280;

describe('US-20 AC8: on a phone the vitals inputs are 16px, so iOS does not zoom on a tap', () => {
  it('both blood pressure inputs are 16px on a phone', () => {
    const view = renderVitals();
    for (const name of ['Systolic blood pressure', 'Diastolic blood pressure']) {
      const input = view.getByRole('textbox', { name });
      expect(input.closest('.bt-vitals-bp-inputs')).not.toBeNull();
      expect(fontSizeAt(input, PHONE)).toBe(16);
    }
  });

  it('every input in the vitals matrix is at least 16px on a phone', () => {
    const view = renderVitals();
    const inputs = [...view.container.querySelectorAll('input.bt-input')];
    expect(inputs.length).toBeGreaterThanOrEqual(4); // weight, waist, systolic, diastolic
    expect(inputs.map(input => fontSizeAt(input, PHONE)).filter(px => px < 16)).toEqual([]);
  });

  it('desktop is unchanged: the pair stays 13px, the other inputs 14px', () => {
    const view = renderVitals();
    const bp = [...view.container.querySelectorAll('.bt-vitals-bp-inputs input.bt-input')];
    expect(bp).toHaveLength(2);
    for (const input of bp) expect(fontSizeAt(input, DESKTOP)).toBe(13);
    const others = [...view.container.querySelectorAll('input.bt-input')].filter(input => !bp.includes(input));
    expect(others.length).toBeGreaterThan(0);
    for (const input of others) expect(fontSizeAt(input, DESKTOP)).toBe(14);
  });

  it('the resolver: specificity, media at each width, and a lone .bt-input on a phone', () => {
    const input = document.body.appendChild(document.createElement('input'));
    input.className = 'bt-input';
    expect(specificity('.bt-vitals-bp-inputs .bt-input')).toEqual([0, 2, 0]);
    expect(specificity('.health-tool .health-field input')).toEqual([0, 2, 1]);
    expect(specificity('.bt-cell-value:has(> .bt-vitals-bp-inputs)')).toEqual([0, 2, 0]);
    expect(mediaApplies('(max-width: 768px)', PHONE)).toBe(true);
    expect(mediaApplies('(max-width: 768px)', DESKTOP)).toBe(false);
    expect(mediaApplies('(hover: none) and (pointer: coarse)', PHONE)).toBe(true);
    expect(fontSizeAt(input, PHONE)).toBe(16); // the phone guard
    expect(fontSizeAt(input, DESKTOP)).toBe(14);
    input.remove();
  });
});
