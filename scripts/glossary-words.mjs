// Retired-word check for docs/glossary.md. Each rule is one retired word of an agreed glossary entry, matched only
// where the entry retires it. `copy` is text people read: web and iPhone code (a phrase in string literals and JSX
// text, a single word in string literals only) and the user guides. `docs` is every other Markdown file outside the
// skipped folders. Comments, identifiers, log lines, tests, health-core agent code, the Shopify admin, the blog and
// dated docs are never scanned. Existing uses are recorded in glossary-words-baseline.json; only a rise fails.
// Run `node scripts/glossary-words.mjs` to check, `--write` to tighten the baseline by hand after a fix or seed a new rule.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const BASELINE_PATH = join(ROOT, 'scripts/glossary-words-baseline.json');

// `word` is quoted, as written, in the entry's "Retired" list in docs/glossary.md (glossary-words.test.ts checks).
// `keep` lists uses the entry keeps on purpose; a line it matches is not counted.
export const RULES = [
  { id: 'G3-wipe', entry: 'G3', word: 'wipe', re: /\bwip(?:e|ed|es|ing)\b/gi, where: ['copy'] },
  { id: 'G13-cloud-provider', entry: 'G13', word: 'cloud provider', re: /\bcloud providers?\b/gi, where: ['copy'] },
  { id: 'G13-cloud-account', entry: 'G13', word: 'cloud account', re: /\bcloud accounts?\b/gi, where: ['copy'] },
  { id: 'G21-ios-app', entry: 'G21', word: 'iOS app', re: /\biOS apps?\b/gi, where: ['copy', 'docs'] },
  { id: 'G21-native-app', entry: 'G21', word: 'native app', re: /\bnative apps?\b/gi, where: ['copy', 'docs'] },
  { id: 'G25-healthkit', entry: 'G25', word: 'HealthKit', re: /\bHealthKit\b/g, where: ['copy'], keep: [/Apple \d{4} – HealthKit/] },
];

const HISTORY = /^(docs\/(blog|untangle|drafts|reviews|knowledge-refresh|chat-question-archive|examples|chatbot)\/|CHANGELOG\.md$|docs\/glossary\.md$|docs\/user-stories\.md$)|20\d\d-\d\d/;
const TESTS = /\.(test|spec)\.|\.golden\.|test-helpers|\.fixtures\.|(^|\/)(tests?|__tests__|__snapshots__|fixtures?|testing)\/|^ios\/HealthRoadmap(UI)?Tests\//;
const COPY_CODE = /^(widget-src\/(src|standalone)|ios\/(HealthRoadmap|engine)|app\/routes|packages\/health-core\/src)\/.*\.(tsx?|swift)$/;
// Code in those folders whose strings people do not read: agent text, the Shopify admin, the engine's bridge contract.
const NOT_COPY = /^(packages\/health-core\/src\/(mcp-|chat-|lab-extraction|models\.ts)|app\/routes\/app\.|ios\/engine\/(contract|golden))/;
// A log line is developer text, not copy.
const LOG = /\b(console|logger|log)\.(log|warn|warning|error|info|debug|notice|fault)\(/;
const LOOP_HISTORY = /^docs\/loops\/(?!(LOOP|REGISTRY)\.md$)/;

/** Which surface a tracked path is, or null when it is not scanned. */
export function surfaceOf(path) {
  if (HISTORY.test(path) || TESTS.test(path)) return null;
  if (/^docs\/guides\/.*\.md$/.test(path)) return 'copy';
  if (COPY_CODE.test(path)) return NOT_COPY.test(path) ? null : 'copy';
  if (/\.md$/.test(path) && !LOOP_HISTORY.test(path)) return 'docs';
  return null;
}

const blank = (s) => s.replace(/[^\n]/g, ' ');
const QUOTES = ['"""', '"', "'", '`'];

/** Where a comment that starts at i ends, or -1 when none starts there. */
function commentEnd(src, i) {
  if (src.startsWith('//', i)) { const e = src.indexOf('\n', i); return e < 0 ? src.length : e; }
  if (src.startsWith('/*', i)) { const e = src.indexOf('*/', i + 2); return e < 0 ? src.length : e + 2; }
  return -1;
}

/** Where the body of a string opened by quote q ends. A single or double quote also ends at the line. */
function stringEnd(src, from, q) {
  const oneLine = q === '"' || q === "'";
  let j = from;
  while (j < src.length && !src.startsWith(q, j) && !(oneLine && src[j] === '\n')) j += src[j] === '\\' ? 2 : 1;
  return j;
}

function maskCode(src) {
  let text = '', strings = '', i = 0;
  const gap = (part) => { text += blank(part); strings += blank(part); };
  while (i < src.length) {
    const c = commentEnd(src, i);
    if (c >= 0) { gap(src.slice(i, c)); i = c; continue; }
    const q = QUOTES.find((x) => src.startsWith(x, i));
    if (!q) { text += src[i]; strings += blank(src[i]); i++; continue; }
    const j = stringEnd(src, i + q.length, q);
    gap(q); text += src.slice(i + q.length, j); strings += src.slice(i + q.length, j); gap(src.slice(j, j + q.length));
    i = j + q.length;
  }
  return { text, strings };
}

/** Blank everything a rule must not read, keeping line breaks: `text` drops comments (and code in Markdown),
 *  `strings` keeps only the inside of string literals. A phrase with a space cannot be an identifier, so it is
 *  matched in `text` (which also holds JSX text); a single word is matched in `strings` only. */
export function mask(src, path) {
  if (!path.endsWith('.md')) return maskCode(src);
  const t = src.replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1[^\n]*$/gm, blank).replace(/<!--[\s\S]*?-->/g, blank).replace(/`[^`\n]*`/g, blank);
  return { text: t, strings: t };
}

/** True when a line holds a use the scan does not count: a log line in code, or a use the rule keeps. */
const skipped = (rule, surface, line) => (surface === 'copy' && LOG.test(line)) || (rule.keep ?? []).some((k) => k.test(line));

/** Uses of each rule in one file: [{ rule, line, text }]. */
export function scan(path, src, rules = RULES) {
  const surface = surfaceOf(path);
  if (!surface) return [];
  const masked = mask(src, path);
  const raw = src.split('\n');
  const hits = [];
  for (const rule of rules.filter((r) => r.where.includes(surface))) {
    const view = (/\s/.test(rule.word) ? masked.text : masked.strings).split('\n');
    view.forEach((line, n) => {
      if (skipped(rule, surface, raw[n])) return;
      for (const _ of line.matchAll(rule.re)) hits.push({ rule: rule.id, line: n + 1, text: raw[n].trim() });
    });
  }
  return hits;
}

/** { ruleId: { path: count } } over the files git tracks under root. */
export function countAll(root = ROOT) {
  const files = execFileSync('git', ['ls-files', '-z'], { cwd: root }).toString().split('\0').filter((f) => surfaceOf(f));
  const out = Object.fromEntries(RULES.map((r) => [r.id, {}]));
  for (const f of files.filter((f) => existsSync(join(root, f)))) {
    for (const h of scan(f, readFileSync(join(root, f), 'utf8'))) out[h.rule][f] = (out[h.rule][f] ?? 0) + 1;
  }
  return out;
}

/** Each (rule, file, count) in a { ruleId: { path: count } } table. */
const cells = (table) => Object.entries(table).flatMap(([rule, files]) => Object.entries(files).map(([f, n]) => [rule, f, n]));
const at = (table, rule, f) => table[rule]?.[f] ?? 0;
const wordOf = (rule) => RULES.find((r) => r.id === rule).word;

const grownLine = (baseline, [rule, f, n]) => (rule in baseline
  ? `${f}: "${wordOf(rule)}" count ${n}, recorded ${at(baseline, rule, f)}. docs/glossary.md retires it (${rule}); use the entry's word.`
  : `${f}: ${rule} has no baseline yet. Seed it: node scripts/glossary-words.mjs --write`);

/** Problems between a baseline and today's counts: a new or grown use fails; a count that fell passes (Brad 2026-11-28). */
export const compare = (baseline, now) =>
  cells(now).filter(([rule, f, n]) => n > at(baseline, rule, f)).map((cell) => grownLine(baseline, cell));

/** What --write stores: today's counts, sorted. It refuses to raise a rule the baseline already has, and seeds a new one. */
export function nextBaseline(baseline, now) {
  const refused = cells(now).filter(([rule, f, n]) => rule in baseline && n > at(baseline, rule, f)).map((cell) => grownLine(baseline, cell));
  const next = Object.fromEntries(Object.entries(now).map(([r, fs]) => [r, Object.fromEntries(Object.entries(fs).sort())]));
  return { refused, next };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const now = countAll();
  const baseline = existsSync(BASELINE_PATH) ? JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) : {};
  const problems = compare(baseline, now);
  if (process.argv.includes('--write')) {
    const { refused, next } = nextBaseline(baseline, now);
    if (refused.length) { console.error(`Refusing to raise the baseline:\n${refused.join('\n')}`); process.exit(1); }
    writeFileSync(BASELINE_PATH, JSON.stringify(next, null, 2) + '\n');
  } else if (problems.length) {
    console.error(problems.join('\n'));
    process.exit(1);
  }
}
