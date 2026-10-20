#!/usr/bin/env node
// Builds the engine bundle the iOS app loads, and the parity goldens its tests
// compare against (US-25 AC1). Run before any Xcode build:
//   node ios/scripts/build-engine.mjs
// Outputs are generated, not committed (ios/.gitignore).
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ios = join(dirname(fileURLToPath(import.meta.url)), '..');
const repo = join(ios, '..');
const engineOut = join(ios, 'HealthRoadmap/Engine/health-engine.js');
const recordOut = join(ios, 'HealthRoadmap/Engine/sample-record.json');
const fixtures = join(ios, 'HealthRoadmapTests/Fixtures');

// The instant and device every golden is computed at. The Swift test uses the same.
export const PINNED_NOW = '2026-10-21T12:30:00.000Z';
export const PINNED_DEVICE = 'ios-parity';
const ZONES = { utc: 'UTC', auckland: 'Pacific/Auckland' };

mkdirSync(dirname(engineOut), { recursive: true });
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

copyFileSync(join(repo, 'docs/examples/health-roadmap.sample.json'), recordOut);
copyFileSync(recordOut, join(fixtures, 'sample-record.json'));

// Goldens come from the SAME bundle, run in Node, once per time zone: the
// app must match them byte for byte.
const runner = `
  const vm = require('node:vm');
  const fs = require('node:fs');
  const ctx = vm.createContext({});
  vm.runInContext(fs.readFileSync(${JSON.stringify(engineOut)}, 'utf8'), ctx);
  const record = fs.readFileSync(${JSON.stringify(recordOut)}, 'utf8');
  process.stdout.write(ctx.HealthEngine.planJson(record, ${JSON.stringify(PINNED_NOW)}, ${JSON.stringify(PINNED_DEVICE)}));
`;
for (const [name, tz] of Object.entries(ZONES)) {
  const out = execFileSync(process.execPath, ['-e', runner], { env: { ...process.env, TZ: tz } });
  writeFileSync(join(fixtures, `plan-${name}.json`), out);
}

const size = readFileSync(engineOut).length;
console.log(`engine ${Math.round(size / 1024)} KB → ${engineOut}`);
console.log(`goldens (${Object.keys(ZONES).join(', ')}) → ${fixtures}`);
