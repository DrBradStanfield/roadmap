// Explicit-any ratchet (US-64 AC42). App and test TypeScript add no explicit `any`; a file's count can only fall.
// `node scripts/explicit-any-baseline.mjs --write` lowers or removes entries in explicit-any-baseline.json.
// It refuses to raise one, and adds none unless `--allow-new` is passed.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { ROOT, generatedFiles } from './file-size-baseline.mjs';

export const BASELINE_PATH = join(ROOT, 'scripts/explicit-any-baseline.json');

/** Explicit `any` in one file: each `any` keyword the parser sees as a type. Comments, strings and names do not count. */
export function countExplicitAny(sourceText, fileName) {
  if (!/\bany\b/.test(sourceText)) return 0; // no word `any`, no keyword: skip the parse
  const kind = fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS; // .mts/.cts parse as TS
  let n = 0;
  const visit = (node) => {
    if (node.kind === ts.SyntaxKind.AnyKeyword) n++;
    ts.forEachChild(node, visit);
  };
  visit(ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, false, kind));
  return n;
}

export const readBaseline = () => JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
export const isScanned = (f) => /\.[cm]?tsx?$/.test(f); // .ts/.tsx/.mts/.cts, hand-written .d.ts/.d.mts included; not .mjs/.js
/** Every tracked file isScanned keeps, minus files the file-size tool marks GENERATED. */
export function scannedFiles() {
  const generated = new Set(generatedFiles());
  return execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, maxBuffer: 1 << 26 }).toString().split('\0')
    .filter((f) => isScanned(f) && !generated.has(f) && existsSync(join(ROOT, f)));
}

/** Files with at least one explicit `any` today: { file: count }. */
export function anyCounts() {
  return Object.fromEntries(scannedFiles()
    .map((f) => [f, countExplicitAny(readFileSync(join(ROOT, f), 'utf8'), f)])
    .filter(([, n]) => n > 0));
}

export const WRITE_CMD = 'node scripts/explicit-any-baseline.mjs --write';

/** Baseline files whose count rose: remove one, never add one. */
export const grown = (files, now) => Object.entries(files)
  .filter(([f, recorded]) => (now[f] ?? 0) > recorded)
  .map(([f, recorded]) => `${f}: recorded ${recorded} explicit any, now ${now[f]}. Give it a real type or unknown.`);

/** Files with an explicit `any` and no baseline entry, so every new file starts with none. */
export const fresh = (files, now) => Object.entries(now)
  .filter(([f]) => !(f in files))
  .map(([f, n]) => `${f}: ${n} explicit any and not in the baseline. Give it a real type or unknown.`);

/** Baseline entries above today's count: a file now at 0 or gone (stale), or below its recorded count (loose). */
export function loose(files, now, exists = (f) => existsSync(join(ROOT, f))) {
  const stale = Object.keys(files)
    .filter((f) => !(f in now))
    .map((f) => `${f}: ${exists(f) ? 'now 0 explicit any' : 'no longer exists'}. Delete its entry: run \`${WRITE_CMD}\`.`);
  const lower = Object.entries(files)
    .filter(([f, recorded]) => f in now && now[f] < recorded)
    .map(([f, recorded]) => `${f}: recorded ${recorded} explicit any, now ${now[f]}. Lower the entry: run \`${WRITE_CMD}\`.`);
  return [...stale, ...lower];
}

const sorted = (o) => Object.fromEntries(Object.entries(o).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)));

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (!args.includes('--write')) {
    console.error('usage: node scripts/explicit-any-baseline.mjs --write [--allow-new]');
    process.exit(2);
  }
  const allowNew = args.includes('--allow-new');
  const old = existsSync(BASELINE_PATH) ? readBaseline() : { exceptions: {}, files: {} };
  const next = {};
  const problems = [];
  for (const [f, n] of Object.entries(anyCounts())) {
    if (!(f in old.files)) {
      if (!allowNew) problems.push(`${f}: ${n} explicit any, not in the baseline. Type it; --allow-new adds entries only at creation.`);
      else next[f] = n;
    } else if (n > old.files[f]) problems.push(`${f}: ${n} explicit any, recorded ${old.files[f]}. Refusing to raise an entry.`);
    else next[f] = n;
  }
  if (problems.length) {
    console.error(problems.join('\n'));
    process.exit(1);
  }
  writeFileSync(BASELINE_PATH, JSON.stringify({ exceptions: old.exceptions, files: sorted(next) }, null, 2) + '\n');
  console.log(`baseline: ${Object.keys(next).length} files, ${Object.values(next).reduce((a, b) => a + b, 0)} explicit any`);
}
