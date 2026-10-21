#!/usr/bin/env node
// Builds the engine bundle the iOS app loads, and the parity goldens its tests
// compare against (US-25 AC1). Run before any Xcode build:
//   node ios/scripts/build-engine.mjs
// Outputs are generated, not committed (ios/.gitignore).
//
// Goldens come from the engine's SOURCE (ios/engine/golden.ts under tsx), the
// code the web and CLI run. The bundle is then run in Node on every fixture and
// must match them, so a bundling difference fails here, before any app test.
//
// The bundle is stamped with a version: UTC yyyymmddHHMM of the source commit,
// or ENGINE_VERSION. A sidecar, health-engine.json, tells the app the bundled
// engine's version, bridge and schema without loading it (D3, US-25 AC18).
// release-engine.mjs reuses bundleEngine, bundleFacts and checkParity.
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';
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

/** The bridge id: the first 16 hex digits of the contract file's SHA-256 (D3). */
export function bridgeId() {
  return createHash('sha256').update(readFileSync(join(ios, 'engine/bridge-contract.json'))).digest('hex').slice(0, 16);
}

/** UTC yyyymmddHHMM of the source commit: the bundled engine's version. A
 *  release made later from the same source is newer, never older. */
export function commitVersion() {
  const env = { ...process.env, TZ: 'UTC' };
  const text = execFileSync('git', ['log', '-1', '--format=%cd', '--date=format-local:%Y%m%d%H%M'], { cwd: repo, env }).toString().trim();
  return Number(text);
}

/** Bundles the engine into `outfile`, stamped with `version`. */
export async function bundleEngine(outfile, version) {
  if (!Number.isSafeInteger(version) || version <= 0) throw new Error(`Not an engine version: ${version}`);
  mkdirSync(dirname(outfile), { recursive: true });
  await build({
    entryPoints: [join(ios, 'engine/entry.ts')],
    bundle: true,
    format: 'iife',
    globalName: 'HealthEngine',
    target: 'safari17', // iOS 17's JavaScriptCore (minimum iOS, architecture.md)
    platform: 'neutral',
    mainFields: ['module', 'main'],
    outfile,
    define: { __ENGINE_VERSION__: String(version) },
    legalComments: 'none',
    logLevel: 'warning',
  });
}

/** What a bundle says about itself, read as the app reads it: global HealthEngine. */
export function bundleFacts(bundlePath) {
  const ctx = vm.createContext({});
  vm.runInContext(readFileSync(bundlePath, 'utf8'), ctx);
  return { engineVersion: ctx.HealthEngine.engineVersion, schemaVersion: ctx.HealthEngine.schemaVersion };
}

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

/** Runs every parity fixture through the source and through the bundle, in each
 *  pinned zone, and throws if they differ. Writes the goldens into `goldenDir`. */
export function checkParity(bundlePath, goldenDir) {
  const sample = JSON.parse(readFileSync(join(repo, 'docs/examples/health-roadmap.sample.json'), 'utf8'));
  rmSync(goldenDir, { recursive: true, force: true });
  mkdirSync(goldenDir, { recursive: true });
  let count = 0;
  for (const [name, record] of Object.entries(parityFixtures(sample))) {
    const recordPath = join(goldenDir, `${name}.record.json`);
    writeFileSync(recordPath, JSON.stringify(record, null, 2));
    for (const [zoneName, tz] of Object.entries(ZONES)) {
      const env = { ...process.env, TZ: tz };
      const fromSource = execFileSync(tsx, [join(ios, 'engine/golden.ts'), recordPath, PINNED_NOW, PINNED_DEVICE], { env }).toString();
      const fromBundle = execFileSync(process.execPath, ['-e', bundleGolden, bundlePath, recordPath, PINNED_NOW, PINNED_DEVICE], { env }).toString();
      if (fromSource !== fromBundle) {
        throw new Error(`The bundle and the source disagree on ${name} in ${tz}: rebuild, then look at what esbuild changed.`);
      }
      writeFileSync(join(goldenDir, `${name}.${zoneName}.golden.json`), fromSource);
      count++;
    }
  }
  return count;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const version = process.env.ENGINE_VERSION ? Number(process.env.ENGINE_VERSION) : commitVersion();
  await bundleEngine(engineOut, version);
  const count = checkParity(engineOut, fixtures);
  const facts = bundleFacts(engineOut);
  const sidecar = { bridge: bridgeId(), schemaVersion: facts.schemaVersion, version: facts.engineVersion };
  writeFileSync(join(dirname(engineOut), 'health-engine.json'), JSON.stringify(sidecar) + '\n');
  console.log(`engine ${Math.round(readFileSync(engineOut).length / 1024)} KB, version ${version}, bridge ${sidecar.bridge} → ${engineOut}`);
  console.log(`${count} goldens from source, bundle matches each → ${fixtures}`);
}
