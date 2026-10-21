#!/usr/bin/env node
// Makes a signed over-the-air engine release (ios/architecture.md D3, US-25 AC18):
//   npm run engine:release            (signs with the daily key; macOS asks to allow the Keychain read)
//   npm run engine:release -- --if-changed
// Then commit ios/engine-release/ and push to main: installed apps fetch it from
// raw.githubusercontent.com. How to release, back up the key and run it from CI:
// ios/engine-updates.md.
//
// Writes ios/engine-release/bridge-<id>/:
//   <sha256>.js      the bundle, content-addressed
//   manifest.json    canonical JSON: appId, bridge, channel, format, issuedAt, keyId,
//                    minAppBuild, minVersion, notAfter, schemaVersion, sha256, size, version
//   manifest.sig     base64 Ed25519 over "health-roadmap-engine-manifest/v1\n" + manifest bytes
// A signature means only that the key holder approved this bundle.
//
// Options: --key daily|cold, --if-changed, --no-sign (CI's build job), --min-app-build N,
// --min-version N, --allow-dirty, and for tests --out DIR, --keys FILE, --now ISO.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { bridgeId, bundleEngine, bundleFacts, checkParity } from './build-engine.mjs';
import { canonicalManifest, fingerprint, publicKeyOf, readSigningKey, signManifest } from './engine-signing.mjs';

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
    'no-sign': { type: 'boolean', default: false },
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
  const ids = [...project.matchAll(/PRODUCT_BUNDLE_IDENTIFIER = ([\w.]+);/g)].map((m) => m[1]).filter((id) => !id.endsWith('.tests'));
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

// The key first, so a wrong key fails before a slow build.
const pins = JSON.parse(readFileSync(opts.keys, 'utf8'));
if (!pins[opts.key]) throw new Error(`No pinned public key named ${opts.key} in ${opts.keys}.`);
let seed = null;
if (!opts['no-sign']) {
  seed = readSigningKey(opts.key);
  if (publicKeyOf(seed).toString('base64') !== pins[opts.key]) {
    throw new Error(`That key is not the pinned ${opts.key} key: the app would refuse its signature.`);
  }
}

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
  writeFileSync(join(dir, name), bytes);
  writeFileSync(join(dir, 'manifest.json'), manifest);
  if (seed) writeFileSync(join(dir, 'manifest.sig'), signManifest(manifest, seed).toString('base64') + '\n');
  else rmSync(join(dir, 'manifest.sig'), { force: true });
  // Keep the previous bundle a while: a phone may hold the old manifest from a cache.
  for (const file of readdirSync(dir)) {
    if (file.endsWith('.js') && file !== name && file !== `${last?.sha256}.js`) rmSync(join(dir, file));
  }

  console.log(`release ${version} (bridge ${bridge}, schema ${facts.schemaVersion}) ${Math.round(bytes.length / 1024)} KB sha256 ${sha256(bytes)}`);
  console.log(seed ? `signed with ${opts.key} (${fingerprint(publicKeyOf(seed))}) → ${dir}` : `NOT signed (--no-sign) → ${dir}`);
}

const work = mkdtempSync(join(tmpdir(), 'engine-release-'));
try {
  await release(work);
} finally {
  rmSync(work, { recursive: true, force: true });
}
