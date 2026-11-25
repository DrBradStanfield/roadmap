/**
 * A seeded generator of report_feedback text, built from the guard's own
 * tokenizer operations rather than from examples (US-32 AC9b): a name, filler
 * words, a number glued to a name, to the end of a filler word or in front of
 * a name, the separators the tokenizer splits on, and units glued or spaced.
 * Test support only: the gate test in mcp-tools.test.ts reads it, and the
 * frozen corpus beside it was generated from it.
 */
import { LAB_CATALOG, metricNameWords } from '../lab-catalog';
import { EXTRA_METRIC_NAMES, SCRUB_UNITS } from '../scrub-vocabulary';
import { UNIT_DEFS } from '../units';

/** mulberry32: a small seeded PRNG, so a failure reproduces from its seed. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const NAMES = [...new Set([
  ...metricNameWords(2),
  ...LAB_CATALOG.flatMap((entry) => [entry.label, ...entry.aliases]),
  ...EXTRA_METRIC_NAMES,
])];
const UNITS = [...new Set([
  ...SCRUB_UNITS,
  ...Object.values(UNIT_DEFS).flatMap((def) => [def.canonical, def.label.si, def.label.conventional]),
])];
const FILLERS = ['the', 'my', 'row', 'is', 'was', 'shows', 'set', 'to', 'value', 'tab', 'page', 'at', 'of', 'on',
  'plan', 'reads', 'it', 'and', 'then', 'saved', 'line', 'chart', 'after'];
const SEPARATORS = [' ', '\n', '_', ',', '.', '-', ':'];

/** `count` generated strings for `seed`; the same seed gives the same strings. */
export function generateFeedbackStrings(seed: number, count: number): string[] {
  const random = prng(seed);
  const pick = <T>(list: readonly T[]): T => list[Math.floor(random() * list.length)];
  const chance = (p: number) => random() < p;
  const number = () => {
    const whole = String(Math.floor(random() * (chance(0.5) ? 10 : 1000)));
    if (chance(0.3)) return `${whole}${pick(['.', ','])}${Math.floor(random() * 100)}`;
    if (chance(0.1)) return `${whole}/${Math.floor(random() * 100)}`;
    return whole;
  };
  // Optional whitespace inside the parentheses of a name: "lp( a )", "urea (bun )".
  const name = () => pick(NAMES).replace(/\(|\)/g, (paren) =>
    paren === '(' ? `${chance(0.5) ? ' ' : ''}(${chance(0.5) ? ' ' : ''}` : `${chance(0.5) ? ' ' : ''})`);
  const value = () => {
    const n = number();
    return chance(0.4) ? `${n}${chance(0.5) ? ' ' : ''}${pick(UNITS)}` : n;
  };

  const out: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const fillers = Math.floor(random() * 5);
    const before = Math.floor(random() * (fillers + 1));
    const tokens = [
      ...Array.from({ length: before }, () => pick(FILLERS)),
      name(),
      ...Array.from({ length: fillers - before }, () => pick(FILLERS)),
    ];
    const at = before; // the name's index
    switch (Math.floor(random() * 5)) {
      case 0: tokens[at] += value(); break; // glued to the name
      case 1: { // glued to the end of a filler word
        const filler = tokens.findIndex((_, k) => k !== at && chance(0.5));
        if (filler >= 0) tokens[filler] += value(); else tokens.push(value());
        break;
      }
      case 2: tokens[at] = `${number()}${tokens[at]}`; break; // glued in front of the name
      case 3: tokens.splice(at, 0, value()); break; // in front of the name, its own word
      default: tokens.splice(Math.floor(random() * (tokens.length + 1)), 0, value()); // anywhere
    }
    out.push(tokens.reduce((text, token) => `${text}${pick(SEPARATORS)}${token}`));
  }
  return out;
}
