#!/usr/bin/env node
// Builds the engine bundle the iOS app loads, and the parity goldens its tests
// compare against (US-25 AC1). Run before any Xcode build:
//   node ios/scripts/build-engine.mjs
// Outputs are generated, not committed (ios/.gitignore).
//
// Goldens come from the engine's SOURCE (ios/engine/golden.ts under tsx), the
// code the web and CLI run. The bundle is then run in Node on every fixture and
// must match them, so a bundling difference fails here, before any app test.
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parityFixtures } from '../engine/fixtures.mjs';

const ios = join(dirname(fileURLToPath(import.meta.url)), '..');
const repo = join(ios, '..');
const engineOut = join(ios, 'HealthRoadmap/Engine/health-engine.js');
const fixtures = join(ios, 'HealthRoadmapTests/Fixtures');
const tsx = join(repo, 'node_modules/.bin/tsx');

// The instant and device every golden is computed at. EngineParityTests uses the same.
const PINNED_NOW = '2026-10-21T12:30:00.000Z';
const PINNED_DEVICE = 'ios-parity';
// The zones the tests run in (scripts/test.sh). The instant is a different day in each.
const ZONES = { utc: 'UTC', auckland: 'Pacific/Auckland' };

mkdirSync(dirname(engineOut), { recursive: true });
rmSync(fixtures, { recursive: true, force: true });
mkdirSync(fixtures, { recursive: true });

await build({
  entryPoints: [join(ios, 'engine/entry.ts')],
  bundle: true,
  format: 'iife',
  globalName: 'HealthEngine',
  target: 'safari17', // iOS 17's JavaScriptCore (minimum iOS, architecture.md)
  platform: 'neutral',
  mainFields: ['module', 'main'],
  outfile: engineOut,
  legalComments: 'none',
  logLevel: 'warning',
});

const sample = JSON.parse(readFileSync(join(repo, 'docs/examples/health-roadmap.sample.json'), 'utf8'));
copyFileSync(join(repo, 'docs/examples/health-roadmap.sample.json'), join(ios, 'HealthRoadmap/Engine/sample-record.json'));

// The bundle, run in Node the way the app runs it: global HealthEngine, JSON in and out.
const bundleGolden = `
  const vm = require('node:vm');
  const fs = require('node:fs');
  const ctx = vm.createContext({});
  vm.runInContext(fs.readFileSync(process.argv[1], 'utf8'), ctx);
  const [, , record, now, device] = process.argv;
  let result;
  try {
    const plan = ctx.HealthEngine.planJson(fs.readFileSync(record, 'utf8'), now, device);
    result = { plan, error: null, sections: ctx.HealthEngine.sectionsJson(plan) };
  } catch (error) {
    result = { plan: null, error: String(error), sections: null };
  }
  process.stdout.write(JSON.stringify(result));
`;

let count = 0;
for (const [name, record] of Object.entries(parityFixtures(sample))) {
  const recordPath = join(fixtures, `${name}.record.json`);
  writeFileSync(recordPath, JSON.stringify(record, null, 2));
  for (const [zoneName, tz] of Object.entries(ZONES)) {
    const env = { ...process.env, TZ: tz };
    const fromSource = execFileSync(tsx, [join(ios, 'engine/golden.ts'), recordPath, PINNED_NOW, PINNED_DEVICE], { env }).toString();
    const fromBundle = execFileSync(process.execPath, ['-e', bundleGolden, engineOut, recordPath, PINNED_NOW, PINNED_DEVICE], { env }).toString();
    if (fromSource !== fromBundle) {
      throw new Error(`The bundle and the source disagree on ${name} in ${tz}: rebuild, then look at what esbuild changed.`);
    }
    writeFileSync(join(fixtures, `${name}.${zoneName}.golden.json`), fromSource);
    count++;
  }
}

console.log(`engine ${Math.round(readFileSync(engineOut).length / 1024)} KB → ${engineOut}`);
console.log(`${count} goldens from source, bundle matches each → ${fixtures}`);
