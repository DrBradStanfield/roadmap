#!/usr/bin/env node
// Makes the engine signing keys (ios/architecture.md D3, US-25 AC18):
//   node ios/scripts/engine-keygen.mjs            the daily and cold keys, once
//   node ios/scripts/engine-keygen.mjs --add ci   one more key, for a GitHub secret
// - daily: into the login Keychain (service health-roadmap-engine-signing,
//   account daily), trusted by no app, so each read asks Brad.
// - cold: the backup, written once to a 0600 file for Brad to move into
//   1Password and then delete.
// - ci: written once to a 0600 file for Brad to paste into the engine-signing
//   environment's secret on GitHub and then delete.
// No private key is ever printed. Public keys go into ios/engine/signing-keys.json,
// which the app pins (EngineRelease.swift) and the release script checks against.
// It refuses to replace any key: a new key needs an app update to be trusted.
import { generateKeyPairSync } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { fingerprint, KEYCHAIN_SERVICE, publicKeyOf } from './engine-signing.mjs';

const ios = join(dirname(fileURLToPath(import.meta.url)), '..');
const keysFile = join(ios, 'engine/signing-keys.json');
const folder = join(homedir(), '.config/health-roadmap');
/** Where a file-held key waits for Brad, by id. */
const FILE_KEYS = {
  cold: join(folder, 'engine-signing-key-COLD-move-to-1password.txt'),
  ci: join(folder, 'engine-signing-key-CI-move-to-github-secret.txt'),
};

function seed() {
  const der = generateKeyPairSync('ed25519').privateKey.export({ format: 'der', type: 'pkcs8' });
  return der.subarray(-32);
}

function keychainHas(account) {
  return spawnSync('security', ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', account], { stdio: 'ignore' }).status === 0;
}

/** Writes a file-held key once, 0600 in a 0700 folder. */
function writeFileKey(id, key) {
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  chmodSync(folder, 0o700);
  writeFileSync(FILE_KEYS[id], `${key.toString('base64')}\n`, { mode: 0o600, flag: 'wx' });
}

function report(id, key, where) {
  console.log(`${id} key: ${where}; public ${publicKeyOf(key).toString('base64')}, fingerprint ${fingerprint(publicKeyOf(key))}`);
}

const { values: opts } = parseArgs({ options: { add: { type: 'string' } } });

if (opts.add) {
  const id = opts.add;
  if (!FILE_KEYS[id]) throw new Error(`--add takes one of: ${Object.keys(FILE_KEYS).join(', ')}`);
  const pins = JSON.parse(readFileSync(keysFile, 'utf8'));
  if (pins[id]) throw new Error(`A ${id} key is already pinned. Refusing to replace it.`);
  if (existsSync(FILE_KEYS[id])) throw new Error(`${FILE_KEYS[id]} exists. Refusing to replace it.`);
  const key = seed();
  writeFileKey(id, key);
  pins[id] = publicKeyOf(key).toString('base64');
  writeFileSync(keysFile, JSON.stringify(Object.fromEntries(Object.entries(pins).sort()), null, 2) + '\n');
  report(id, key, `${FILE_KEYS[id]} (0600)`);
  console.log(`public key added to ${keysFile}; pin it in EngineRelease.swift (EngineBridgeContractTests checks).`);
} else {
  if (existsSync(keysFile)) throw new Error(`${keysFile} exists: the keys are made. Rotating means an app update; see ios/engine-updates.md.`);
  if (keychainHas('daily')) throw new Error('The daily key is already in the Keychain. Refusing to replace it.');
  if (existsSync(FILE_KEYS.cold)) throw new Error(`${FILE_KEYS.cold} exists. Refusing to replace it.`);

  const daily = seed();
  const cold = seed();
  // The secret goes to `security` on stdin (its interactive mode), never on a
  // command line where other processes could read it.
  const added = spawnSync('security', ['-i'], {
    input: `add-generic-password -s ${KEYCHAIN_SERVICE} -a daily -l "Health Roadmap engine signing key (daily)" -T "" -w ${daily.toString('base64')}\n`,
    stdio: ['pipe', 'ignore', 'pipe'],
  });
  if (added.status !== 0 || !keychainHas('daily')) throw new Error(`Keychain add failed: ${added.stderr}`);
  writeFileKey('cold', cold);

  const pins = { cold: publicKeyOf(cold).toString('base64'), daily: publicKeyOf(daily).toString('base64') };
  writeFileSync(keysFile, JSON.stringify(pins, null, 2) + '\n', { flag: 'wx' });
  report('daily', daily, `in the login Keychain (${KEYCHAIN_SERVICE} / daily)`);
  report('cold', cold, `${FILE_KEYS.cold} (0600). Put it in 1Password, then rm -P it`);
  console.log(`public keys → ${keysFile}; pin them in EngineRelease.swift (EngineBridgeContractTests checks).`);
}
