// US-25 AC1, test audit C15: checkParity throws, naming the fixture and zone, when the
// bundle and the source disagree. The bundle here is hand-made: it answers the sample
// fixture correctly in both pinned zones and every other fixture wrongly.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parityFixtures } from '../engine/fixtures.mjs';
import { bundleEngine, checkParity } from './build-engine.mjs';

const repo = join(__dirname, '..', '..');
const work = mkdtempSync(join(tmpdir(), 'check-parity-test-'));
afterAll(() => rmSync(work, { recursive: true, force: true }));

// The instant, device and zones checkParity pins (build-engine.mjs). Deliberate pins (PR 1527
// review R3): the fixture order (fixtures.mjs) and Auckland's offset at NOW. If either moves,
// these tests must move with it, on purpose.
const NOW = '2026-10-21T12:30:00.000Z';
const DEVICE = 'ios-parity';
/** Each zone's offset at NOW, as getTimezoneOffset() gives it: Auckland is on NZDT (+13). */
const ZONES = { UTC: 0, 'Pacific/Auckland': -780 };

/** The sample record, written as checkParity writes it, and the source's answer for it in `tz`. */
function sourceAnswer(recordPath: string, tz: string) {
  const out = execFileSync(join(repo, 'node_modules/.bin/tsx'), [join(repo, 'ios/engine/golden.ts'), NOW, DEVICE, 'sample', recordPath], {
    env: { ...process.env, TZ: tz },
  });
  return JSON.parse(out.toString()).sample as { plan: string; sections: string };
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

// TA-C02: checkParity runs one source process and one bundle process per zone. A mismatch in
// any single fixture must still fail, naming that fixture and its zone, and each zone must
// still run under its own TZ. The bundle here is the real one, with one wrong answer planted.
describe('checkParity, one process per zone (TA-C02)', () => {
  const real = join(work, 'real-engine.js');
  const sample = JSON.parse(readFileSync(join(repo, 'docs/examples/health-roadmap.sample.json'), 'utf8'));
  beforeAll(() => bundleEngine(real, 202611130000), 120_000);

  /** The real bundle, except it answers `fixture` wrongly in the zone whose offset at NOW is `offset`. */
  function plantWrong(fixture: string, offset: number) {
    const text = JSON.stringify(parityFixtures(sample)[fixture], null, 2); // as checkParity writes it
    const file = join(work, `planted-${fixture}-${offset}.js`);
    const engine = readFileSync(real, 'utf8').replace(/^var HealthEngine =/m, 'var RealEngine =');
    writeFileSync(file, `${engine}
var HealthEngine = {
  ...RealEngine,
  planJson(text, now, device) {
    if (text === ${JSON.stringify(text)} && new Date(now).getTimezoneOffset() === ${offset}) return '{"planted":true}';
    return RealEngine.planJson(text, now, device);
  },
};
`);
    return file;
  }

  it('each zone runs under its own TZ: the same instant is a different day in each golden', () => {
    const goldens = join(work, 'goldens-real');
    expect(checkParity(real, goldens)).toBe(Object.keys(parityFixtures(sample)).length * 2);
    const today = (zone: string) => JSON.parse(JSON.parse(readFileSync(join(goldens, `sample.${zone}.golden.json`), 'utf8')).plan).today;
    expect(today('utc')).toBe('2026-10-21');
    expect(today('auckland')).toBe('2026-10-22');
  }, 120_000);

  // PR 1550 review R3: pins "one process per zone". checkParity runs in a child Node with the
  // spawn probe (fixtures/spawn-probe.mjs); its own calls are the execFileSync lines.
  it('starts exactly one source and one bundle process per zone, each under that zone\'s TZ', () => {
    const log = join(work, 'parity-spawns.log');
    writeFileSync(log, '');
    const probe = pathToFileURL(join(__dirname, 'fixtures/spawn-probe.mjs')).href;
    const build = pathToFileURL(join(__dirname, 'build-engine.mjs')).href;
    // A file, not -e: build-engine.mjs reads process.argv[1] to tell whether it is the main module.
    const script = join(work, 'probed-parity.mjs');
    writeFileSync(script, `import { checkParity } from ${JSON.stringify(build)};
checkParity(${JSON.stringify(real)}, ${JSON.stringify(join(work, 'goldens-probed'))});
`);
    execFileSync(process.execPath, [script], {
      env: { ...process.env, NODE_OPTIONS: `--import ${probe}`, SPAWN_PROBE_LOG: log },
    });
    const parity = readFileSync(log, 'utf8').split('\n').filter((line) => line.startsWith('execFileSync '));
    const tsx = join(repo, 'node_modules/.bin/tsx');
    expect(parity).toEqual([
      `execFileSync ${tsx} TZ=UTC`,
      `execFileSync ${process.execPath} TZ=UTC`,
      `execFileSync ${tsx} TZ=Pacific/Auckland`,
      `execFileSync ${process.execPath} TZ=Pacific/Auckland`,
    ]);
  }, 120_000);

  it('a wrong answer for the first fixture in one zone fails, naming that fixture and zone', () => {
    expect(() => checkParity(plantWrong('sample', -780), join(work, 'goldens-a'))).toThrow(
      'The bundle and the source disagree on sample in Pacific/Auckland',
    );
  }, 120_000);

  it('a wrong answer for a later fixture in one zone fails, naming that fixture and zone', () => {
    expect(() => checkParity(plantWrong('excluded-value', 0), join(work, 'goldens-b'))).toThrow(
      'The bundle and the source disagree on excluded-value in UTC',
    );
  }, 120_000);
});
