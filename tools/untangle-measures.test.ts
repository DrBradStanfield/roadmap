/**
 * US-64 AC29: tools/untangle-measures.mjs gives the untangle's finish measures as numbers. Each pure measure is fed a
 * fixture and checked for what a caller sees; the CLI is run once for its refusals. No network.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  size,
  modeFlags,
  specialCases,
  importsOf,
  resolveImport,
  fanInOut,
  parseGitLog,
  coChange,
  topPerFile,
  isProductionFile,
  parseArgs,
  insideRepo,
  inTargets,
  isTestFile,
} from './untangle-measures.mjs';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'untangle-measures.mjs');
const ROOT = realpathSync(join(dirname(SCRIPT), '..'));

describe('size (US-64 AC29)', () => {
  it('counts lines and flags a file over the 500-line cap', () => {
    expect(size('a\nb\nc\n')).toEqual({ lines: 3, overCap: false });
    expect(size('x\n'.repeat(501))).toEqual({ lines: 501, overCap: true });
    expect(size('')).toEqual({ lines: 0, overCap: false });
  });
});

describe('modeFlags (US-64 AC29)', () => {
  it('counts flag refs, boolean state and timers, and skips the rest', () => {
    const src = [
      'const busy = useRef(false);',
      'const count = useRef(0);',
      'const held = useRef(null);', // untyped null: counted, as the legend says
      'const t = useRef<ReturnType<typeof setTimeout> | null>(null);',
      'const el = useRef<HTMLDivElement>(null);', // a typed DOM ref: not a mode
      'const cb = useRef<(() => void) | null>(null);', // a callback ref: not a mode
      'const list = useRef([]);', // not a flag
      'const [open, setOpen] = useState(false);',
      'const [on, setOn] = useState<boolean>(initial);',
      'const [shown, setShown] = useState(!saved);',
      'const [n, setN] = useState(0);', // not boolean
      'const id = setTimeout(() => setOpen(false), 200);',
      'clearTimeout(id);',
      "if (s.phase === 'idle') go();", // a union read: never a flag
      '// const x = useRef(false);',
    ].join('\n');
    expect(modeFlags(src)).toEqual({ refFlag: 4, boolState: 3, timers: 1, total: 8 });
  });
});

describe('specialCases (US-64 AC29)', () => {
  it('counts an if or ternary testing one literal id, not typeof, union reads, ?? or plain assignments', () => {
    const src = [
      "if (metric === 'lpa') convert();",
      "const label = provider === 'drive' ? 'Google Drive' : 'Dropbox';",
      "if (field === 'sex' || field === 'heightCm') drop();", // two literals: two cases
      "if (typeof v === 'string') parse();",
      "if (e.type === 'answered') next();",
      "if (s.phase !== 'idle') return s;", // a union read: the cure
      "const files = state.phase === 'reading' ? state.files : [];",
      "if (document.visibilityState === 'hidden') stage();",
      "const isLpa = metric === 'lpa';", // no branch on this line
      "const lpa = key === 'lpa' ?? fallback;", // ?? is not a ternary
      "const u = id === 'ldl' && row?.unit;", // ?. is not a ternary
      "/* if (x === 'y') z(); */",
    ].join('\n');
    expect(specialCases(src)).toBe(4);
  });
});

describe('fan-in and fan-out (US-64 AC29)', () => {
  it('reads relative imports and counts importers, splitting production files from tests', () => {
    const src = [
      "import { a } from './a';",
      "import type { B } from '../lib/b.js';",
      "export { c } from './c';",
      "import './side-effect';",
      "const d = await import('./d');",
      "import React from 'react';", // a package: not counted
    ].join('\n');
    expect(importsOf(src)).toEqual(['./a', '../lib/b.js', './c', './side-effect', './d']);

    const files = new Set(['src/x/a.ts', 'src/lib/b.ts', 'src/x/c.tsx', 'src/x/d/index.ts']);
    expect(resolveImport('src/x/y.ts', './a', files)).toBe('src/x/a.ts');
    expect(resolveImport('src/x/y.ts', '../lib/b.js', files)).toBe('src/lib/b.ts');
    expect(resolveImport('src/x/y.ts', './c', files)).toBe('src/x/c.tsx');
    expect(resolveImport('src/x/y.ts', './d', files)).toBe('src/x/d/index.ts');
    expect(resolveImport('src/x/y.ts', './missing', files)).toBeNull();

    const map = new Map([
      ['src/x/a.ts', ['src/lib/b.ts']],
      ['src/x/y.ts', ['src/x/a.ts', 'src/lib/b.ts']],
      ['src/x/a.test.ts', ['src/x/a.ts']],
      ['src/lib/b.ts', []],
    ]);
    expect(fanInOut('src/x/a.ts', map)).toEqual({ fanIn: 1, testsIn: 1, fanOut: 1 });
    expect(fanInOut('src/lib/b.ts', map)).toEqual({ fanIn: 2, testsIn: 0, fanOut: 0 });
  });

  it('treats tests, specs and declaration files as non-production', () => {
    expect(isProductionFile('widget-src/src/hooks/useTabs.ts')).toBe(true);
    expect(isProductionFile('ios/App/Store.swift')).toBe(true);
    expect(isProductionFile('widget-src/src/hooks/useTabs.test.tsx')).toBe(false);
    expect(isProductionFile('ios/AppTests/StoreTests.swift')).toBe(false);
    expect(isProductionFile('types/global.d.ts')).toBe(false);
    expect(isProductionFile('docs/x.md')).toBe(false);
    // One rule: every test file the measures skip is a test for co-change too.
    for (const t of ['a/b.test.ts', 'a/b.spec.tsx', 'a/__tests__/b.ts', 'tests/b.ts', 'ios/AppTests/StoreTests.swift']) {
      expect([t, isTestFile(t), isProductionFile(t)]).toEqual([t, true, false]);
    }
  });
});

describe('coChange (US-64 AC29)', () => {
  const log = ['', 'aaa', 'src/a.ts', 'src/b.ts', '', '\0bbb', 'src/a.ts', 'src/b.ts', 'src/c.ts', '', '\0ccc', 'src/a.ts', ''].join('\n');

  it('parses git log and ranks pairs that touch a target, with each file\'s share', () => {
    const commits = parseGitLog(`\0${log}`);
    expect(commits.map((c: { sha: string }) => c.sha)).toEqual(['aaa', 'bbb', 'ccc']);
    const pairs = coChange(commits, (f: string) => f === 'src/a.ts');
    expect(pairs).toEqual([
      { a: 'src/a.ts', b: 'src/b.ts', count: 2, shareA: 2 / 3, shareB: 1 },
      { a: 'src/a.ts', b: 'src/c.ts', count: 1, shareA: 1 / 3, shareB: 1 },
    ]);
  });

  it('keeps the top pairs per file, so a busy file does not crowd out a quiet one', () => {
    const busy = Array.from({ length: 5 }, (_, i) => ({ sha: `b${i}`, files: ['src/busy.ts', `src/n${i % 4}.ts`] }));
    const commits = [...busy, ...busy, { sha: 'q', files: ['src/quiet.ts', 'src/z.ts'] }];
    const targets = ['src/busy.ts', 'src/quiet.ts'];
    const pairs = coChange(commits, (f: string) => targets.includes(f));
    const per = topPerFile(pairs, targets);
    expect(per['src/busy.ts'].map((p: { b: string; count: number }) => [p.b, p.count])).toEqual([
      ['src/n0.ts', 4],
      ['src/n1.ts', 2],
      ['src/n2.ts', 2],
    ]);
    expect(per['src/quiet.ts']).toEqual([{ a: 'src/quiet.ts', b: 'src/z.ts', count: 1, shareA: 1, shareB: 1 }]);
  });

  it('leaves out stories, lockfiles, built assets, a file with its own tests, sweeps and pairs with no target', () => {
    const commits = [
      {
        sha: '1',
        files: [
          'src/a.ts',
          'src/a.test.ts',
          'src/a.save.test.tsx',
          'docs/user-stories.md',
          'docs/user-stories.html',
          'docs/stories/US-15.md',
          'docs/stories/_constitution.md',
          'docs/reference.md',
          'scripts/file-size-baseline.json',
          'package-lock.json',
          'ios/Package.resolved',
          'extensions/health-tool-widget/assets/health-tool.js',
          'src/b.test.ts',
        ],
      },
      { sha: '2', files: ['src/x.ts', 'src/y.ts'] }, // neither is a target
      { sha: '3', files: ['src/a.ts', ...Array.from({ length: 45 }, (_, i) => `src/sweep${i}.ts`)] },
    ];
    expect(coChange(commits, (f: string) => f === 'src/a.ts')).toEqual([
      { a: 'src/a.ts', b: 'src/b.test.ts', count: 1, shareA: 1, shareB: 1 },
    ]);
  });
});

describe('CLI (US-64 AC29)', () => {
  it('refuses a path outside the repo, a bad date and an unknown option', () => {
    const run = (...args: string[]) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
    const outside = run('/');
    expect(outside.status).toBe(2);
    expect(outside.stderr).toContain('outside the repo');
    expect(() => parseArgs(['tools', '--since', 'HEAD~3'])).toThrow('YYYY-MM-DD');
    expect(() => parseArgs(['tools', '--format=x'])).toThrow('unknown option');
    expect(parseArgs(['tools', '--json', '--since=2026-11-01'])).toEqual({ paths: ['tools'], since: '2026-11-01', json: true });
  });

  it('treats the repo root as holding every file, and a folder as holding only its own', () => {
    expect(insideRepo(ROOT, ROOT)).toBe('');
    expect(inTargets([''])('widget-src/src/a.ts')).toBe(true);
    expect(inTargets(['tools'])('tools/a.mjs')).toBe(true);
    expect(inTargets(['tools'])('toolsmith/a.mjs')).toBe(false);
  });

  it('measures a real file in this repo as one JSON object', () => {
    const out = spawnSync(process.execPath, [SCRIPT, 'tools/agent-channel.mjs', '--json', '--since', '2026-09-01'], { cwd: ROOT, encoding: 'utf8' });
    expect(out.status).toBe(0);
    const r = JSON.parse(out.stdout);
    expect(r.files.map((f: { path: string }) => f.path)).toEqual(['tools/agent-channel.mjs']);
    expect(r.files[0]).toMatchObject({ overCap: false, modeFlags: { total: expect.any(Number) }, specialCases: expect.any(Number) });
    expect(r.files[0].lines).toBeGreaterThan(0);
    expect(r.totals.files).toBe(1);
    // CI clones one commit, so the pairs may be empty there: check the shape.
    // The root-target and pairing rules have their own tests above.
    expect(Array.isArray(r.coChange.perFile['tools/agent-channel.mjs'])).toBe(true);
    expect(Array.isArray(r.coChange.overall)).toBe(true);
    expect(Object.keys(r.legend)).toEqual(expect.arrayContaining(['refFlag', 'boolState', 'timers', 'specialCases', 'coChange', 'fanInOut']));
  });
});
