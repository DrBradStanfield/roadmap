/**
 * A small CSS cascade for tests. jsdom ignores media queries and computes no cascade, so
 * this resolves a property from styles.css itself: the rules whose media apply on the given
 * screen and whose selector matches the element, ranked by !important, specificity, then
 * source order (the last declaration in a rule wins inside it). Lifted from
 * StartingInfoVitals.phone-font-size.test.tsx (US-20 AC8).
 *
 * What it models: top-level rules and rules in top-level @media (width, hover, pointer,
 * print, screen, prefers-reduced-motion); the declared value as written, with no inheritance,
 * no var() resolution and no computed values; `padding`/`margin` shorthands for their four
 * physical sides. Other shorthand/longhand pairs (inset, background, text-decoration, the
 * logical padding/margin sides) are not modelled: a matching rule that declares one of them
 * beside the asked property throws, so a test fails loudly instead of passing wrongly.
 * Pseudo-classes jsdom cannot hold are given to named elements through `states`.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export interface Rule { selectors: string[]; media: string | null; body: string; order: number }

/** Top-level rules and the rules inside top-level @media blocks; other at-rules are skipped. */
export function parseRules(source: string): Rule[] {
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
        rules.push({ selectors: splitTop(prelude, /,/), media, body: css.slice(open + 1, close - 1), order: rules.length });
      }
      i = close;
    }
  };
  walk(0, css.length, null);
  return rules;
}

/**
 * The screen a cascade runs on. A bare width is a touch screen (hover: none, pointer: coarse).
 * `hover: true` is a mouse. `states` names which element holds which pseudo-class (say
 * [[row, [':focus-within']]]): jsdom cannot hold them, so a whole pseudo-class in a selector
 * matches only on the element given it. Specificity counts it as written.
 */
export interface Screen { width: number; hover?: boolean; states?: Array<[Element, string[]]> }

/** Keyboard focus on `el`: it holds :focus, :focus-visible and :focus-within; its ancestors :focus-within. */
export function focusOn(el: Element): Array<[Element, string[]]> {
  const states: Array<[Element, string[]]> = [[el, [':focus', ':focus-visible', ':focus-within']]];
  for (let up = el.parentElement; up; up = up.parentElement) states.push([up, [':focus-within']]);
  return states;
}

/** Width features by number; hover and pointer from the screen; print never. */
export function mediaApplies(query: string, width: number, hover = false): boolean {
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
    if (name === 'hover') return value === (hover ? 'hover' : 'none');
    if (name === 'pointer') return value === (hover ? 'fine' : 'coarse');
    if (name === 'prefers-reduced-motion') return value === 'no-preference';
    throw new Error(`media feature not understood: ${part}`);
  }));
}

/** [ids, classes + attributes + pseudo-classes, types]; :is/:not/:has take their argument's, :where none. */
export function specificity(selector: string): [number, number, number] {
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

export function compare(a: [number, number, number], b: [number, number, number]): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

/** Splits on `sep` outside parentheses and quotes. */
function splitTop(text: string, sep: RegExp): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let from = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) { if (ch === quote && text[i - 1] !== '\\') quote = null; continue; }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (depth === 0 && sep.test(ch)) { parts.push(text.slice(from, i)); from = i + 1; }
  }
  parts.push(text.slice(from));
  return parts.map(p => p.trim()).filter(Boolean);
}

/** padding-top and the like also take their value from the `padding` shorthand. */
const BOX = /^(padding|margin)-(top|right|bottom|left)$/;
function sideOf(shorthand: string, side: string): string {
  const v = splitTop(shorthand, /\s/);
  const [top, right = top, bottom = top, left = right] = v;
  return { top, right, bottom, left }[side]!;
}

interface Decl { name: string; value: string; important: boolean }

/** A rule body's declarations, in order, values whitespace-collapsed and without !important. */
function parseBody(body: string): Decl[] {
  const out: Decl[] = [];
  for (const decl of splitTop(body, /;/)) {
    const colon = decl.indexOf(':');
    if (colon === -1) continue;
    let value = decl.slice(colon + 1).trim().replace(/\s+/g, ' ');
    const important = /!\s*important$/.test(value);
    if (important) value = value.replace(/\s*!\s*important$/, '');
    out.push({ name: decl.slice(0, colon).trim().toLowerCase(), value, important });
  }
  return out;
}

/** Properties that also set `property` but that this resolver does not model. */
function unmodelled(property: string): string[] {
  const box = BOX.exec(property);
  if (box) {
    const [, kind, side] = box;
    const axis = side === 'top' || side === 'bottom' ? 'block' : 'inline';
    return [`${kind}-${axis}`, `${kind}-${axis}-start`, `${kind}-${axis}-end`];
  }
  if (property === 'padding' || property === 'margin') {
    return ['top', 'right', 'bottom', 'left', 'block', 'inline', 'block-start', 'block-end', 'inline-start', 'inline-end'].map(p => `${property}-${p}`);
  }
  if (['top', 'right', 'bottom', 'left'].includes(property)) {
    return ['inset', ['top', 'bottom'].includes(property) ? 'inset-block' : 'inset-inline'];
  }
  if (property === 'inset') return ['top', 'right', 'bottom', 'left', 'inset-block', 'inset-inline'];
  if (property === 'background') return ['background-color', 'background-image'];
  if (property === 'background-color' || property === 'background-image') return ['background'];
  if (property === 'text-decoration') return ['text-decoration-line'];
  if (property === 'text-decoration-line') return ['text-decoration'];
  return [];
}

/** `selector` with each whole `pseudo` (not followed by a name character) replaced by `replacement`. */
function replacePseudo(selector: string, pseudo: string, replacement: string): string {
  const escaped = pseudo.replace(/[^\w-]/g, ch => `\\${ch}`);
  return selector.replace(new RegExp(`${escaped}(?![\\w-])`, 'g'), replacement);
}

export const STYLES = parseRules(readFileSync(resolve(__dirname, '../styles.css'), 'utf8'));

/** The cascaded value of `property` on `el`, as declared (whitespace collapsed), or undefined if no rule sets it. */
export function cascaded(el: Element, property: string, screen: number | Screen, rules: Rule[] = STYLES): string | undefined {
  const { width, hover = false, states = [] } = typeof screen === 'number' ? { width: screen } : screen;
  // Each state becomes an attribute on the element that holds it, and the same pseudo-class
  // in a selector becomes that attribute, so it matches only where the state is held.
  const marker = (pseudo: string) => `data-css-state-${pseudo.slice(1)}`;
  const pseudos = [...new Set(states.flatMap(([, list]) => list))];
  const asMatched = (sel: string) => pseudos.reduce((s, pseudo) => replacePseudo(s, pseudo, `[${marker(pseudo)}]`), sel);
  const box = BOX.exec(property);
  const siblings = unmodelled(property);
  let best: { important: boolean; spec: [number, number, number]; order: number; value: string } | null = null;
  for (const [holder, list] of states) for (const pseudo of list) holder.setAttribute(marker(pseudo), '');
  try {
    for (const rule of rules) {
      if (rule.media && !mediaApplies(rule.media, width, hover)) continue;
      const body = parseBody(rule.body);
      const decls = body.flatMap(d => d.name === property ? [d]
        : box && d.name === box[1] ? [{ ...d, value: sideOf(d.value, box[2]) }] : []);
      const sibling = body.find(d => siblings.includes(d.name));
      if (decls.length === 0 && !sibling) continue;
      const matching = rule.selectors.filter(sel => !sel.includes('::') && el.matches(asMatched(sel)));
      if (matching.length === 0) continue;
      if (sibling) throw new Error(`css-cascade does not model ${sibling.name} beside ${property}: rule ${rule.selectors.join(', ')}`);
      const decl = decls.filter(d => d.important).at(-1) ?? decls.at(-1)!;
      const candidate = { important: decl.important, spec: matching.map(specificity).sort(compare).at(-1)!, order: rule.order, value: decl.value };
      const wins = !best
        || (candidate.important !== best.important ? candidate.important
          : compare(candidate.spec, best.spec) !== 0 ? compare(candidate.spec, best.spec) > 0
          : candidate.order > best.order);
      if (wins) best = candidate;
    }
  } finally {
    for (const [holder, list] of states) for (const pseudo of list) holder.removeAttribute(marker(pseudo));
  }
  return best?.value;
}

/** Builds elements nested in the order given ("a b" is a div with those classes, "tag|a b" another tag), on the body; returns the innermost. */
export function nest(...classLists: string[]): HTMLElement {
  let parent: HTMLElement = document.body;
  classLists.forEach(cls => {
    const [tag, classes] = cls.includes('|') ? cls.split('|') : ['div', cls];
    const child = document.createElement(tag);
    child.className = classes;
    parent = parent.appendChild(child);
  });
  return parent;
}
