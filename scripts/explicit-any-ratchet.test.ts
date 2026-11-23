// US-64 AC39: app and test TypeScript add no explicit `any`; a file's count can only fall.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { WRITE_CMD, anyCounts, countExplicitAny, fresh, grown, isScanned, loose, readBaseline, scannedFiles } from './explicit-any-baseline.mjs';
import { ROOT } from './file-size-baseline.mjs';

// The named exceptions. A new one is a change to this list.
const ALLOWED_EXCEPTIONS = ['packages/health-core/src/sentry-scrub-server.ts'];

const baseline: { exceptions: Record<string, string>; files: Record<string, number> } = readBaseline();
const now: Record<string, number> = anyCounts();

describe('explicit-any ratchet (US-64 AC39)', () => {
  it('no baseline file has more explicit any than recorded: remove one, never add one', () => {
    expect(grown(baseline.files, now), grown(baseline.files, now).join('\n')).toEqual([]);
  });

  it('no file outside the baseline has an explicit any', () => {
    expect(fresh(baseline.files, now), fresh(baseline.files, now).join('\n')).toEqual([]);
  });

  it('every baseline entry is still a file at its recorded count: a fall needs the baseline rewritten', () => {
    expect(loose(baseline.files, now), loose(baseline.files, now).join('\n')).toEqual([]);
  });

  it('scans .ts, .tsx, .mts and .cts (.d.mts included), not .mjs/.js; an .mts snippet counts `as any`', () => {
    expect(['a.ts', 'a.tsx', 'a.mts', 'a.cts', 'a.d.mts', 'a.mjs', 'a.js', 'a.json'].filter(isScanned)).toEqual(['a.ts', 'a.tsx', 'a.mts', 'a.cts', 'a.d.mts']);
    expect(scannedFiles()).toEqual(expect.arrayContaining(['instrument-self-report.d.mts', 'ios/scripts/app-store-video-lab-server.mts']));
    expect(countExplicitAny('const x = y as any;', 'snippet.mts')).toBe(1);
  });

  it('the growth checks on a made-up baseline: a rise and a new file fail; a fall, a clear and a removed file pass them', () => {
    expect(grown({ 'a.ts': 2, 'b.ts': 1, 'c.ts': 1 }, { 'a.ts': 3, 'b.ts': 1 })).toEqual([
      'a.ts: recorded 2 explicit any, now 3. Give it a real type or unknown.',
    ]);
    expect(grown({ 'a.ts': 2 }, { 'a.ts': 1 })).toEqual([]);
    expect(fresh({ 'a.ts': 1 }, { 'a.ts': 1, 'new.tsx': 1 })).toEqual(['new.tsx: 1 explicit any and not in the baseline. Give it a real type or unknown.']);
    expect(fresh({ 'a.ts': 1 }, {})).toEqual([]);
  });

  it('the stale check on a made-up baseline: a lowered file and a deleted file fail until rewritten; equal passes', () => {
    const on = (f: string) => f !== 'gone.ts';
    expect(loose({ 'a.ts': 2, 'b.ts': 1 }, { 'a.ts': 1, 'b.ts': 1 }, on)).toEqual([
      `a.ts: recorded 2 explicit any, now 1. Lower the entry: run \`${WRITE_CMD}\`.`,
    ]);
    expect(loose({ 'a.ts': 1 }, { 'a.ts': 1 }, on)).toEqual([]);
    expect(loose({ 'gone.ts': 1 }, {}, on)).toEqual([`gone.ts: no longer exists. Delete its entry: run \`${WRITE_CMD}\`.`]);
    expect(loose({ 'a.ts': 3 }, {}, on)).toEqual([`a.ts: now 0 explicit any. Delete its entry: run \`${WRITE_CMD}\`.`]);
    // After the rewrite drops a.ts, an any that comes back is outside the baseline and fails.
    expect(fresh({}, { 'a.ts': 1 })).toEqual(['a.ts: 1 explicit any and not in the baseline. Give it a real type or unknown.']);
    // The exception's entry gets the same check.
    expect(loose({ [ALLOWED_EXCEPTIONS[0]]: 1 }, {}, on)).toEqual([
      `${ALLOWED_EXCEPTIONS[0]}: now 0 explicit any. Delete its entry: run \`${WRITE_CMD}\`.`,
    ]);
  });

  it('every exception is on the fixed list, in files, exists and gives a reason; the scrubber keeps its alias', () => {
    expect(Object.keys(baseline.exceptions)).toEqual(ALLOWED_EXCEPTIONS);
    for (const [f, why] of Object.entries(baseline.exceptions)) {
      expect(f in baseline.files, `${f} is an exception with no count in files: if its any is gone, delete the exception too`).toBe(true);
      expect(existsSync(join(ROOT, f)), `${f} is an exception but missing: delete the entry`).toBe(true);
      expect(typeof why === 'string' && why.length > 10, `${f}: the exception needs a one-line reason`).toBe(true);
    }
    // The scrubber's one alias, as its own comment explains it, recorded at 1.
    expect(baseline.files[ALLOWED_EXCEPTIONS[0]]).toBe(1);
    expect(readFileSync(join(ROOT, ALLOWED_EXCEPTIONS[0]), 'utf8')).toContain('type Loose = any;');
  });

  describe('the counter', () => {
    const counts: Array<[string, string, number]> = [
      ['a `: any` annotation', 'let a: any = 1;', 1],
      ['`as any`', 'const b = (x as any).y;', 1],
      ['`any[]`', 'let c: any[] = [];', 1],
      ['`Array<any>`', 'let d: Array<any> = [];', 1],
      ['`Record<string, any>`', 'let e: Record<string, any> = {};', 1],
      ['`Promise<any>`', 'async function f(): Promise<any> { return 1; }', 1],
      ['`<any>value` in a .ts file', 'const g = <any>value;', 1],
      ['a `type X = any` alias once, not at its uses', 'type X = any; let i: X; let j: X[];', 1],
      ['`// any`', '// any\nlet k = 1;', 0],
      ['`/* any */`', '/* any */ let l = 1;', 0],
      ["`'any'`", "const m = 'any';", 0],
      ['a template string holding any', 'const n = `any ${1} any`;', 0],
      ['an identifier named any', 'let any = false; any = true;', 0],
      ['`.any(`', 'const o = p.any(q);', 0],
      ['`unknown`', 'let r: unknown = 1;', 0],
    ];
    for (const [name, source, n] of counts) {
      it(`counts ${n} for ${name}`, () => expect(countExplicitAny(source, 'snippet.ts')).toBe(n));
    }

    it('parses .tsx by its extension: `<any>` is a JSX tag there, a cast in .ts', () => {
      expect(countExplicitAny('const s = <any>h</any>;', 'snippet.tsx')).toBe(0);
      expect(countExplicitAny('const s = <any>h</any>;', 'snippet.ts')).toBe(1);
      expect(countExplicitAny('const s = <div title="any">{(t as any).u}</div>;', 'snippet.tsx')).toBe(1);
    });
  });
});
