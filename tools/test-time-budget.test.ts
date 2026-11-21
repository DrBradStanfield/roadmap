/**
 * tools/test-time-budget.mjs (US-64 AC36): a vitest reporter that writes each file's time and each test's
 * time and timeout, and a CLI that prints the slowest files and warns, never fails, on a file over budget
 * or a test past half its own timeout. Main went red on 2026-11-21 when a property test hit its timeout
 * on a loaded runner; nothing had warned that it ran at three quarters of it.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import TimingReporter, { analyse, formatTable, annotation, main, FILE_BUDGET_MS } from './test-time-budget.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, 'fixtures/test-time-budget/report.json');
const report = () => JSON.parse(readFileSync(FIXTURE, 'utf8'));

describe('analyse (US-64 AC36)', () => {
  it('sorts files slowest first', () => {
    expect(analyse(report()).files.map((f) => f.file)).toEqual([
      'tools/codex-review.test.ts',
      'packages/health-core/src/upload-view.property.test.ts',
      'widget-src/src/widgets/WaistToHeight.test.tsx',
      'packages/health-core/src/record-edits.test.ts',
    ]);
  });

  it('warns on each file over the 40 s budget, and not on one just under it', () => {
    expect(FILE_BUDGET_MS).toBe(40_000);
    const over = analyse(report()).warnings.filter((w) => w.kind === 'file').map((w) => w.file);
    expect(over).toEqual(['tools/codex-review.test.ts', 'packages/health-core/src/upload-view.property.test.ts']);
  });

  it('warns on a test past half its own timeout, naming the time and the timeout', () => {
    const tests = analyse(report()).warnings.filter((w) => w.kind === 'test');
    expect(tests.map((w) => w.file)).toEqual([
      'packages/health-core/src/upload-view.property.test.ts',
      'packages/health-core/src/record-edits.test.ts',
    ]);
    expect(tests[0].message).toContain('45.6 s of its 60.0 s timeout (76%)');
    expect(tests[1].message).toContain('3.0 s of its 5.0 s timeout (60%)');
  });

  it('never warns on a test with no timeout, and takes a budget given to it', () => {
    const w = analyse(report(), { fileBudgetMs: 10, timeoutShare: 0.99 }).warnings;
    expect(w.filter((x) => x.kind === 'file')).toHaveLength(4);
    expect(w.filter((x) => x.kind === 'test')).toHaveLength(0);
  });

  it('reads a missing or empty report as no files', () => {
    expect(analyse(null)).toEqual({ files: [], warnings: [] });
    expect(analyse({})).toEqual({ files: [], warnings: [] });
  });
});

describe('formatTable', () => {
  it('lists the slowest files with their seconds and test count, up to the limit', () => {
    const table = formatTable(analyse(report()).files, 2);
    expect(table.split('\n')).toEqual([
      '| # | File | Time | Tests |',
      '|---|---|---|---|',
      '| 1 | `tools/codex-review.test.ts` | 54.7 s | 1 |',
      '| 2 | `packages/health-core/src/upload-view.property.test.ts` | 45.7 s | 1 |',
    ]);
  });
});

describe('annotation: test names are data, never workflow commands', () => {
  it('escapes %, CR and LF in the message and also : and , in properties', () => {
    const line = annotation({ file: 'a,b:c.test.ts', title: 'x:y', message: 'a 100%\r\n::error::no' });
    expect(line).toBe('::warning file=a%2Cb%3Ac.test.ts,title=x%3Ay::a 100%25%0D%0A::error::no');
    expect(line.split('\n')).toHaveLength(1);
  });
});

describe('main (the CI step)', () => {
  it('prints the table and one warning per finding, writes the job summary, and exits 0', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ttb-'));
    const summary = join(dir, 'summary.md');
    const out: string[] = [];
    const code = main([FIXTURE, 'shard 2/6, UTC'], { GITHUB_STEP_SUMMARY: summary }, (s: string) => out.push(s));
    expect(code).toBe(0);
    const text = out.join('\n');
    expect(text).toContain('| 1 | `tools/codex-review.test.ts` | 54.7 s | 1 |');
    expect(text.match(/^::warning /gm)).toHaveLength(4);
    const md = readFileSync(summary, 'utf8');
    expect(md).toContain('### Test time: shard 2/6, UTC');
    expect(md).toContain('upload-view.property.test.ts');
    expect(md).toContain('4 warnings');
  });

  it('a missing report (the tests never ran) prints a note and still exits 0', () => {
    const out: string[] = [];
    expect(main([join(tmpdir(), 'no-such-report.json'), 'x'], {}, (s: string) => out.push(s))).toBe(0);
    expect(out.join('\n')).toContain('No timing report');
  });
});

describe('the reporter', () => {
  const fakeModule = (file: string, duration: number, tests: [string, number, number | undefined][]) => ({
    relativeModuleId: file,
    diagnostic: () => ({ duration }),
    children: {
      allTests: () => tests.map(([fullName, d, timeout]) => ({
        fullName, options: { timeout }, diagnostic: () => (d < 0 ? undefined : { duration: d }),
      })),
    },
  });

  it('writes each file and test, with timeouts, to its outputFile under the root', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ttb-rep-'));
    const r = new TimingReporter({ outputFile: 'out/timing.json' });
    r.onInit({ config: { root: dir } });
    await r.onTestRunEnd([fakeModule('a.test.ts', 1234, [['a > one', 1000, 60000], ['a > skipped', -1, 60000]])]);
    const file = join(dir, 'out/timing.json');
    expect(existsSync(file)).toBe(true);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({
      files: [{ file: 'a.test.ts', durationMs: 1234, tests: [
        { name: 'a > one', durationMs: 1000, timeoutMs: 60000 },
        { name: 'a > skipped', durationMs: 0, timeoutMs: 60000 },
      ] }],
    });
  });
});
