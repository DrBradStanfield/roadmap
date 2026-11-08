// File-size ratchet (US-64 AC23). Brad 2026-11-09, CLAUDE.md "File budgets": production code files
// target 300-500 lines; a file over 500 never grows (split it first).
// `node scripts/file-size-baseline.mjs --write` lowers or removes entries in file-size-baseline.json.
// It refuses to raise one, and adds none unless `--allow-new` is passed.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const LIMIT = 500;
export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const BASELINE_PATH = join(ROOT, 'scripts/file-size-baseline.json');
export const REGEN_CMD = 'node scripts/file-size-baseline.mjs --write';

const CODE = /\.(ts|tsx|js|mjs|cjs|swift)$/;
const ROOTS = /^((app|widget-src\/src|widget-src\/standalone|packages\/health-core\/src|ios|tools|scripts|\.claude\/hooks)\/|[^/]+$)/;
const NOT_PROD =
  /^(ios\/engine-release|extensions\/health-tool-widget\/assets)\/|\.(test|spec)\.|\.golden\.|\.config\.(ts|mjs)$|\.d\.ts$|(^|\/)(tests?|__tests__|fixtures?|dist|build|generated)\/|[A-Za-z]Tests?\//;

export const lineCount = (file) => {
  const buf = readFileSync(join(ROOT, file));
  let n = 0;
  for (const b of buf) if (b === 10) n++;
  return n + (buf.length && buf[buf.length - 1] !== 10 ? 1 : 0);
};

export function readBaseline() {
  return JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
}

/** Tracked production files (before the exempt list), with their line counts. */
export function productionFiles() {
  const out = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, maxBuffer: 1 << 26 }).toString().split('\0');
  return out
    .filter((f) => f && CODE.test(f) && ROOTS.test(f) && !NOT_PROD.test(f) && existsSync(join(ROOT, f)))
    .map((f) => [f, lineCount(f)]);
}

/** Files over the limit today, minus the exempt ones: { file: lines }. */
export function overLimit(exempt) {
  const skip = new Set(Object.keys(exempt));
  return Object.fromEntries(
    productionFiles().filter(([f, n]) => n > LIMIT && !skip.has(f)).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)),
  );
}

const sorted = (o) => Object.fromEntries(Object.entries(o).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)));

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (!args.includes('--write')) {
    console.error(`usage: node scripts/file-size-baseline.mjs --write [--allow-new]`);
    process.exit(2);
  }
  const allowNew = args.includes('--allow-new');
  const old = existsSync(BASELINE_PATH) ? readBaseline() : { files: {}, exempt: {} };
  const now = overLimit(old.exempt);
  const next = {};
  const problems = [];
  for (const [f, n] of Object.entries(now)) {
    if (!(f in old.files)) {
      if (!allowNew) problems.push(`${f}: ${n} lines, not in the baseline. Split it below ${LIMIT}; --allow-new adds entries only at creation.`);
      else next[f] = n;
    } else if (n > old.files[f]) problems.push(`${f}: ${n} lines, recorded ${old.files[f]}. Refusing to raise an entry. Split it first.`);
    else next[f] = n;
  }
  if (problems.length) {
    console.error(problems.join('\n'));
    process.exit(1);
  }
  writeFileSync(BASELINE_PATH, JSON.stringify({ limit: LIMIT, exempt: old.exempt, files: sorted(next) }, null, 2) + '\n');
  console.log(`baseline: ${Object.keys(next).length} files over ${LIMIT}`);
}
