#!/usr/bin/env node
// Untangle finish measures (US-64 AC29, .claude/skills/untangle): size, mode flags, special cases,
// git co-change and fan-in/fan-out for the given production files or folders. Trend numbers from
// regexes, not verdicts: run it before and after an untangle and compare.
// Usage: node tools/untangle-measures.mjs <path...> [--since 2026-10-01] [--json]
import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const CAP = 500;
const PROD_EXT = new Set(['.ts', '.tsx', '.swift', '.mjs']);
const LIT = `(?:'[\\w.-]+'|"[\\w.-]+"|\`[\\w.-]+\`)`;
// Commits touching more files than this are bulk sweeps (renames, lint passes); they would pair everything.
export const SWEEP_FILES = 40;

export const LEGEND = {
  note: 'Regex counts over comment-stripped source. A trend number to compare before and after, not a verdict.',
  refFlag: 'a useRef<...> whose type names boolean, number or a timer; or an untyped useRef() whose start value is true, false, null, undefined, a number or nothing (so an untyped DOM ref, useRef(null), counts too)',
  boolState: 'useState<boolean>(...), useState(true|false) or useState(!x)',
  timers: 'setTimeout( calls; clearTimeout is their pair and not counted again',
  specialCases: "per line: each ==, ===, != or !== between a name and one string literal (either side), counted when the line has `if (` before it or a ternary `?` (not ?? or ?.) after it; skipped when the name's last part is type, kind, mode, state, phase or status (a union read, the cure), or it is typeof x or document.*",
  coChange: `pairs from git log --no-merges, top 3 per file (top 10 overall for one path); skips docs/user-stories.{md,html}, docs/reference.md, scripts/file-size-baseline.json, lockfiles, extensions/*/assets and a file with its own tests, then commits still over ${SWEEP_FILES} files; history before a rename is not followed`,
  fanInOut: 'relative import/export-from/import() specifiers only; approximate',
};

/** One test rule for the measures and for co-change: foo.test.ts, foo.spec.tsx, __tests__/, tests/, FooTests.swift, AppTests/. */
export function isTestFile(path) {
  return /\.(test|spec)\.|\/__tests__\/|(^|\/)[^/]*Tests(\.swift|\/)|(^|\/)tests?\//.test(path.split(sep).join('/'));
}

export function isProductionFile(path) {
  return PROD_EXT.has(extname(path)) && !path.endsWith('.d.ts') && !isTestFile(path);
}

/** Drops block and line comments; keeps line count. Crude: a `//` inside a string after a space is cut too. */
export function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ''))
    .replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
}

export function size(text) {
  const lines = text.length === 0 ? 0 : text.replace(/\n$/, '').split('\n').length;
  return { lines, overCap: lines > CAP };
}

const count = (text, re) => (text.match(re) || []).length;

// Every `name ==/=== 'literal'` (either order) in a line.
const CMP = new RegExp(`([\\w.$]+)\\s*[!=]==?\\s*${LIT}|${LIT}\\s*[!=]==?\\s*([\\w.$]+)`, 'g');
// A union read (`s.phase === 'idle'`) is the named-state cure, not a special case; nor is the browser's own state.
const SKIP_NAME = /(^|\.)(type|kind|mode|state|phase|status)$|^document\.|^typeof$/i;

export function modeFlags(source) {
  const text = stripComments(source);
  let refFlag = 0;
  for (const [, generic, arg] of text.matchAll(/useRef\s*(<[^\n]*?>)?\(\s*([^)\n]*?)\s*\)/g)) {
    const flag = generic ? /\b(boolean|number|Timeout|setTimeout|setInterval)\b/.test(generic) : /^(true|false|null|undefined|-?\d[\d.]*|)$/.test(arg);
    if (flag) refFlag++;
  }
  const boolState = count(text, /useState\s*<\s*boolean\s*>\s*\(|useState\s*\(\s*(?:(?:true|false)\s*\)|!)/g);
  const timers = count(text, /\bsetTimeout\s*\(/g);
  return { refFlag, boolState, timers, total: refFlag + boolState + timers };
}

export function specialCases(source) {
  let n = 0;
  for (const line of stripComments(source).split('\n')) {
    for (const m of line.matchAll(CMP)) {
      const before = line.slice(0, m.index);
      if (SKIP_NAME.test(m[1] ?? m[2]) || /typeof\s*\(?\s*$/.test(before)) continue;
      if (/\bif\s*\(/.test(before) || /(^|[^?])\?(?![?.])/.test(line.slice(m.index + m[0].length))) n++;
    }
  }
  return n;
}

/** Relative specifiers a file imports (import, export-from, side-effect import, dynamic import()). */
export function importsOf(source) {
  const text = stripComments(source);
  const out = new Set();
  const re = /(?:\bfrom\s*|\bimport\s*\(?\s*)(['"])(\.{1,2}\/[^'"]+)\1/g;
  for (const m of text.matchAll(re)) out.add(m[2]);
  return [...out];
}

const TRY = ['', '.ts', '.tsx', '.mjs', '.js', '/index.ts', '/index.tsx', '/index.mjs'];
/** Resolves a relative specifier against a set of repo-relative paths; null when nothing matches. */
export function resolveImport(fromFile, spec, fileSet) {
  const base = join(dirname(fromFile), spec).split(sep).join('/');
  const stems = [base, base.replace(/\.(m?js)$/, '')];
  for (const stem of stems) for (const ext of TRY) if (fileSet.has(stem + ext)) return stem + ext;
  return null;
}

/** importMap: Map<file, resolved imports[]>. Returns fan-in (prod and test importers) and fan-out. */
export function fanInOut(file, importMap) {
  const importers = [...importMap].filter(([from, targets]) => from !== file && targets.includes(file)).map(([f]) => f);
  const fanIn = importers.filter(isProductionFile).length;
  return { fanIn, testsIn: importers.length - fanIn, fanOut: (importMap.get(file) || []).length };
}

/** Parses `git log --format=%x00%H --name-only` output into [{ sha, files }]. */
export function parseGitLog(stdout) {
  const chunks = stdout.split('\0').map((chunk) => chunk.split('\n').map((l) => l.trim()).filter(Boolean));
  return chunks.filter((lines) => lines.length > 0).map(([sha, ...files]) => ({ sha, files }));
}

export function isExcludedFromCoChange(path) {
  return (
    /^(docs\/user-stories\.(md|html)|docs\/reference\.md|scripts\/file-size-baseline\.json)$/.test(path) ||
    /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|Package\.resolved|[^/]+\.lock)$/.test(path) ||
    /^extensions\/[^/]+\/assets\//.test(path)
  );
}

const stem = (p) => (p.endsWith('.swift') ? p.split('/').pop().replace(/\.swift$/, '') : p.replace(/\.[^./]+$/, ''));
// A test's possible subjects: foo.test.ts -> foo; foo.case.test.ts -> foo.case or foo; FooTests.swift -> Foo.
const testSubjects = (p) => {
  if (p.endsWith('.swift')) return [stem(p).replace(/Tests$/, '')];
  const s = p.replace(/\.(test|spec)\.[^./]+$/, '');
  return [s, s.replace(/\.[^./]+$/, '')];
};
/** True when one is the other's own test (foo.ts with foo.test.tsx or foo.case.test.tsx; Foo.swift with FooTests.swift). */
export function isTestSubjectPair(a, b) {
  if (isTestFile(a) === isTestFile(b)) return false;
  const [test, subject] = isTestFile(a) ? [a, b] : [b, a];
  return testSubjects(test).includes(stem(subject));
}

/** Top co-change pairs where at least one file passes inTarget. */
export function coChange(commits, inTarget, top = Infinity) {
  const per = new Map();
  const pairs = new Map();
  for (const { files: raw } of commits) {
    const files = [...new Set(raw)].filter((f) => !isExcludedFromCoChange(f));
    if (files.length > SWEEP_FILES) continue;
    for (const f of files) per.set(f, (per.get(f) || 0) + 1);
    for (let i = 0; i < files.length; i++) {
      for (let j = i + 1; j < files.length; j++) {
        const [a, b] = [files[i], files[j]].sort();
        if (!inTarget(a) && !inTarget(b)) continue;
        if (isTestSubjectPair(a, b)) continue;
        const k = `${a}\n${b}`;
        pairs.set(k, (pairs.get(k) || 0) + 1);
      }
    }
  }
  return [...pairs]
    .map(([k, n]) => {
      const [a, b] = k.split('\n');
      return { a, b, count: n, shareA: n / per.get(a), shareB: n / per.get(b) };
    })
    .sort((x, y) => y.count - x.count || x.a.localeCompare(y.a) || x.b.localeCompare(y.b))
    .slice(0, top);
}

/** The top k pairs for each file, from coChange's ranked list, so one busy file cannot crowd out the rest. */
export function topPerFile(pairs, files, k = 3) {
  return Object.fromEntries(files.map((f) => [f, pairs.filter((p) => p.a === f || p.b === f).slice(0, k)]));
}

// ---------- CLI ----------
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const git = (args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });

// Symlinks are never followed (lstat), so a linked folder cannot pull in files from outside the repo.
function walk(abs, out) {
  const st = lstatSync(abs);
  if (st.isSymbolicLink()) return;
  if (st.isDirectory()) {
    for (const name of readdirSync(abs)) if (name !== 'node_modules' && !name.startsWith('.')) walk(join(abs, name), out);
  } else out.push(abs);
}

export function parseArgs(argv) {
  const opts = { paths: [], since: '2026-10-01', json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') opts.json = true;
    else if (a === '--since') opts.since = argv[++i];
    else if (a.startsWith('--since=')) opts.since = a.slice(8);
    else if (a.startsWith('-')) throw new Error(`unknown option ${a}`);
    else opts.paths.push(a);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(opts.since ?? '')) throw new Error('--since takes a date: YYYY-MM-DD');
  if (opts.paths.length === 0) throw new Error('give at least one file or folder');
  return opts;
}

/** A test for "inside one of these repo-relative targets"; '' is the repo root and holds every file. */
export const inTargets = (targets) => (f) => targets.some((t) => t === '' || f === t || f.startsWith(`${t}/`));

/** Repo-relative path, or throws when the path leaves the repo. */
export function insideRepo(root, p) {
  const rel = relative(root, realpathSync(resolve(p)));
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`refused: ${p} is outside the repo`);
  }
  return rel.split(sep).join('/');
}

function measure(opts) {
  const root = realpathSync(ROOT);
  const targets = opts.paths.map((p) => insideRepo(root, p));
  const files = [];
  for (const t of targets) walk(join(root, t), files);
  const prod = [...new Set(files.map((f) => relative(root, f).split(sep).join('/')))].filter(isProductionFile).sort();

  const tracked = git(['ls-files', '-z']).split('\0').filter(Boolean);
  const fileSet = new Set(tracked);
  for (const f of prod) fileSet.add(f);
  const importMap = new Map();
  for (const f of fileSet) {
    if (!/\.(tsx?|mjs|js)$/.test(f) || f.includes('node_modules/')) continue;
    let text;
    try { text = readFileSync(join(root, f), 'utf8'); } catch { continue; }
    importMap.set(f, importsOf(text).map((s) => resolveImport(f, s, fileSet) ?? `?${s}`));
  }

  const rows = prod.map((f) => {
    const text = readFileSync(join(root, f), 'utf8');
    const fan = f.endsWith('.swift') ? { fanIn: null, testsIn: null, fanOut: null } : fanInOut(f, importMap);
    return { path: f, ...size(text), modeFlags: modeFlags(text), specialCases: specialCases(text), ...fan };
  });
  const inTarget = inTargets(targets);
  const log = git(['log', `--since=${opts.since}`, '--name-only', '--no-merges', '--format=%x00%H']);
  const commits = parseGitLog(log);
  const sum = (k) => rows.reduce((n, r) => n + (k(r) ?? 0), 0);
  const totals = {
    files: rows.length,
    lines: sum((r) => r.lines),
    overCap: rows.filter((r) => r.overCap).map((r) => r.path),
    modeFlags: sum((r) => r.modeFlags.total),
    specialCases: sum((r) => r.specialCases),
  };
  const pairs = coChange(commits, inTarget);
  const co = { perFile: topPerFile(pairs, prod), overall: targets.length === 1 ? pairs.slice(0, 10) : null };
  return { since: opts.since, commits: commits.length, files: rows, totals, coChange: co, legend: LEGEND };
}

const pct = (x) => `${Math.round(x * 100)}%`;
export function formatText(r) {
  const out = [`Untangle measures (since ${r.since}, ${r.commits} commits). ${LEGEND.note}`, ''];
  out.push('lines  over  ref bool timer | special | fanIn tests fanOut  file');
  for (const f of r.files) {
    const m = f.modeFlags;
    const fan = f.fanIn === null ? '    -     -      -' : `${String(f.fanIn).padStart(5)} ${String(f.testsIn).padStart(5)} ${String(f.fanOut).padStart(6)}`;
    out.push(`${String(f.lines).padStart(5)}  ${f.overCap ? ' yes' : '    '}  ${String(m.refFlag).padStart(3)} ${String(m.boolState).padStart(4)} ${String(m.timers).padStart(5)} | ${String(f.specialCases).padStart(7)} | ${fan}  ${f.path}`);
  }
  const t = r.totals;
  out.push('', `Totals: ${t.files} files, ${t.lines} lines, mode flags ${t.modeFlags}, special cases ${t.specialCases}, over ${CAP}: ${t.overCap.join(', ') || 'none'}`);
  const line = (n, s1, s2, text) => `${String(n).padStart(6)}  ${pct(s1).padStart(4)} ${pct(s2).padStart(4)}  ${text}`;
  out.push('', 'Co-change, top 3 per file (count, share of this file\'s commits, share of the other\'s):');
  for (const [f, pairs] of Object.entries(r.coChange.perFile)) {
    out.push(`  ${f}`);
    for (const p of pairs) out.push(p.a === f ? line(p.count, p.shareA, p.shareB, p.b) : line(p.count, p.shareB, p.shareA, p.a));
    if (pairs.length === 0) out.push('        none');
  }
  if (r.coChange.overall) {
    out.push('', 'Co-change, top 10 overall (count, share of each file\'s commits):');
    for (const p of r.coChange.overall) out.push(line(p.count, p.shareA, p.shareB, `${p.a} <-> ${p.b}`));
  }
  out.push('', 'Legend:', ...Object.entries(LEGEND).filter(([k]) => k !== 'note').map(([k, v]) => `  ${k}: ${v}`));
  return out.join('\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try {
    const opts = parseArgs(process.argv.slice(2));
    const r = measure(opts);
    process.stdout.write(`${opts.json ? JSON.stringify(r, null, 2) : formatText(r)}\n`);
  } catch (e) {
    process.stderr.write(`untangle-measures: ${e.message}\n`);
    process.exit(2);
  }
}
