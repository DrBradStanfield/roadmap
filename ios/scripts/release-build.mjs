#!/usr/bin/env node
// Builds an over-the-air engine release, unsigned (ios/architecture.md D3, US-25 AC18).
// Loaded only by release-engine.mjs, after it has checked that no signing key is in the
// environment (review R1, N3): this module runs repo code (esbuild, the parity check
// under tsx), so it must never share a process with a key. sign-engine.mjs, which runs
// no repo code, signs what this wrote. How to release: ios/engine-updates.md.
//
// Writes ios/engine-release/bridge-<id>/:
//   <sha256>.js      the bundle, content-addressed
//   manifest.json    canonical JSON: appId, bridge, channel, format, issuedAt, keyId,
//                    minAppBuild, minVersion, notAfter, schemaVersion, sha256, size, version
//   manifest.sig     written by sign-engine.mjs, not here; a stale one is removed
//
// Options: --key daily|cold|ci (the key that will sign: the manifest's keyId),
// --if-changed, --min-app-build N, --min-version N, --allow-dirty, and for tests
// --out DIR, --keys FILE, --now ISO.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { bridgeId, bundleEngine, bundleFacts, checkParity } from './build-engine.mjs';
import { canonicalManifest } from './engine-signing.mjs';


const ios = join(dirname(fileURLToPath(import.meta.url)), '..');
const repo = join(ios, '..');
const DAY = 24 * 60 * 60 * 1000;

const { values: opts } = parseArgs({
  options: {
    out: { type: 'string', default: join(ios, 'engine-release') },
    keys: { type: 'string', default: join(ios, 'engine/signing-keys.json') },
    key: { type: 'string', default: 'daily' },
    now: { type: 'string' },
    'min-app-build': { type: 'string' },
    'min-version': { type: 'string' },
    'if-changed': { type: 'boolean', default: false },
    'allow-dirty': { type: 'boolean', default: false },
  },
});

/** UTC yyyymmddHHMM: one release a minute at most. */
function minuteVersion(date) {
  const iso = date.toISOString();
  return Number(iso.slice(0, 4) + iso.slice(5, 7) + iso.slice(8, 10) + iso.slice(11, 13) + iso.slice(14, 16));
}

function appId() {
  const project = readFileSync(join(ios, 'HealthRoadmap.xcodeproj/project.pbxproj'), 'utf8');
  const ids = [...project.matchAll(/PRODUCT_BUNDLE_IDENTIFIER = ([\w.]+);/g)].map((m) => m[1]).filter((id) => !/\.(ui)?tests$/.test(id)); // the unit and UI test targets
  if (new Set(ids).size !== 1) throw new Error(`Expected one app bundle id, found ${[...new Set(ids)].join(', ')}`);
  return ids[0];
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

const now = opts.now ? new Date(opts.now) : new Date();
const version = minuteVersion(now);
const bridge = bridgeId();
const dir = join(opts.out, `bridge-${bridge}`);
const last = existsSync(join(dir, 'manifest.json')) ? JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) : null;

// The key id first, so a wrong one fails before a slow build.
const pins = JSON.parse(readFileSync(opts.keys, 'utf8'));
if (!pins[opts.key]) throw new Error(`No pinned public key named ${opts.key} in ${opts.keys}.`);

if (!opts['allow-dirty']) {
  const dirty = execFileSync('git', ['status', '--porcelain', '--', 'packages/health-core', 'ios/engine'], { cwd: repo }).toString().trim();
  if (dirty) throw new Error(`Uncommitted engine source; commit it first (or --allow-dirty):\n${dirty}`);
}
if (last && version <= last.version) {
  throw new Error(`Release ${last.version} exists and this would be ${version}: one release a minute, versions only rise. Wait a minute.`);
}

async function release(work) {
  if (opts['if-changed'] && last) {
    // Built at the last release's version, an unchanged engine is byte-identical.
    await bundleEngine(join(work, 'same.js'), last.version);
    if (sha256(readFileSync(join(work, 'same.js'))) === last.sha256) {
      console.log(`unchanged since release ${last.version}: nothing to release`);
      return;
    }
  }

  const bundlePath = join(work, 'health-engine.js');
  await bundleEngine(bundlePath, version);
  checkParity(bundlePath, join(work, 'goldens'));
  const facts = bundleFacts(bundlePath);
  if (facts.engineVersion !== version) throw new Error('The bundle does not carry its version.');

  const bytes = readFileSync(bundlePath);
  const minVersion = Number(opts['min-version'] ?? last?.minVersion ?? 0);
  if (!Number.isSafeInteger(minVersion) || minVersion > version) throw new Error(`--min-version must be a version at or below ${version}.`);
  if (last && minVersion < last.minVersion) throw new Error(`The floor only rises: the last release set minVersion ${last.minVersion}.`);
  const minAppBuild = Number(opts['min-app-build'] ?? last?.minAppBuild ?? 1);
  if (!Number.isSafeInteger(minAppBuild) || minAppBuild < 1) throw new Error('--min-app-build must be a whole number of at least 1.');

  const issuedAt = new Date(Math.floor(now.getTime() / 60000) * 60000);
  const manifest = canonicalManifest({
    appId: appId(),
    bridge,
    channel: 'production',
    format: 1,
    issuedAt: issuedAt.toISOString().replace('.000Z', 'Z'),
    keyId: opts.key,
    minAppBuild,
    minVersion,
    notAfter: new Date(issuedAt.getTime() + 30 * DAY).toISOString().replace('.000Z', 'Z'),
    schemaVersion: facts.schemaVersion,
    sha256: sha256(bytes),
    size: bytes.length,
    version,
  });

  mkdirSync(dir, { recursive: true });
  const name = `${sha256(bytes)}.js`;
  // The old signature goes first: it would not match the new manifest.
  rmSync(join(dir, 'manifest.sig'), { force: true });
  writeFileSync(join(dir, name), bytes);
  writeFileSync(join(dir, 'manifest.json'), manifest);
  // Keep the previous bundle a while: a phone may hold the old manifest from a cache.
  for (const file of readdirSync(dir)) {
    if (file.endsWith('.js') && file !== name && file !== `${last?.sha256}.js`) rmSync(join(dir, file));
  }

  console.log(`release ${version} (bridge ${bridge}, schema ${facts.schemaVersion}) ${Math.round(bytes.length / 1024)} KB sha256 ${sha256(bytes)}`);
  console.log(`unsigned, for the ${opts.key} key → ${dir}. Next, outside npm: node ios/scripts/sign-engine.mjs${opts.key === 'daily' ? '' : ` --key ${opts.key}`}`);
}

const work = mkdtempSync(join(tmpdir(), 'engine-release-'));
try {
  await release(work);
} finally {
  rmSync(work, { recursive: true, force: true });
}
