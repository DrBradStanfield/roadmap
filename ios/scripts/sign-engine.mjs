#!/usr/bin/env node
// Signs a built engine release (ios/architecture.md D3, US-25 AC18, review R1, N4):
//   node ios/scripts/sign-engine.mjs        the daily key (macOS asks to allow the Keychain read)
//   ENGINE_SIGNING_KEY='<line>' node ios/scripts/sign-engine.mjs --key cold
// Run it directly, never through `npm run`: npm runs lifecycle scripts and puts the
// repo's node_modules/.bin first on PATH. The Keychain tool is called by absolute path.
// Step 2 of 2, after release-engine.mjs. It runs no repo code: it imports only Node's
// own modules and engine-signing.mjs, reads the manifest and bundle from disk, checks
// them, and signs. The key is never in a process that ran esbuild, tsx or a test.
// A signature means only that the key holder approved this bundle.
//
// Options: --key daily|cold|ci, and for tests --out DIR, --keys FILE.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { canonicalManifest, fingerprint, publicKeyOf, readSigningKey, signManifest, verifyManifest } from './engine-signing.mjs';

const ios = join(dirname(fileURLToPath(import.meta.url)), '..');
const { values: opts } = parseArgs({
  options: {
    key: { type: 'string', default: 'daily' },
    out: { type: 'string', default: join(ios, 'engine-release') },
    keys: { type: 'string', default: join(ios, 'engine/signing-keys.json') },
  },
});

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
// The bridge this source declares: the contract file's hash, read as data.
const bridge = sha256(readFileSync(join(ios, 'engine/bridge-contract.json'))).slice(0, 16);
const dir = join(opts.out, `bridge-${bridge}`);
const manifestPath = join(dir, 'manifest.json');
if (!existsSync(manifestPath)) throw new Error(`No built release for bridge ${bridge}: run npm run engine:build first.`);

const bytes = readFileSync(manifestPath);
const manifest = JSON.parse(bytes.toString());
if (!canonicalManifest(manifest).equals(bytes)) throw new Error('manifest.json is not in canonical form: rebuild it.');
if (manifest.bridge !== bridge) throw new Error(`manifest.json is for bridge ${manifest.bridge}, not ${bridge}.`);
if (manifest.keyId !== opts.key) throw new Error(`manifest.json names the ${manifest.keyId} key; sign it with --key ${manifest.keyId}, or rebuild.`);
const bundle = readFileSync(join(dir, `${manifest.sha256}.js`));
if (sha256(bundle) !== manifest.sha256 || bundle.length !== manifest.size) throw new Error('The bundle does not match manifest.json.');

const pins = JSON.parse(readFileSync(opts.keys, 'utf8'));
const pinned = pins[opts.key] && Buffer.from(pins[opts.key], 'base64');
if (!pinned) throw new Error(`No pinned public key named ${opts.key}.`);
const sigPath = join(dir, 'manifest.sig');
if (existsSync(sigPath) && verifyManifest(bytes, Buffer.from(readFileSync(sigPath, 'utf8').trim(), 'base64'), pinned)) {
  console.log(`release ${manifest.version} is already signed: nothing to do`);
  process.exit(0);
}

const seed = readSigningKey(opts.key);
if (!publicKeyOf(seed).equals(pinned)) throw new Error(`That key is not the pinned ${opts.key} key: the app would refuse its signature.`);
const signature = signManifest(bytes, seed);
if (!verifyManifest(bytes, signature, pinned)) throw new Error('The signature does not verify.');
writeFileSync(sigPath, signature.toString('base64') + '\n');
console.log(`signed release ${manifest.version} (bridge ${bridge}, sha256 ${manifest.sha256}) with ${opts.key} (${fingerprint(pinned)})`);
