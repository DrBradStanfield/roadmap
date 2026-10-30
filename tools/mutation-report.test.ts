import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { analyse, newSurvivors, buildBaseline, main } from './mutation-report.mjs';

const SOURCE = ['export function bmi(w, h) {', '  return w / (h * h);', '}', 'export const tier = (x) => {', '  return x > 5 ? 1 : 2;', '};'].join('\n');
const mut = (id: number, status: string, mutatorName: string, replacement: string, line: number, c0: number, c1: number) => ({
  id: String(id), status, mutatorName, replacement, location: { start: { line, column: c0 }, end: { line, column: c1 } },
});
const report = (extra: unknown[] = []) => ({
  files: {
    'src/x.ts': {
      language: 'typescript',
      source: SOURCE,
      mutants: [
        mut(1, 'Killed', 'ArithmeticOperator', 'w * (h * h)', 2, 10, 21),
        mut(2, 'Survived', 'ArithmeticOperator', 'w + (h * h)', 2, 10, 21),
        mut(3, 'NoCoverage', 'EqualityOperator', 'x >= 5', 5, 10, 15),
        mut(4, 'Timeout', 'BooleanLiteral', 'false', 5, 10, 15),
        ...(extra as never[]),
      ],
    },
  },
});

describe('US-48 AC7: mutation-report', () => {
  it('scores per file and keys open mutants by text and enclosing declaration', () => {
    const { scores, open } = analyse(report());
    expect(scores[0].score).toBeCloseTo(50);
    expect(open.map((o) => [o.fn, o.original, o.replacement])).toEqual([
      ['bmi', 'w / (h * h)', 'w + (h * h)'],
      ['tier', 'x > 5', 'x >= 5'],
    ]);
  });

  it('ignores line drift: the same mutant moved down is not new', () => {
    const base = buildBaseline(analyse(report()).open);
    const shifted = report();
    shifted.files['src/x.ts'].source = '// header\n' + SOURCE;
    for (const m of shifted.files['src/x.ts'].mutants) m.location = { start: { ...m.location.start, line: m.location.start.line + 1 }, end: { ...m.location.end, line: m.location.end.line + 1 } };
    expect(newSurvivors(analyse(shifted).open, base)).toEqual([]);
  });

  it('flags a new survivor and a second copy of a baselined key', () => {
    const base = buildBaseline(analyse(report()).open);
    const more = report([mut(5, 'Survived', 'ArithmeticOperator', 'w + (h * h)', 2, 10, 21), mut(6, 'Survived', 'BooleanLiteral', 'true', 5, 10, 15)]);
    expect(newSurvivors(analyse(more).open, base)).toHaveLength(2);
  });

  it('main exits 1 only on new survivors and --update-baseline rewrites the baseline', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mut-'));
    const rp = join(dir, 'r.json');
    const bp = join(dir, 'b.json');
    writeFileSync(rp, JSON.stringify(report()));
    const quiet = { log: () => {}, err: () => {} };
    expect(main([rp, bp], quiet)).toBe(1); // no baseline yet
    expect(main([rp, bp, '--update-baseline'], quiet)).toBe(0);
    expect(JSON.parse(readFileSync(bp, 'utf8'))).toHaveLength(2);
    expect(main([rp, bp], quiet)).toBe(0);
    writeFileSync(rp, JSON.stringify(report([mut(9, 'Survived', 'BooleanLiteral', 'true', 5, 10, 15)])));
    expect(main([rp, bp], quiet)).toBe(1);
  });
});
