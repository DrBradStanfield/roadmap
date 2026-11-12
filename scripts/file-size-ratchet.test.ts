// US-64 AC23: a production file over 500 lines never grows (Brad 2026-11-09, CLAUDE.md "File budgets").
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LIMIT, REGEN_CMD, ROOT, generatedFiles, lineCount, overLimit, readBaseline } from './file-size-baseline.mjs';

// Data tables only. A new exemption is a change to this list.
const ALLOWED_EXEMPT = ['packages/health-core/src/evidence.ts', 'packages/health-core/src/mcp-tool-catalogue.ts'];
// Generated files, exempt by their first-line GENERATED marker. Each has a
// freshness test that fails when it is not what its generator writes.
const GENERATED_FILES: Record<string, string> = { 'instrument-scrub.mjs': 'tools/generate-instrument-scrub.test.ts' };

const baseline: { exempt: Record<string, string>; files: Record<string, number> } = readBaseline();
const now: Record<string, number> = overLimit(baseline.exempt);

describe('file-size ratchet (US-64 AC23)', () => {
  it('no baseline file has grown: split it first', () => {
    const grown = Object.entries(baseline.files)
      .filter(([f, recorded]) => existsSync(join(ROOT, f)) && lineCount(f) > recorded)
      .map(([f, recorded]) => `${f}: recorded ${recorded}, now ${lineCount(f)}. Split it first, then it can only shrink.`);
    expect(grown, grown.join('\n')).toEqual([]);
  });

  it(`no file outside the baseline is over ${LIMIT} lines`, () => {
    const fresh = Object.entries(now)
      .filter(([f]) => !(f in baseline.files))
      .map(([f, n]) => `${f}: ${n} lines, over ${LIMIT} and not in the baseline. Split it first.`);
    expect(fresh, fresh.join('\n')).toEqual([]);
  });

  it('every baseline entry is still a file over the limit', () => {
    const stale = Object.keys(baseline.files)
      .filter((f) => !(f in now))
      .map(
        (f) =>
          `${f}: ${existsSync(join(ROOT, f)) ? `now ${lineCount(f)} lines, at or under ${LIMIT}` : 'no longer exists'}. ` +
          `Lower or delete its entry: run \`${REGEN_CMD}\`.`,
      );
    const loose = Object.entries(baseline.files)
      .filter(([f, recorded]) => f in now && now[f] < recorded)
      .map(([f, recorded]) => `${f}: recorded ${recorded}, now ${now[f]}. Lower the entry: run \`${REGEN_CMD}\`.`);
    expect([...stale, ...loose], [...stale, ...loose].join('\n')).toEqual([]);
  });

  it('every exempt file is on the fixed list, exists and gives a reason', () => {
    for (const [f, why] of Object.entries(baseline.exempt)) {
      expect(ALLOWED_EXEMPT, `${f} is exempt but not on ALLOWED_EXEMPT in this test: adding an exemption means editing the list here, where review sees it`).toContain(f);
      expect(existsSync(join(ROOT, f)), `${f} is exempt but missing: delete the entry`).toBe(true);
      expect(typeof why === 'string' && why.length > 10, `${f}: the exempt entry needs a one-line reason`).toBe(true);
    }
  });

  it('only the fixed list carries the GENERATED marker, and each has a freshness test (US-09 AC7j)', () => {
    expect(generatedFiles()).toEqual(Object.keys(GENERATED_FILES));
    for (const [f, test] of Object.entries(GENERATED_FILES)) {
      expect(existsSync(join(ROOT, test)), `${f}: its freshness test ${test} is missing`).toBe(true);
      expect(f in now, `${f} is generated, so the ratchet skips it`).toBe(false);
    }
  });
});
