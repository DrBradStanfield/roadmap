// US-25 AC1, test audit C15: checkParity throws, naming the fixture and zone, when the
// bundle and the source disagree. The bundle here is hand-made: it answers the sample
// fixture correctly in both pinned zones and every other fixture wrongly.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { checkParity } from './build-engine.mjs';

const repo = join(__dirname, '..', '..');
const work = mkdtempSync(join(tmpdir(), 'check-parity-test-'));
afterAll(() => rmSync(work, { recursive: true, force: true }));

// The instant, device and zones checkParity pins (build-engine.mjs).
const NOW = '2026-10-21T12:30:00.000Z';
const DEVICE = 'ios-parity';
/** Each zone's offset at NOW, as getTimezoneOffset() gives it: Auckland is on NZDT (+13). */
const ZONES = { UTC: 0, 'Pacific/Auckland': -780 };

/** The sample record, written as checkParity writes it, and the source's answer for it in `tz`. */
function sourceAnswer(recordPath: string, tz: string) {
  const out = execFileSync(join(repo, 'node_modules/.bin/tsx'), [join(repo, 'ios/engine/golden.ts'), recordPath, NOW, DEVICE], {
    env: { ...process.env, TZ: tz },
  });
  return JSON.parse(out.toString()) as { plan: string; sections: string };
}

describe('checkParity (US-25 AC1)', () => {
  it('throws on the first fixture the bundle gets wrong, naming it and its zone', () => {
    const sample = JSON.parse(readFileSync(join(repo, 'docs/examples/health-roadmap.sample.json'), 'utf8'));
    const sampleText = JSON.stringify(sample, null, 2);
    const recordPath = join(work, 'sample.record.json');
    writeFileSync(recordPath, sampleText);
    const answers: Record<number, { plan: string; sections: string }> = {};
    for (const [tz, offset] of Object.entries(ZONES)) answers[offset] = sourceAnswer(recordPath, tz);

    const bundle = join(work, 'health-engine.js');
    writeFileSync(bundle, `var HealthEngine = (() => {
  const sample = ${JSON.stringify(sampleText)};
  const answers = ${JSON.stringify(answers)};
  return {
    planJson(text, now, device) {
      const answer = answers[new Date(now).getTimezoneOffset()];
      return text === sample && answer && device === ${JSON.stringify(DEVICE)} ? answer.plan : 'wrong';
    },
    sectionsJson(plan) {
      const answer = Object.values(answers).find((a) => a.plan === plan);
      return answer ? answer.sections : 'wrong';
    },
  };
})();
`);

    // Sample passes in UTC and Auckland; urgent-corrected, the next fixture, fails in UTC.
    expect(() => checkParity(bundle, join(work, 'goldens'))).toThrow('The bundle and the source disagree on urgent-corrected in UTC');
    // The sample's goldens were written before the throw: it matched in both zones.
    expect(JSON.parse(readFileSync(join(work, 'goldens/sample.utc.golden.json'), 'utf8'))).toEqual({ ...answers[0], error: null });
    expect(JSON.parse(readFileSync(join(work, 'goldens/sample.auckland.golden.json'), 'utf8'))).toEqual({ ...answers[-780], error: null });
  }, 120_000);
});
