#!/usr/bin/env node
// Makes the two engine signing keys, once (ios/architecture.md D3, US-25 AC17):
//   node ios/scripts/engine-keygen.mjs
// - daily: into the login Keychain (service health-roadmap-engine-signing,
//   account daily), trusted by no app, so each read asks Brad.
// - cold: the backup, written once to a 0600 file for Brad to move into
//   1Password and then delete. It is never printed.
// Both public keys go into ios/engine/signing-keys.json, which the app pins
// (EngineRelease.swift) and the release script checks against. It refuses to
// run if either key already exists: a new key needs an app update to be trusted.
import { generateKeyPairSync } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fingerprint, KEYCHAIN_SERVICE, publicKeyOf } from './engine-signing.mjs';

const ios = join(dirname(fileURLToPath(import.meta.url)), '..');
const keysFile = join(ios, 'engine/signing-keys.json');
const coldFile = join(homedir(), '.config/health-roadmap/engine-signing-key-COLD-move-to-1password.txt');

function seed() {
  const der = generateKeyPairSync('ed25519').privateKey.export({ format: 'der', type: 'pkcs8' });
  return der.subarray(-32);
}

function keychainHas(account) {
  return spawnSync('security', ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', account], { stdio: 'ignore' }).status === 0;
}

if (existsSync(keysFile)) throw new Error(`${keysFile} exists: the keys are made. Rotating means an app update; see ios/engine-updates.md.`);
if (keychainHas('daily')) throw new Error('The daily key is already in the Keychain. Refusing to replace it.');
if (existsSync(coldFile)) throw new Error(`${coldFile} exists. Refusing to replace it.`);

const daily = seed();
const cold = seed();

// The secret goes to `security` on stdin (its interactive mode), never on a
// command line where other processes could read it.
const added = spawnSync('security', ['-i'], {
  input: `add-generic-password -s ${KEYCHAIN_SERVICE} -a daily -l "Health Roadmap engine signing key (daily)" -T "" -w ${daily.toString('base64')}\n`,
  stdio: ['pipe', 'ignore', 'pipe'],
});
if (added.status !== 0 || !keychainHas('daily')) throw new Error(`Keychain add failed: ${added.stderr}`);

mkdirSync(dirname(coldFile), { recursive: true, mode: 0o700 });
chmodSync(dirname(coldFile), 0o700);
writeFileSync(coldFile, `${cold.toString('base64')}\n`, { mode: 0o600, flag: 'wx' });

const pins = { cold: publicKeyOf(cold).toString('base64'), daily: publicKeyOf(daily).toString('base64') };
writeFileSync(keysFile, JSON.stringify(pins, null, 2) + '\n', { flag: 'wx' });

console.log(`daily key: in the login Keychain (${KEYCHAIN_SERVICE} / daily), public ${pins.daily}, fingerprint ${fingerprint(publicKeyOf(daily))}`);
console.log(`cold key: ${coldFile} (0600). Put it in 1Password, then: rm -P "${coldFile}"`);
console.log(`           public ${pins.cold}, fingerprint ${fingerprint(publicKeyOf(cold))}`);
console.log(`public keys → ${keysFile}; pin them in EngineRelease.swift (EngineBridgeContractTests checks).`);
